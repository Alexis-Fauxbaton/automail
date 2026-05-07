import prisma from "../app/db.server.js";
const SHOP = "2ed20e.myshopify.com";
const non = await prisma.incomingEmail.count({
  where: { shop: SHOP, detectedIntent: { not: null }, thread: { supportNature: "non_support" } },
});
const sup = await prisma.incomingEmail.count({
  where: { shop: SHOP, detectedIntent: { not: null }, thread: { supportNature: { in: ["confirmed_support", "probable_support"] } } },
});
const unk = await prisma.incomingEmail.count({
  where: { shop: SHOP, detectedIntent: { not: null }, thread: { supportNature: "unknown" } },
});
console.log("Emails with detectedIntent:");
console.log("  non_support :", non);
console.log("  unknown     :", unk);
console.log("  support     :", sup);
process.exit(0);
