import { getPeriodBounds, getAlerts, getTopIntentsWithPerf } from "../app/lib/dashboard-stats.js";

const SHOP = "2ed20e.myshopify.com";
const NOW = new Date("2026-05-07T22:00:00Z");

for (const range of ["24h", "7d", "30d"]) {
  const b = getPeriodBounds(range, undefined, undefined, NOW);
  const tops = await getTopIntentsWithPerf(SHOP, b.start, b.end, 8);
  const alerts = await getAlerts(SHOP, range, b.start, b.end, tops);
  console.log(`\n=== ${range} ===`);
  if (alerts.length === 0) console.log("  (no alerts)");
  alerts.forEach(a => console.log(`  [${a.type}] ${a.label}`));
}
process.exit(0);
