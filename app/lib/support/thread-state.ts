// Thread-level state management — spec §4 (sticky support), §5
// (operational state), §7 (message-level vs thread-level), §9
// (structured thread state).
//
// All thread-level classification goes through this module. The
// pipeline calls `recomputeThreadState(canonicalThreadId)` after every
// ingestion and every re-analysis; nothing else should write to
// Thread.supportNature / operationalState / structuredState directly.

import prisma from "../../db.server";
import { getTrueLatestMessage } from "../mail/thread-resolver";
import { recordStateTransition } from "./thread-state-history";

export type SupportNature =
  | "unknown"
  | "non_support"
  | "probable_support"
  | "confirmed_support"
  | "mixed"
  | "needs_review";

export type OperationalState =
  | "open"
  | "waiting_customer"
  | "waiting_merchant"
  | "resolved"
  | "no_reply_needed";

/**
 * Structured, LLM-friendly compact snapshot of a thread's state.
 * Stored as JSON on Thread.structuredState and consumed by the Tier 2
 * classifier and the draft generator (spec §8: compact for classify,
 * rich for draft — this is the "compact" part).
 */
export interface StructuredThreadState {
  messageCount: number;
  incomingCount: number;
  outgoingCount: number;
  orderResolved: boolean;
  trackingResolved: boolean;
  resolvedOrderNumber: string | null;
  resolvedTrackingNumber: string | null;
  resolutionConfidence: "none" | "low" | "medium" | "high";
  lastCustomerMessageAt: string | null;
  lastAgentMessageAt: string | null;
  lastDirection: "incoming" | "outgoing" | "unknown";
  awaitingCustomer: boolean;
  awaitingMerchant: boolean;
  replyNeeded: boolean;
  hasDraft: boolean;
  supportNature: SupportNature;
  operationalState: OperationalState;
  trueLatestMessageId: string | null;
  targetMessageId: string | null;
  historyStatus: "complete" | "partial" | "unknown";
}

const NATURE_RANK: Record<SupportNature, number> = {
  unknown: 0,
  non_support: 1,
  probable_support: 2,
  needs_review: 2,
  mixed: 3,
  confirmed_support: 4,
};

/**
 * Apply the STICKY rule (spec §4): once a thread is confirmed support,
 * never downgrade it automatically. All other transitions are allowed,
 * but a higher nature always beats a lower one from the same signal.
 *
 * Exception: mixed (multi-intent) threads always override confirmed_support,
 * because a mixed classification is a higher-level descriptor.
 */
export function mergeNature(
  current: SupportNature,
  incoming: SupportNature,
): SupportNature {
  // If incoming is mixed, it always wins (higher-level classification).
  if (incoming === "mixed") return "mixed";
  // Sticky rule: once confirmed_support, don't downgrade.
  if (current === "confirmed_support") return "confirmed_support";
  // Mixed conversations: customer support + marketing noise etc. Keep
  // the strongest signal overall.
  if (NATURE_RANK[incoming] >= NATURE_RANK[current]) return incoming;
  return current;
}

/**
 * Map a single message's Tier 2 classification onto the thread nature
 * scale. Nothing is sticky at the message level — stickiness is applied
 * at the merge step.
 */
function messageNature(tier2Result: string | null): SupportNature {
  switch (tier2Result) {
    case "support_client":
      return "confirmed_support";
    case "incertain":
      return "needs_review";
    case "probable_non_client":
      return "non_support";
    default:
      return "unknown";
  }
}

/**
 * Derive the operational state of a thread from its messages.
 * Pure function of the persisted data — no LLM call.
 */
export function deriveOperationalState(args: {
  lastDirection: "incoming" | "outgoing" | "unknown";
  replyNeeded: boolean;
  noReplyNeeded: boolean;
  hasIncoming: boolean;
}): OperationalState {
  if (args.noReplyNeeded) return "no_reply_needed";
  if (!args.hasIncoming) return "open";
  if (args.lastDirection === "outgoing") return "waiting_customer";
  if (args.lastDirection === "incoming" && args.replyNeeded) return "waiting_merchant";
  if (args.lastDirection === "incoming" && !args.replyNeeded) return "no_reply_needed";
  return "open";
}

/**
 * Recompute supportNature, operationalState and structuredState for a
 * canonical thread, applying the sticky rule. Idempotent.
 *
 * Call this:
 *   - after every ingestion of a new message in a thread
 *   - after every Tier 2 classification of a message
 *   - after every reanalyze
 *   - during backfill
 */
export async function recomputeThreadState(
  canonicalThreadId: string,
  opts: { mailboxAddress?: string } = {},
): Promise<StructuredThreadState> {
  const thread = await prisma.thread.findUnique({
    where: { id: canonicalThreadId },
    select: {
      shop: true,
      supportNature: true,
      operationalState: true,
      previousOperationalState: true,
      operationalStateUpdatedAt: true,
      resolvedOrderNumber: true,
      resolvedTrackingNumber: true,
      resolutionConfidence: true,
      historyStatus: true,
    },
  });
  if (!thread) {
    throw new Error(`recomputeThreadState: thread ${canonicalThreadId} not found`);
  }

  const messages = await prisma.incomingEmail.findMany({
    where: { canonicalThreadId },
    orderBy: { receivedAt: "asc" },
    select: {
      id: true,
      fromAddress: true,
      receivedAt: true,
      processingStatus: true,
      tier1Result: true,
      tier2Result: true,
      analysisResult: true,
      replyDraft: { select: { body: true } },
    },
  });

  const mailbox = (opts.mailboxAddress ?? "").trim().toLowerCase();
  let incomingCount = 0;
  let outgoingCount = 0;
  let lastCustomerAt: Date | null = null;
  let lastAgentAt: Date | null = null;
  let lastDirection: "incoming" | "outgoing" | "unknown" = "unknown";
  let mergedNature: SupportNature = "unknown";
  let noReplyNeeded = false;
  let hasDraft = false;
  let targetMessageId: string | null = null;
  let targetReplyNeeded = false;

  for (const m of messages) {
    const isOutgoing =
      m.processingStatus === "outgoing" ||
      (mailbox !== "" && m.fromAddress.trim().toLowerCase() === mailbox);

    if (isOutgoing) {
      outgoingCount++;
      lastAgentAt = m.receivedAt;
      lastDirection = "outgoing";
    } else {
      incomingCount++;
      lastCustomerAt = m.receivedAt;
      lastDirection = "incoming";
      // Accumulate nature from message-level classifications.
      const nature = messageNature(m.tier2Result);
      if (m.tier1Result?.startsWith("filtered:")) {
        // Tier 1 regex filtered — weak non-support signal only.
        mergedNature = mergeNature(mergedNature, "non_support");
      } else {
        mergedNature = mergeNature(mergedNature, nature);
      }
    }

    // Pick the latest incoming that passed Tier 1 as the "target".
    if (
      !isOutgoing &&
      m.tier1Result === "passed" &&
      m.processingStatus !== "error"
    ) {
      targetMessageId = m.id;
      // Pull noReplyNeeded from the latest analysis.
      noReplyNeeded = false;
      if (m.analysisResult) {
        try {
          const parsed = JSON.parse(m.analysisResult) as {
            conversation?: { noReplyNeeded?: boolean };
          };
          noReplyNeeded = parsed.conversation?.noReplyNeeded === true;
        } catch {
          /* ignore */
        }
      }
      hasDraft = !!m.replyDraft?.body;
      targetReplyNeeded = !noReplyNeeded && mergedNature !== "non_support";
    }
  }

  // Apply sticky rule against the previously persisted nature.
  const finalNature = mergeNature(thread.supportNature as SupportNature, mergedNature);

  const operationalState = deriveOperationalState({
    lastDirection,
    replyNeeded: targetReplyNeeded,
    noReplyNeeded,
    hasIncoming: incomingCount > 0,
  });

  const trueLatest = await getTrueLatestMessage(canonicalThreadId);

  const structured: StructuredThreadState = {
    messageCount: messages.length,
    incomingCount,
    outgoingCount,
    orderResolved: !!thread.resolvedOrderNumber,
    trackingResolved: !!thread.resolvedTrackingNumber,
    resolvedOrderNumber: thread.resolvedOrderNumber,
    resolvedTrackingNumber: thread.resolvedTrackingNumber,
    resolutionConfidence:
      (thread.resolutionConfidence as StructuredThreadState["resolutionConfidence"]) ?? "none",
    lastCustomerMessageAt: lastCustomerAt?.toISOString() ?? null,
    lastAgentMessageAt: lastAgentAt?.toISOString() ?? null,
    lastDirection,
    awaitingCustomer: operationalState === "waiting_customer",
    awaitingMerchant: operationalState === "waiting_merchant",
    replyNeeded: operationalState === "waiting_merchant",
    hasDraft,
    supportNature: finalNature,
    operationalState,
    trueLatestMessageId: trueLatest?.id ?? null,
    targetMessageId,
    historyStatus: (thread.historyStatus as StructuredThreadState["historyStatus"]) ?? "unknown",
  };

  const now = new Date();

  // Respect manual resolutions: if an agent explicitly marked this thread
  // as resolved (operationalState === "resolved" AND previousOperationalState
  // is set as a breadcrumb), keep that resolved state unless a new incoming
  // message arrived AFTER the resolution was recorded.
  const wasManuallyResolved =
    thread.operationalState === "resolved" &&
    thread.previousOperationalState !== null &&
    thread.operationalStateUpdatedAt !== null;
  if (wasManuallyResolved) {
    const resolvedAt = thread.operationalStateUpdatedAt!.getTime();
    const hasNewIncoming =
      lastCustomerAt !== null && lastCustomerAt.getTime() > resolvedAt;
    if (!hasNewIncoming) {
      // No new customer message since the manual resolve — honour it.
      // Still update supportNature and structuredState.
      const structured: StructuredThreadState = {
        messageCount: messages.length,
        incomingCount,
        outgoingCount,
        orderResolved: !!thread.resolvedOrderNumber,
        trackingResolved: !!thread.resolvedTrackingNumber,
        resolvedOrderNumber: thread.resolvedOrderNumber,
        resolvedTrackingNumber: thread.resolvedTrackingNumber,
        resolutionConfidence:
          (thread.resolutionConfidence as StructuredThreadState["resolutionConfidence"]) ?? "none",
        lastCustomerMessageAt: lastCustomerAt?.toISOString() ?? null,
        lastAgentMessageAt: lastAgentAt?.toISOString() ?? null,
        lastDirection,
        awaitingCustomer: false,
        awaitingMerchant: false,
        replyNeeded: false,
        hasDraft,
        supportNature: finalNature,
        operationalState: "resolved",
        trueLatestMessageId: trueLatest?.id ?? null,
        targetMessageId,
        historyStatus: (thread.historyStatus as StructuredThreadState["historyStatus"]) ?? "unknown",
      };
      await prisma.thread.update({
        where: { id: canonicalThreadId },
        data: {
          supportNature: finalNature,
          supportNatureUpdatedAt: finalNature !== thread.supportNature ? now : undefined,
          structuredState: JSON.stringify(structured),
        },
      });
      return structured;
    }
    // New incoming after manual resolve — fall through to normal recompute
    // (thread is reopened automatically).
  }

  await prisma.thread.update({
    where: { id: canonicalThreadId },
    data: {
      supportNature: finalNature,
      supportNatureUpdatedAt: finalNature !== thread.supportNature ? now : undefined,
      operationalState,
      previousOperationalState: null, // reset — new message clears manual resolve
      operationalStateUpdatedAt: now,
      structuredState: JSON.stringify(structured),
    },
  });

  await recordStateTransition(prisma, {
    shop: thread.shop,
    threadId: canonicalThreadId,
    fromState: thread.operationalState ?? null,
    toState: operationalState,
  });

  return structured;
}

/** Read the cached structured state for a thread (no recompute). */
export async function readStructuredState(
  canonicalThreadId: string,
): Promise<StructuredThreadState | null> {
  const t = await prisma.thread.findUnique({
    where: { id: canonicalThreadId },
    select: { structuredState: true },
  });
  if (!t) return null;
  try {
    return JSON.parse(t.structuredState) as StructuredThreadState;
  } catch {
    return null;
  }
}

/**
 * Render the structured state as a compact human-readable block
 * suitable for injection into an LLM system/user prompt.
 */
export function renderStructuredStateForLLM(s: StructuredThreadState): string {
  const lines = [
    `messages=${s.messageCount} (in=${s.incomingCount}, out=${s.outgoingCount})`,
    `nature=${s.supportNature} opState=${s.operationalState}`,
    `orderResolved=${s.orderResolved}${s.resolvedOrderNumber ? ` (#${s.resolvedOrderNumber})` : ""}`,
    `trackingResolved=${s.trackingResolved}${s.resolvedTrackingNumber ? ` (${s.resolvedTrackingNumber})` : ""}`,
    `lastDirection=${s.lastDirection}`,
    `replyNeeded=${s.replyNeeded} hasDraft=${s.hasDraft}`,
    `historyStatus=${s.historyStatus}`,
  ];
  return lines.join("\n");
}

/**
 * Recompute the operational state for every thread in `shop` whose
 * `operationalState` is still `"open"` (the default value — meaning
 * `recomputeThreadState` was never called on it).
 *
 * This is safe to run in a background job: it is idempotent, batched,
 * and isolated per shop. Errors on individual threads are logged and
 * skipped — they don't abort the whole run.
 */
export async function recomputeAllOpenThreads(
  shop: string,
  opts: { mailboxAddress?: string } = {},
): Promise<{ processed: number; errors: number }> {
  // Only process threads that have never been through recomputeThreadState
  // (operationalStateUpdatedAt IS NULL). Threads already computed but stuck
  // in "open" (e.g. outgoing-only) must not be re-enqueued every tick.
  const threads = await prisma.thread.findMany({
    where: { shop, operationalState: "open", operationalStateUpdatedAt: null },
    select: { id: true },
  });

  let processed = 0;
  let errors = 0;
  for (const thread of threads) {
    try {
      await recomputeThreadState(thread.id, opts);
      processed++;
    } catch (err) {
      errors++;
      console.error(`[recompute] shop=${shop} thread=${thread.id} failed:`, err);
    }
  }
  console.log(
    `[recompute] shop=${shop} done: processed=${processed} errors=${errors}`,
  );
  return { processed, errors };
}
