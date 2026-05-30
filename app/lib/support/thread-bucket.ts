/**
 * Single source of truth for "what bucket is this thread in?".
 *
 * Used by:
 *   - the inbox primary tabs ([app/routes/app.inbox.tsx](../../routes/app.inbox.tsx))
 *   - the dashboard "État actuel" panel ([app/lib/dashboard-stats.ts](../dashboard-stats.ts))
 *
 * Why a shared function (not just a DB query):
 *   Thread.operationalState is a raw column that can lag behind reality
 *   (e.g. a 9-day-old "waiting_customer" thread should appear as resolved
 *   in the inbox, but the column hasn't been touched). The merchant sees
 *   the computed bucket — every surface that counts threads must use this
 *   function so the numbers never disagree.
 */

export type OpsBucket =
  | "to_process"        // support thread, last msg incoming, needs a human reply
  | "to_analyze"        // support thread, Tier 3 never ran (suspended sync) — waits for explicit click
  | "waiting_customer"  // we replied, awaiting customer
  | "waiting_merchant"  // internal / data action required on our side
  | "resolved"          // closed, no reply needed, or aged-out conversation
  | "other";            // non-support, filtered, or unclassified

// Threads with no recent activity for this many ms are auto-bucketed as resolved.
export const AUTO_RESOLVE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type LatestClassification = "support" | "uncertain" | "filtered" | "non_support" | "all";

export interface BucketLatestMsg {
  processingStatus: string;
  fromAddress: string;
  receivedAt: Date | string;
}

export interface BucketThreadState {
  supportNature: string | null;
  operationalState: string | null;
  // Date | null on the server side (Prisma), string | null after JSON
  // serialization (loader → client). Only inspected for truthiness here,
  // so both shapes are accepted.
  analyzedAt: Date | string | null;
  dismissedFromAnalyzeAt: Date | string | null;
}

export interface BucketInput {
  latest: BucketLatestMsg;
  // Classification of the most-recently-CLASSIFIED message in the thread.
  // (Walk back from the latest to find the first message with tier1/tier2
  // results — outgoing messages have no tier results and would otherwise
  // mask the thread's nature.)
  classification: LatestClassification;
  // analysisResult.conversation.noReplyNeeded on the anchor message.
  noReplyNeeded: boolean;
  state: BucketThreadState | null;
  connectedEmail: string | null;
}

export function getMessageDirection(
  msg: BucketLatestMsg,
  connectedEmail: string | null,
): "incoming" | "outgoing" | "unknown" {
  // processingStatus="outgoing" is set at ingest against the correct
  // mailbox's outgoingAliases — trust it first. The fromAddress fallback
  // only handles single-mailbox legacy rows.
  if (msg.processingStatus === "outgoing") return "outgoing";
  const from = msg.fromAddress.trim().toLowerCase();
  const mailbox = (connectedEmail ?? "").trim().toLowerCase();
  if (!from || !mailbox) return "unknown";
  return from === mailbox ? "outgoing" : "incoming";
}

export function classifyMessage(msg: {
  tier1Result: string | null;
  tier2Result: string | null;
}): LatestClassification {
  if (msg.tier1Result?.startsWith("filtered:")) return "filtered";
  if (msg.tier2Result === "support_client") return "support";
  if (msg.tier2Result === "incertain") return "uncertain";
  if (msg.tier2Result === "probable_non_client") return "non_support";
  return "all";
}

export function getThreadOpsBucket(input: BucketInput): OpsBucket {
  const { latest, classification, noReplyNeeded, state, connectedEmail } = input;

  if (state?.supportNature === "non_support") return "other";

  // Manual close wins over any automatic signal.
  if (state?.operationalState === "resolved" || state?.operationalState === "no_reply_needed") {
    return "resolved";
  }

  // À analyser: support stance but Tier 3 never ran. Falls through to
  // regular buckets once analyzedAt is set.
  const isSupportStance =
    state?.supportNature === "confirmed_support" ||
    state?.supportNature === "probable_support" ||
    state?.supportNature === "mixed";
  if (isSupportStance && !state?.analyzedAt) {
    if (!state?.dismissedFromAnalyzeAt) return "to_analyze";
    return "other";
  }

  const direction = getMessageDirection(latest, connectedEmail);
  const isSupport = classification === "support";
  const needsReply = isSupport && direction === "incoming" && !noReplyNeeded;
  if (needsReply) return "to_process";

  const op = state?.operationalState;
  const ageMs = Date.now() - new Date(latest.receivedAt).getTime();
  const isStale = ageMs >= AUTO_RESOLVE_AGE_MS;

  // DB says waiting_merchant but the last message is outgoing → stale state,
  // override to waiting_customer (and auto-resolve if stale).
  if (op === "waiting_merchant" && direction === "outgoing") {
    return isStale ? "resolved" : "waiting_customer";
  }
  if (op === "waiting_merchant") return "waiting_merchant";
  if (op === "waiting_customer") {
    return isStale ? "resolved" : "waiting_customer";
  }
  if (noReplyNeeded) return "resolved";

  // No explicit operational state yet (legacy or pre-recompute). Infer.
  const isLikelySupport =
    state?.supportNature === "confirmed_support" ||
    state?.supportNature === "needs_review" ||
    (!state && classification === "support");
  if (isLikelySupport) {
    if (direction === "outgoing") {
      return isStale ? "resolved" : "waiting_customer";
    }
    return "waiting_merchant";
  }

  return "other";
}
