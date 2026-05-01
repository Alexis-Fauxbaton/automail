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
import { reanalyzeEmail } from "../gmail/pipeline";
import type { AdminGraphqlClient } from "./shopify/order-search";

const ONE_HOUR_MS = 60 * 60_000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

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
  draftTrigger: ONE_HOUR_MS,
  autoRefresh: ONE_DAY_MS,
} as const;

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
    select: { id: true },
  });

  let refreshed = 0;
  let errors = 0;
  if (candidates.length === 0) {
    console.log(`[refresh-stale] shop=${shop} no stale candidates found`);
  }
  for (const c of candidates) {
    try {
      await reanalyzeEmail(c.id, admin, shop);
      refreshed++;
    } catch (err) {
      errors++;
      console.error(
        `[refresh-stale] shop=${shop} email=${c.id} reanalyze failed:`,
        err,
      );
    }
  }
  return { refreshed, skipped: 0, errors };
}
