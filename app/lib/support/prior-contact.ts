import prisma from "../../db.server";

/**
 * Prior-contact signal — computed once per inbox load.
 *
 * History: an earlier version also exposed a `byAddress` sub-signal (same
 * email address replied to in another thread) and a `matchedAddress` hint.
 * Both produced too many false positives (shared mailboxes, recurring
 * customers on public domains, merchant aliases) without enough actionable
 * value — see ../../../docs/superpowers/specs/2026-04-26-requirements-and-test-plan-design.md
 * for the original spec, and the 2026-05-14 follow-up decision to keep only
 * the per-order signal. The merchant can still see customer history by
 * opening the customer view.
 */
export interface PriorContactResult {
  /** Same order number was already discussed in another thread we replied to. */
  byOrder: boolean;
  /** A reply was sent on another thread linked to this order *after* the
   *  current thread's latest incoming — the merchant has touched this in the
   *  meantime, the agent should look before answering. */
  recentReply: boolean;
}

export async function computePriorContact(
  shop: string,
  canonicalIds: string[],
  rows: Array<{
    canonicalThreadId: string | null;
    processingStatus: string;
    receivedAt: Date;
    fromAddress: string;
  }>,
  threadStates: Record<string, { resolvedOrderNumber: string | null }>,
  threadCreatedAt: Map<string, Date>,
): Promise<Record<string, PriorContactResult>> {
  if (canonicalIds.length === 0) return {};

  const outgoingRows = await prisma.incomingEmail.findMany({
    where: { shop, processingStatus: "outgoing" },
    select: { canonicalThreadId: true, receivedAt: true },
  });

  const earliestOutgoingByThread = new Map<string, number>();
  const latestOutgoingByThread = new Map<string, number>();
  for (const r of outgoingRows) {
    if (!r.canonicalThreadId) continue;
    const t = r.receivedAt.getTime();
    const prevEarliest = earliestOutgoingByThread.get(r.canonicalThreadId) ?? Infinity;
    if (t < prevEarliest) earliestOutgoingByThread.set(r.canonicalThreadId, t);
    const prevLatest = latestOutgoingByThread.get(r.canonicalThreadId) ?? -Infinity;
    if (t > prevLatest) latestOutgoingByThread.set(r.canonicalThreadId, t);
  }
  const repliedCanonicalIds = [...earliestOutgoingByThread.keys()];

  const orderRepliedIn = new Map<string, Set<string>>();
  if (repliedCanonicalIds.length > 0) {
    const repliedThreadMeta = await prisma.thread.findMany({
      where: { id: { in: repliedCanonicalIds } },
      select: { id: true, resolvedOrderNumber: true },
    });
    for (const r of repliedThreadMeta) {
      if (!r.resolvedOrderNumber) continue;
      if (!orderRepliedIn.has(r.resolvedOrderNumber)) orderRepliedIn.set(r.resolvedOrderNumber, new Set());
      orderRepliedIn.get(r.resolvedOrderNumber)!.add(r.id);
    }
  }

  // Pre-bucket incoming rows by thread so the per-thread loop stays O(incoming).
  const incomingByThread = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.canonicalThreadId || r.processingStatus === "outgoing") continue;
    const bucket = incomingByThread.get(r.canonicalThreadId);
    if (bucket) bucket.push(r);
    else incomingByThread.set(r.canonicalThreadId, [r]);
  }

  const priorContactByThread: Record<string, PriorContactResult> = {};
  for (const id of canonicalIds) {
    const state = threadStates[id];
    const currentCreatedAt = threadCreatedAt.get(id);
    if (!currentCreatedAt) continue;
    if (!state?.resolvedOrderNumber) continue; // No order resolved → no signal.

    const incomingMsgs = incomingByThread.get(id) ?? [];
    const latestIncomingAt = incomingMsgs.reduce(
      (max, r) => (r.receivedAt.getTime() > max ? r.receivedAt.getTime() : max),
      0,
    );
    const earliestIncomingAt = incomingMsgs.reduce(
      (min, r) => (r.receivedAt.getTime() < min ? r.receivedAt.getTime() : min),
      Infinity,
    );
    const threadStartedAt = earliestIncomingAt < Infinity ? earliestIncomingAt : currentCreatedAt.getTime();
    const hadEarlierReply = (tid: string) =>
      tid !== id && (earliestOutgoingByThread.get(tid) ?? Infinity) < threadStartedAt;
    const hasRecentReply = (tid: string) =>
      tid !== id && latestIncomingAt > 0 &&
      (latestOutgoingByThread.get(tid) ?? -Infinity) > latestIncomingAt;

    const ids = orderRepliedIn.get(state.resolvedOrderNumber);
    if (!ids) continue;
    const byOrder = [...ids].some(hadEarlierReply);
    const recentReply = [...ids].some(hasRecentReply);
    if (byOrder || recentReply) priorContactByThread[id] = { byOrder, recentReply };
  }
  return priorContactByThread;
}
