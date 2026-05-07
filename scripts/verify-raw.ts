// Independent DB verification - no shared code with dashboard helpers
import prisma from "../app/db.server.js";

const SHOP = "2ed20e.myshopify.com";
const NOW = new Date("2026-05-07T22:00:00Z"); // ~midnight Paris
const D30 = new Date(NOW.getTime() - 30 * 24 * 3600 * 1000);
const D60 = new Date(NOW.getTime() - 60 * 24 * 3600 * 1000);

console.log(`Period: ${D30.toISOString()} -> ${NOW.toISOString()}\n`);

// ============================================================
// 1. Volume support — raw count of incoming emails (non-outgoing)
//    that are tier2='support_client' OR thread is support
// ============================================================
const supportEmails = await prisma.incomingEmail.findMany({
  where: {
    shop: SHOP,
    receivedAt: { gte: D30, lt: NOW },
    processingStatus: { not: "outgoing" },
  },
  select: {
    id: true,
    receivedAt: true,
    tier2Result: true,
    canonicalThreadId: true,
    detectedIntent: true,
  },
});
const supportThreadIds = new Set(
  (await prisma.thread.findMany({
    where: { shop: SHOP, supportNature: { in: ["confirmed_support", "probable_support"] } },
    select: { id: true },
  })).map(t => t.id)
);
const volumeSupport = supportEmails.filter(e =>
  e.tier2Result === "support_client" ||
  (e.canonicalThreadId && supportThreadIds.has(e.canonicalThreadId))
).length;

const prevSupportEmails = await prisma.incomingEmail.findMany({
  where: { shop: SHOP, receivedAt: { gte: D60, lt: D30 }, processingStatus: { not: "outgoing" } },
  select: { tier2Result: true, canonicalThreadId: true },
});
const volumePrev = prevSupportEmails.filter(e =>
  e.tier2Result === "support_client" ||
  (e.canonicalThreadId && supportThreadIds.has(e.canonicalThreadId))
).length;

console.log(`[1] Volume support 30d : ${volumeSupport} (prev 30-60d: ${volumePrev})`);
console.log(`    Variation: ${volumePrev > 0 ? Math.round((volumeSupport - volumePrev) / volumePrev * 100) : "N/A"}%`);

// ============================================================
// 2. Median response time — independently compute
// ============================================================
const supportThreads = await prisma.thread.findMany({
  where: {
    shop: SHOP,
    firstMessageAt: { gte: D30, lt: NOW },
    supportNature: { in: ["confirmed_support", "probable_support"] },
  },
  select: { id: true, firstMessageAt: true },
});

const responseMs: number[] = [];
for (const t of supportThreads) {
  const allMsgs = await prisma.incomingEmail.findMany({
    where: { canonicalThreadId: t.id, shop: SHOP },
    orderBy: { receivedAt: "asc" },
    select: { receivedAt: true, processingStatus: true },
  });
  // Skip threads where outgoing happened before/at firstMessageAt
  const earlyOut = allMsgs.find(m => m.processingStatus === "outgoing" && m.receivedAt <= t.firstMessageAt);
  if (earlyOut) continue;
  const firstOut = allMsgs.find(m => m.processingStatus === "outgoing" && m.receivedAt > t.firstMessageAt);
  if (!firstOut) continue;
  const ms = firstOut.receivedAt.getTime() - t.firstMessageAt.getTime();
  if (ms > 0) responseMs.push(ms);
}
responseMs.sort((a, b) => a - b);
function pctl(arr: number[], p: number): number | null {
  if (arr.length === 0) return null;
  const pos = p * (arr.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? arr[lo] : arr[lo] + (pos - lo) * (arr[hi] - arr[lo]);
}
const med = pctl(responseMs, 0.5);
const p90 = pctl(responseMs, 0.9);
console.log(`\n[2] Response times: ${responseMs.length} samples`);
console.log(`    Median: ${med ? (med / 3600000).toFixed(1) + "h" : "null"} | raw ms: ${med}`);
console.log(`    P90   : ${p90 ? (p90 / 3600000).toFixed(1) + "h" : "null"}`);

// ============================================================
// 3. Reopened threads — count events in ThreadStateHistory
// ============================================================
const reopenedEvents = await prisma.threadStateHistory.findMany({
  where: {
    shop: SHOP,
    fromState: "resolved",
    NOT: { toState: "resolved" },
    changedAt: { gte: D30, lt: NOW },
  },
  select: { threadId: true, changedAt: true },
});
console.log(`\n[3] Reopened events 30d: ${reopenedEvents.length}`);
const byThread = new Map<string, number>();
reopenedEvents.forEach(e => byThread.set(e.threadId, (byThread.get(e.threadId) ?? 0) + 1));
console.log(`    Distinct threads: ${byThread.size}`);
[...byThread.entries()].sort((a, b) => b[1] - a[1]).forEach(([id, n]) =>
  console.log(`      ${id} × ${n}`)
);

// ============================================================
// 4. Drafts — raw groupBy on ReplyDraft.heuristicBucket
// ============================================================
const drafts = await prisma.replyDraft.findMany({
  where: { shop: SHOP, createdAt: { gte: D30, lt: NOW } },
  select: { heuristicBucket: true },
});
const buckets = { as_is: 0, edited: 0, ignored: 0, pending: 0 };
drafts.forEach(d => {
  if (d.heuristicBucket === "as_is") buckets.as_is++;
  else if (d.heuristicBucket === "edited") buckets.edited++;
  else if (d.heuristicBucket === "ignored") buckets.ignored++;
  else buckets.pending++;
});
const denom = buckets.as_is + buckets.edited + buckets.ignored;
const sentPct = denom > 0 ? Math.round((buckets.as_is + buckets.edited) / denom * 100) : null;
console.log(`\n[4] Drafts 30d: ${drafts.length} total`);
console.log(`    as_is: ${buckets.as_is} | edited: ${buckets.edited} | ignored: ${buckets.ignored} | pending: ${buckets.pending}`);
console.log(`    sentPct: ${sentPct !== null ? sentPct + "%" : "null"}`);

// ============================================================
// 5. Top intents — raw groupBy from threads or emails?
//    Looking at dashboard impl: latest_intent CTE uses IncomingEmail.detectedIntent
// ============================================================
const intentRows = await prisma.$queryRaw<{ intent: string; count: bigint }[]>`
  WITH latest AS (
    SELECT DISTINCT ON (e."canonicalThreadId")
      e."canonicalThreadId", e."detectedIntent" AS intent
    FROM "IncomingEmail" e
    JOIN "Thread" t ON t.id = e."canonicalThreadId"
    WHERE e.shop = ${SHOP}
      AND e."receivedAt" >= ${D30}
      AND e."receivedAt" < ${NOW}
      AND e."processingStatus" != 'outgoing'
      AND t."supportNature" IN ('confirmed_support', 'probable_support')
      AND e."detectedIntent" IS NOT NULL
    ORDER BY e."canonicalThreadId", e."receivedAt" DESC
  )
  SELECT intent, COUNT(*)::bigint AS count
  FROM latest
  GROUP BY intent
  ORDER BY count DESC
  LIMIT 8
`;
console.log(`\n[5] Top intents (independent SQL):`);
intentRows.forEach(r => console.log(`    ${r.intent}: ${r.count}`));

// ============================================================
// 6. État actuel — raw groupBy
// ============================================================
const stateRows = await prisma.thread.groupBy({
  by: ["operationalState", "supportNature"],
  where: { shop: SHOP },
  _count: { _all: true },
});
console.log(`\n[6] Thread states (full breakdown):`);
stateRows.sort((a, b) => a.operationalState.localeCompare(b.operationalState))
  .forEach(r => console.log(`    ${r.operationalState.padEnd(20)} ${r.supportNature.padEnd(20)} ${r._count._all}`));

const supportStates: Record<string, number> = {};
const allStates = await prisma.thread.groupBy({
  by: ["operationalState"],
  where: { shop: SHOP, supportNature: { not: "non_support" } },
  _count: { _all: true },
});
allStates.forEach(r => supportStates[r.operationalState] = r._count._all);
console.log(`\n    AFTER FIX (excluding non_support):`);
["open", "waiting_customer", "waiting_merchant", "resolved", "no_reply_needed"].forEach(s =>
  console.log(`      ${s.padEnd(20)} ${supportStates[s] ?? 0}`)
);

process.exit(0);
