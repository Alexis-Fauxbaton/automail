import prisma from "../app/db.server.js";
import { getDashboardKpis, getPeriodBounds } from "../app/lib/dashboard-stats.js";

const SHOP = "2ed20e.myshopify.com";
const NOW = new Date("2026-05-07T22:00:00Z");
const b = getPeriodBounds("30d", undefined, undefined, NOW);
console.log(`Current : ${b.start.toISOString()} → ${b.end.toISOString()}`);
console.log(`Previous: ${b.prevStart.toISOString()} → ${b.prevEnd.toISOString()}\n`);

// Raw: prev median response time
const prevThreads = await prisma.thread.findMany({
  where: {
    shop: SHOP,
    firstMessageAt: { gte: b.prevStart, lt: b.prevEnd },
    supportNature: { in: ["confirmed_support", "probable_support"] },
  },
  select: { id: true, firstMessageAt: true },
});
const prevResp: number[] = [];
for (const t of prevThreads) {
  const msgs = await prisma.incomingEmail.findMany({
    where: { canonicalThreadId: t.id, shop: SHOP },
    orderBy: { receivedAt: "asc" },
    select: { receivedAt: true, processingStatus: true },
  });
  const earlyOut = msgs.find(m => m.processingStatus === "outgoing" && m.receivedAt <= t.firstMessageAt);
  if (earlyOut) continue;
  const firstOut = msgs.find(m => m.processingStatus === "outgoing" && m.receivedAt > t.firstMessageAt);
  if (!firstOut) continue;
  const ms = firstOut.receivedAt.getTime() - t.firstMessageAt.getTime();
  if (ms > 0) prevResp.push(ms);
}
prevResp.sort((a, b) => a - b);
function pctl(arr: number[], p: number) {
  if (!arr.length) return null;
  const pos = p * (arr.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? arr[lo] : arr[lo] + (pos - lo) * (arr[hi] - arr[lo]);
}
const prevMed = pctl(prevResp, 0.5);

// Raw: prev volume
const prevVol = await prisma.incomingEmail.count({
  where: {
    shop: SHOP, receivedAt: { gte: b.prevStart, lt: b.prevEnd }, processingStatus: { not: "outgoing" },
    OR: [
      { tier2Result: "support_client" },
      { thread: { supportNature: { in: ["confirmed_support", "probable_support"] } } },
    ],
  },
});

// Raw: prev reopened events
const prevReop = await prisma.threadStateHistory.count({
  where: {
    shop: SHOP, fromState: "resolved", NOT: { toState: "resolved" },
    changedAt: { gte: b.prevStart, lt: b.prevEnd },
  },
});

// Raw: prev draft buckets
const prevDrafts = await prisma.replyDraft.findMany({
  where: { shop: SHOP, createdAt: { gte: b.prevStart, lt: b.prevEnd } },
  select: { heuristicBucket: true },
});
const pb = { as_is: 0, edited: 0, ignored: 0 };
prevDrafts.forEach(d => {
  if (d.heuristicBucket === "as_is") pb.as_is++;
  else if (d.heuristicBucket === "edited") pb.edited++;
  else if (d.heuristicBucket === "ignored") pb.ignored++;
});
const prevDenom = pb.as_is + pb.edited + pb.ignored;
const prevPct = prevDenom > 0 ? Math.round((pb.as_is + pb.edited) / prevDenom * 100) : null;

console.log(`RAW prev period:`);
console.log(`  prevMedianMs: ${prevMed ? (prevMed / 3600000).toFixed(1) + "h" : "null"}  (${prevResp.length} samples)`);
console.log(`  prevVolume:   ${prevVol}`);
console.log(`  prevReopened: ${prevReop}`);
console.log(`  prevDrafts:   ${pb.as_is} / ${pb.edited} / ${pb.ignored}  → sentPct ${prevPct !== null ? prevPct + "%" : "null"}`);

// Dashboard
const k = await getDashboardKpis(SHOP, b.start, b.end, b.prevStart, b.prevEnd);
console.log(`\nDASHBOARD prev period:`);
console.log(`  prevMedianMs: ${k.responseTime.prevMedianMs ? (k.responseTime.prevMedianMs / 3600000).toFixed(1) + "h" : "null"}`);
console.log(`  prevVolume:   ${k.volume.prevCount}`);
console.log(`  prevReopened: ${k.reopened.prevCount}`);
console.log(`  prevSentPct:  ${k.draftUsage.prevSentPct !== null ? k.draftUsage.prevSentPct + "%" : "null"}`);

// Match check
const fmt = (a: number | null, b: number | null) => a === b ? "✓" : `✗ (${a} vs ${b})`;
console.log(`\nMatch:`);
console.log(`  median  : ${fmt(prevMed ? Math.round(prevMed) : null, k.responseTime.prevMedianMs ? Math.round(k.responseTime.prevMedianMs) : null)}`);
console.log(`  volume  : ${fmt(prevVol, k.volume.prevCount)}`);
console.log(`  reopened: ${fmt(prevReop, k.reopened.prevCount)}`);
console.log(`  draft   : ${fmt(prevPct, k.draftUsage.prevSentPct)}`);

process.exit(0);
