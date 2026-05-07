import prisma from "../app/db.server.js";
const SHOP = "2ed20e.myshopify.com";
const r = await prisma.thread.groupBy({
  by: ["operationalState", "supportNature"],
  where: { shop: SHOP },
  _count: { _all: true },
});
r.sort((a, b) => a.operationalState.localeCompare(b.operationalState)).forEach(x =>
  console.log(x.operationalState.padEnd(24) + x.supportNature.padEnd(24) + x._count._all)
);
process.exit(0);
