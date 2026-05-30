import prisma from "../app/db.server.js";
import {
  getPeriodBounds, getDashboardKpis, getResponseTimeDailyBreakdown,
  getTopIntentsWithPerf, getCurrentThreadStates, getReopenedThreads,
  getHeatmap,
} from "../app/lib/dashboard-stats.js";

const SHOP = "2ed20e.myshopify.com";
const NOW = new Date("2026-05-07T22:00:00Z");

for (const range of ["24h", "7d", "30d", "90d"]) {
  const b = getPeriodBounds(range, undefined, undefined, NOW);
  console.log(`\n========= ${range} (${b.start.toISOString().slice(0, 10)} → ${b.end.toISOString().slice(0, 10)}) =========`);

  const [kpi, chart, heat, intents, states, reop] = await Promise.all([
    getDashboardKpis(SHOP, b.start, b.end, b.prevStart, b.prevEnd),
    getResponseTimeDailyBreakdown(SHOP, b.start, b.end),
    getHeatmap(SHOP, b.start, b.end),
    getTopIntentsWithPerf(SHOP, b.start, b.end, 8),
    getCurrentThreadStates(SHOP),
    getReopenedThreads(SHOP, b.start, b.end, 10),
  ]);

  // Raw checks
  const rawVolume = await prisma.incomingEmail.count({
    where: {
      shop: SHOP, receivedAt: { gte: b.start, lt: b.end }, processingStatus: { not: "outgoing" },
      OR: [
        { tier2Result: "support_client" },
        { thread: { supportNature: { in: ["confirmed_support", "probable_support"] } } },
      ],
    },
  });
  const heatSum = heat.reduce((s, c) => s + c.count, 0);
  const chartSum = chart.reduce((s, p) => s + p.support, 0);

  // Internal consistency
  const checks: Array<[string, boolean, string]> = [
    ["KPI volume == raw", kpi.volume.count === rawVolume, `${kpi.volume.count}/${rawVolume}`],
    ["KPI volume == chart sum", kpi.volume.count === chartSum, `${kpi.volume.count}/${chartSum}`],
    ["KPI volume == heatmap sum", kpi.volume.count === heatSum, `${kpi.volume.count}/${heatSum}`],
    ["No intent has count=0", intents.every(i => i.count > 0), `${intents.length} intents`],
    ["Reopened list count <= KPI", reop.length <= kpi.reopened.count, `${reop.length}/${kpi.reopened.count}`],
  ];

  console.log(`  Volume KPI: ${kpi.volume.count} (prev ${kpi.volume.prevCount}) | Median: ${kpi.responseTime.medianMs ? (kpi.responseTime.medianMs / 3600000).toFixed(1) + "h" : "—"}`);
  console.log(`  Reopened: ${kpi.reopened.count}`);
  console.log(`  Top intents: ${intents.length} | Reopened list: ${reop.length} | Daily chart days: ${chart.length}`);
  checks.forEach(([name, pass, val]) => console.log(`  ${pass ? "✓" : "✗"} ${name}: ${val}`));
}

process.exit(0);
