import prisma from "../app/db.server.js";
import { getPeriodBounds, getDashboardKpis, getCurrentThreadStates, getResponseTimeDailyBreakdown, getTopIntentsWithPerf, getReopenedThreads, getHeatmap, getDraftUsageDailyBreakdown, getAlerts } from "../app/lib/dashboard-stats.js";

const SHOP = "2ed20e.myshopify.com";

// 1. Emails without canonicalThreadId
const orphans = await prisma.incomingEmail.count({
  where: { shop: SHOP, canonicalThreadId: null, processingStatus: { not: "outgoing" } },
});
const orphansSupport = await prisma.incomingEmail.count({
  where: {
    shop: SHOP, canonicalThreadId: null, processingStatus: { not: "outgoing" },
    tier2Result: "support_client",
  },
});
console.log(`Emails sans canonicalThreadId: ${orphans} (dont ${orphansSupport} classifiés support)`);

// 2. Threads with messageCount mismatched (cached vs real)
const sample = await prisma.thread.findMany({
  where: { shop: SHOP }, take: 5,
  select: { id: true, messageCount: true },
});
for (const t of sample) {
  const real = await prisma.incomingEmail.count({ where: { canonicalThreadId: t.id } });
  if (real !== t.messageCount) console.log(`  Mismatch: ${t.id} cached=${t.messageCount} real=${real}`);
}

// 3. Empty shop (no data)
const EMPTY_SHOP = "this-shop-does-not-exist.myshopify.com";
const NOW = new Date("2026-05-07T22:00:00Z");
const b = getPeriodBounds("30d", undefined, undefined, NOW);

console.log("\n=== Empty shop test ===");
const [k, c, h, i, s, r, d] = await Promise.all([
  getDashboardKpis(EMPTY_SHOP, b.start, b.end, b.prevStart, b.prevEnd),
  getResponseTimeDailyBreakdown(EMPTY_SHOP, b.start, b.end),
  getHeatmap(EMPTY_SHOP, b.start, b.end),
  getTopIntentsWithPerf(EMPTY_SHOP, b.start, b.end, 5),
  getCurrentThreadStates(EMPTY_SHOP),
  getReopenedThreads(EMPTY_SHOP, b.start, b.end, 10),
  getDraftUsageDailyBreakdown(EMPTY_SHOP, b.start, b.end),
]);
const a = await getAlerts(EMPTY_SHOP, "30d", b.start, b.end, i);
console.log(`  KPIs: vol=${k.volume.count}, med=${k.responseTime.medianMs}, reop=${k.reopened.count}`);
console.log(`  Chart len: ${c.length}, all support=0: ${c.every(p => p.support === 0)}`);
console.log(`  Heatmap len: ${h.length}, intents: ${i.length}, reopened: ${r.length}`);
console.log(`  States: open=${s.open}, all 0: ${[s.open, s.waiting_customer, s.waiting_merchant, s.resolved, s.no_reply_needed].every(v => v === 0)}`);
console.log(`  Drafts daily: ${d.length}, all 0: ${d.every(p => p.as_is + p.edited + p.ignored === 0)}`);
console.log(`  Alerts: ${a.length}`);

// 4. Median with 0 samples
console.log("\n=== Sanity: percentile of empty ===");
console.log(`  Should be null: ${k.responseTime.medianMs === null ? "✓" : "✗"}`);

process.exit(0);
