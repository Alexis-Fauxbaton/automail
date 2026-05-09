import prisma from "../app/db.server";

const shop = "e2e-test.myshopify.com";
const result = await prisma.mailConnection.delete({ where: { shop } });
console.log("Deleted:", result);
await prisma.$disconnect();
