import prisma from "../app/db.server.js";
const SHOP = "2ed20e.myshopify.com";

const rows = await prisma.thread.groupBy({
  by: ["operationalState"],
  where: { shop: SHOP, supportNature: { not: "non_support" } },
  _count: { _all: true },
});
console.log("États (hors non_support):");
rows.sort((a, b) => b._count._all - a._count._all).forEach(r =>
  console.log(`  ${r.operationalState}: ${r._count._all}`)
);

const openBreakdown = await prisma.thread.groupBy({
  by: ["supportNature"],
  where: { shop: SHOP, operationalState: "open", supportNature: { not: "non_support" } },
  _count: { _all: true },
});
console.log("\nOpen par nature (hors non_support):");
openBreakdown.forEach(r => console.log(`  ${r.supportNature}: ${r._count._all}`));
process.exit(0);
