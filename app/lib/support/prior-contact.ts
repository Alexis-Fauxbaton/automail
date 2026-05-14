import prisma from "../../db.server";

export interface PriorContactResult {
  byAddress: boolean;
  byOrder: boolean;
  recentReply: boolean;
  matchedAddress: string | null;
}

const SHARED_SYSTEM_ADDRESSES = new Set([
  "mailer@shopify.com",
  "noreply@shopify.com",
  "no-reply@shopify.com",
]);

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

  // The merchant's own mailbox address must never count as a "prior contact"
  // signal — it appears on virtually every thread by definition (every reply
  // sent through the connected mailbox), so treating it like a customer
  // address produces systematic false positives. Same for any past outgoing
  // address used by this shop (covers aliases like support@, contact@).
  const conn = await prisma.mailConnection.findUnique({
    where: { shop },
    select: { email: true },
  });
  const outgoingAddrs = await prisma.incomingEmail.findMany({
    where: { shop, processingStatus: "outgoing" },
    select: { fromAddress: true },
    distinct: ["fromAddress"],
  });
  const merchantAddresses = new Set<string>();
  if (conn?.email) merchantAddresses.add(conn.email.toLowerCase());
  for (const r of outgoingAddrs) merchantAddresses.add(r.fromAddress.toLowerCase());
  const isMerchantOrSystem = (addr: string): boolean =>
    SHARED_SYSTEM_ADDRESSES.has(addr) || merchantAddresses.has(addr);

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

  const repliedAddressRows = repliedCanonicalIds.length > 0
    ? await prisma.incomingEmail.findMany({
        where: {
          shop,
          canonicalThreadId: { in: repliedCanonicalIds },
          processingStatus: { not: "outgoing" },
        },
        select: { fromAddress: true, canonicalThreadId: true },
      })
    : [];

  const addressRepliedIn = new Map<string, Set<string>>();
  for (const r of repliedAddressRows) {
    if (!r.canonicalThreadId) continue;
    const addr = r.fromAddress.toLowerCase();
    if (isMerchantOrSystem(addr)) continue;
    if (!addressRepliedIn.has(addr)) addressRepliedIn.set(addr, new Set());
    addressRepliedIn.get(addr)!.add(r.canonicalThreadId);
  }

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

  // Pre-bucket incoming rows by thread so the per-thread loop is O(incoming)
  // total rather than O(threads × rows) — the previous filter() inside the
  // loop was the hottest path in the inbox loader.
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
    const addrs = incomingMsgs
      .map((r) => r.fromAddress.toLowerCase())
      .filter((a) => !isMerchantOrSystem(a));
    const hadEarlierReply = (tid: string) =>
      tid !== id && (earliestOutgoingByThread.get(tid) ?? Infinity) < threadStartedAt;
    const hasRecentReply = (tid: string) =>
      tid !== id && latestIncomingAt > 0 &&
      (latestOutgoingByThread.get(tid) ?? -Infinity) > latestIncomingAt;
    let matchedAddress: string | null = null;
    const byAddress = addrs.some((addr) => {
      const ids = addressRepliedIn.get(addr);
      const hit = ids ? [...ids].some(hadEarlierReply) : false;
      if (hit && !matchedAddress) matchedAddress = addr;
      return hit;
    });
    const byOrder = !!state?.resolvedOrderNumber && (() => {
      const ids = orderRepliedIn.get(state.resolvedOrderNumber!);
      return ids ? [...ids].some(hadEarlierReply) : false;
    })();
    const recentReply =
      addrs.some((addr) => {
        const ids = addressRepliedIn.get(addr);
        return ids ? [...ids].some(hasRecentReply) : false;
      }) ||
      (!!state?.resolvedOrderNumber && (() => {
        const ids = orderRepliedIn.get(state.resolvedOrderNumber!);
        return ids ? [...ids].some(hasRecentReply) : false;
      })());
    if (byAddress || byOrder || recentReply) priorContactByThread[id] = { byAddress, byOrder, recentReply, matchedAddress };
  }
  return priorContactByThread;
}
