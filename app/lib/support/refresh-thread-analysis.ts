/**
 * refreshThreadAnalysis — selective thread analysis refresh helper.
 *
 * Thin shim over analyzeThread. Preserves the public signature for all
 * existing callers (stale-refresh cron, handleEditThreadIdentifiers, etc.)
 * while delegating all DB writes and pipeline logic to the single entry point.
 */

import prisma from "../../db.server";
import type { AdminGraphqlClient } from "./shopify/order-search";
import type { SupportAnalysis } from "./types";

export interface RefreshThreadAnalysisOptions {
  /**
   * When false, keep the previous intent and intents values from the
   * persisted analysis rather than re-running the LLM intent classifier.
   */
  reclassifyIntent: boolean;
  /**
   * When false, keep the previous order and orderCandidates values from
   * the persisted analysis rather than re-querying Shopify.
   */
  reSearchOrder: boolean;
  /**
   * Always true in practice — tracking is always refreshed.
   * Included for symmetry and future flexibility.
   */
  refreshTracking: boolean;
}

/**
 * Selectively refreshes parts of a thread's analysis based on the provided
 * flags. Always preserves manualOverrides from the previous analysis.
 *
 * - reclassifyIntent: false → skip LLM classifier, reuse previous intent/intents/identifiers
 * - reSearchOrder: false    → skip Shopify search, reuse previous order/orderCandidates
 * - refreshTracking: true   → always refresh trackings
 *
 * Persists the merged analysis back to prisma and returns it.
 */
export async function refreshThreadAnalysis(
  emailId: string,
  admin: AdminGraphqlClient,
  shop: string,
  options: RefreshThreadAnalysisOptions,
): Promise<SupportAnalysis> {
  const record = await prisma.incomingEmail.findUnique({
    where: { id: emailId },
    select: { shop: true, canonicalThreadId: true },
  });
  if (!record || record.shop !== shop) {
    throw new Error("Email not found");
  }
  if (!record.canonicalThreadId) {
    throw new Error(`Email ${emailId} has no canonicalThreadId`);
  }

  const { analyzeThread } = await import("./analyze-thread");
  const result = await analyzeThread(
    record.canonicalThreadId,
    { shop, admin },
    {
      // No Tier 2 — this is a lightweight data-refresh path, not a new
      // message path. Tier 2 was already run when the message was synced.
      runTier2: false,
      runIntent: options.reclassifyIntent,
      runShopify: options.reSearchOrder,
      runTracking: options.refreshTracking,
      runDraft: false,
      // When the caller asked to skip intent/order re-run, forward
      // the previous values (reuseIntents/reuseOrder in analyzeThread
      // reads manualOverrides to decide whether to forward them).
      reuseIntents: !options.reclassifyIntent,
      reuseOrder: !options.reSearchOrder,
      // enforceQuota: false — the stale-refresh cron only runs when the
      // shop is active (suspended shops are skipped upstream). Rechecking
      // here would slow every tick with a billing API call.
      enforceQuota: false,
      // skipBillingIncrement: true — light refreshes (stale-refresh cron,
      // handleEditThreadIdentifiers) must never consume a billing unit.
      // Only first-analysis paths (live sync, Generate Draft, reanalyzeEmail)
      // should charge.
      skipBillingIncrement: true,
      // skipRecomputeState: true — preserve existing behaviour. The original
      // refreshThreadAnalysis did not call recomputeThreadState; doing so would
      // change the thread's operational state and could make it ineligible for
      // future background refreshes (e.g. if the thread transitions to
      // no_reply_needed because the seeded anchor has no tier1Result).
      skipRecomputeState: true,
    },
  );

  if (!result.ok) {
    throw new Error(`refreshThreadAnalysis failed: skipped=${result.skipped}`);
  }

  // Return the analysis for callers that use the return value.
  return result.analysis as SupportAnalysis;
}
