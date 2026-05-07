import prisma from "../app/db.server.js";

const SHOP = "2ed20e.myshopify.com";
const now = new Date("2026-05-07T22:00:00Z");
const d30 = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
const d60 = new Date(now.getTime() - 60 * 24 * 3600 * 1000);
const d90 = new Date(now.getTime() - 90 * 24 * 3600 * 1000);

const openThreads = await prisma.thread.findMany({
  where: { shop: SHOP, operationalState: "open" },
  select: { id: true, lastMessageAt: true, supportNature: true, firstMessageAt: true },
  orderBy: { lastMessageAt: "desc" },
});

const last30 = openThreads.filter(t => t.lastMessageAt >= d30).length;
const last60 = openThreads.filter(t => t.lastMessageAt >= d60 && t.lastMessageAt < d30).length;
const last90 = openThreads.filter(t => t.lastMessageAt >= d90 && t.lastMessageAt < d60).length;
const older  = openThreads.filter(t => t.lastMessageAt < d90).length;

const byNature: Record<string, number> = {};
openThreads.forEach(t => { byNature[t.supportNature] = (byNature[t.supportNature] ?? 0) + 1; });

console.log(`Total open: ${openThreads.length}`);
console.log(`  Activité < 30j  : ${last30}`);
console.log(`  Activité 30-60j : ${last60}`);
console.log(`  Activité 60-90j : ${last90}`);
console.log(`  Activité > 90j  : ${older}`);
console.log("");
console.log("  Par supportNature:");
Object.entries(byNature).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${k}: ${v}`));

// Also check total threads by state
const allStates = await prisma.thread.groupBy({
  by: ["operationalState"],
  where: { shop: SHOP },
  _count: { _all: true },
});
console.log("");
console.log("Tous états (toutes périodes):");
allStates.sort((a, b) => b._count._all - a._count._all).forEach(r =>
  console.log(`  ${r.operationalState}: ${r._count._all}`)
);

process.exit(0);
