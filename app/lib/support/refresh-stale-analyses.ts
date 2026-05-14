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
  const maxAgeMs = opts.maxAgeMs ?? ANALYSIS_FRESHNESS_MS.autoRefresh;
  const cutoff = new Date(Date.now() - maxAgeMs);

  // Candidate emails: latest analyzed incoming per thread whose
  // lastAnalyzedAt is null or older than the cutoff.
  // We include all active support threads and exclude:
  //   - definitively closed threads (resolved / no_reply_needed)
  //   - threads explicitly classified as non-support (non_support)
  // Threads with supportNature = "unknown" / "needs_review" / "probable_support"
  // / "confirmed_support" / "mixed" are all included.
  // Emails with no canonical thread are included unconditionally.
  const candidates = await prisma.incomingEmail.findMany({
    where: {
      shop,
      processingStatus: "analyzed",
      analysisResult: { not: null },
      OR: [{ lastAnalyzedAt: null }, { lastAnalyzedAt: { lt: cutoff } }],
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
    select: { id: true, analysisResult: true },
    take: 10,
  });

  let refreshed = 0;
  let skipped = 0;
  let errors = 0;
  if (candidates.length === 0) {
    console.log(`[refresh-stale] shop=${shop} no stale candidates found`);
  }

  const BATCH_SIZE = 3;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
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
