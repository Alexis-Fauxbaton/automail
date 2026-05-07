import { getPeriodBounds, getResponseTimeDailyBreakdown, getDashboardKpis } from "../app/lib/dashboard-stats.js";

const SHOP = "2ed20e.myshopify.com";
const NOW = new Date("2026-05-07T22:00:00Z");
const b = getPeriodBounds("30d", undefined, undefined, NOW);

const [chart, kpis] = await Promise.all([
  getResponseTimeDailyBreakdown(SHOP, b.start, b.end),
  getDashboardKpis(SHOP, b.start, b.end, b.prevStart, b.prevEnd),
]);

const sumSupport = chart.reduce((s, p) => s + p.support, 0);
console.log(`Volume KPI       : ${kpis.volume.count}`);
console.log(`Chart sum support: ${sumSupport}`);
console.log(`Match: ${sumSupport === kpis.volume.count ? "✓ YES" : "✗ NO"}`);
console.log("");
const nonZero = chart.filter(p => p.support > 0 || p.medianMs !== null);
console.log(`Days with data: ${nonZero.length}`);
nonZero.forEach(p => console.log(`  ${p.date}: support=${p.support}, median=${p.medianMs ? (p.medianMs / 3600000).toFixed(1) + "h" : "—"}`));

process.exit(0);
