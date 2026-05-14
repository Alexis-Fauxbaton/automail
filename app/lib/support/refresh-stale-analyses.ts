// Refresh "to handle" thread analyses that haven't been recomputed in a while.
//
// Used by mail sync to make sure tracking / Shopify data shown to the merchant
// is refreshed when it is older than ~24h, even when the merchant doesn't click
// anything. Also called on-demand right before a draft regeneration /
// refinement with a stricter ~1h threshold.
//
// Multi-tenant: every query is scoped by `shop`. One shop's failures must
// never stall another shop.

import prisma from "../../db.server";
import { refreshThreadAnalysis } from "./refresh-thread-analysis";
import type { AdminGraphqlClient } from "./shopify/order-search";
import type { SupportAnalysis } from "./types";

const FIVE_MIN_MS = 5 * 60_000;
const TEN_MIN_MS = 10 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

/**
 * Returns true if the email's last analysis is older than `maxAgeMs`
 * (or has never been analyzed).
 */
export function isAnalysisStale(
  lastAnalyzedAt: Date | null,
  maxAgeMs: number,
): boolean {
  if (!lastAnalyzedAt) return true;
  return Date.now() - lastAnalyzedAt.getTime() > maxAgeMs;
}

export const ANALYSIS_FRESHNESS_MS = {
  /** Refresh before a draft refinement if analysis is older than 10 minutes. */
  draftTrigger: TEN_MIN_MS,
  /** Background auto-refresh for active "to handle" threads every hour. */
  autoRefresh: ONE_HOUR_MS,
  /** Fast retry when the previous 17track attempt errored. */
  fast17trackRetry: TEN_MIN_MS,
  /** Fast retry when the previous 17track attempt was pending. */
  pendingRetry: FIVE_MIN_MS,
} as const;

/**
 * Pick the staleness cutoff for a given analysis based on its previous
 * 17track health. Pending wins over error (sooner retry). Missing or "ok" /
 * "skipped" attempts fall back to the standard 1h auto-refresh.
 */
export function pickCutoffForAnalysis(
  previous: SupportAnalysis | null,
): number {
  if (!previous?.trackings?.length) return ANALYSIS_FRESHNESS_MS.autoRefresh;
  let hasError = false;
  for (const t of previous.trackings) {
    if (t.last17trackAttempt === "pending") return ANALYSIS_FRESHNESS_MS.pendingRetry;
    if (t.last17trackAttempt === "error") hasError = true;
  }
  return hasError ? ANALYSIS_FRESHNESS_MS.fast17trackRetry : ANALYSIS_FRESHNESS_MS.autoRefresh;
}

/**
 * Reanalyze every active support email of the given shop whose last analysis
 * is older than `maxAgeMs`. We only refresh the thread anchor (latest analyzed
 * incoming), which is what the inbox UI displays.
 *
 * Errors on individual emails are logged and swallowed so a single bad
 * email never aborts the whole pass.
 */
export async function refreshStaleAnalysesForShop(
  shop: string,
  admin: AdminGraphqlClient,
  opts: { maxAgeMs?: number } = {},
): Promise<{ refreshed: number; skipped: number; errors: number }> {
  // The widest cutoff we'd ever pick is autoRefresh. We query Prisma with the
  // tightest cutoff (pendingRetry) so pending candidates aren't filtered out
  // at the SQL stage, then re-filter per-row in JS using pickCutoffForAnalysis
  // (which depends on the JSON blob `analysisResult` that Prisma can't filter
  // on portably). Callers passing an explicit `opts.maxAgeMs` keep the old
  // single-cutoff behaviour (used by tests with maxAgeMs: 0 and by the user-
  // action path that always wants a full refresh).
  const widestCutoffMs = opts.maxAgeMs ?? ANALYSIS_FRESHNESS_MS.pendingRetry;
  const widestCutoff = new Date(Date.now() - widestCutoffMs);

  const candidates = await prisma.incomingEmail.findMany({
    where: {
      shop,
      processingStatus: "analyzed",
      analysisResult: { not: null },
      OR: [{ lastAnalyzedAt: null }, { lastAnalyzedAt: { lt: widestCutoff } }],
      NOT: {
        thread: {
          is: {
            OR: [
              { operationalState: { in: ["resolved", "no_reply_needed"] } },
              { supportNature: "non_support" },
            ],
          },
        },
      },
    },
    orderBy: { receivedAt: "desc" },
    distinct: ["canonicalThreadId"],
    select: { id: true, analysisResult: true, lastAnalyzedAt: true },
    take: 20, // raised from 10 — we may filter half out below
  });

  // Per-candidate adaptive filtering. When the caller passed an explicit
  // maxAgeMs we honor it as-is (no adaptive logic) — preserves existing
  // bypass-the-cutoff semantics used by tests and the user-triggered path.
  const now = Date.now();
  const eligible: Array<{ id: string; analysisResult: string | null }> = [];
  let skipped = 0;
  for (const c of candidates) {
    let cutoffMs: number;
    if (opts.maxAgeMs !== undefined) {
      cutoffMs = opts.maxAgeMs;
    } else {
      const previous: SupportAnalysis | null = c.analysisResult
        ? (JSON.parse(c.analysisResult) as SupportAnalysis)
        : null;
      cutoffMs = pickCutoffForAnalysis(previous);
    }
    const age = c.lastAnalyzedAt ? now - c.lastAnalyzedAt.getTime() : Infinity;
    if (age > cutoffMs) {
      eligible.push({ id: c.id, analysisResult: c.analysisResult });
      if (eligible.length >= 10) break; // preserve original per-pass budget
    } else {
      skipped++;
    }
  }

  let refreshed = 0;
  let errors = 0;
  if (eligible.length === 0) {
    console.log(`[refresh-stale] shop=${shop} no stale candidates after adaptive filter`);
  }

  const BATCH_SIZE = 3;
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (c) => {
        try {
          const previous: SupportAnalysis | null = c.analysisResult
            ? (JSON.parse(c.analysisResult) as SupportAnalysis)
            : null;

          const reclassifyIntent =
            !previous ||
            !previous.intent ||
            previous.intent === "unknown" ||
            !previous.intents ||
            previous.intents.length === 0;
          const reSearchOrder = !previous || !previous.order;

          await refreshThreadAnalysis(c.id, admin, shop, {
            reclassifyIntent,
            reSearchOrder,
            refreshTracking: true,
          });
          refreshed++;
        } catch (err) {
          errors++;
          console.error(
            `[refresh-stale] shop=${shop} email=${c.id} reanalyze failed:`,
            err,
          );
        }
      }),
    );
  }
  return { refreshed, skipped, errors };
}
