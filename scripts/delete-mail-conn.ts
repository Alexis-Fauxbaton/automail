import prisma from "../app/db.server";

const shop = "e2e-test.myshopify.com";
const conn = await prisma.mailConnection.findFirst({ where: { shop } });
if (!conn) { console.log("No connection found"); process.exit(1); }
const result = await prisma.mailConnection.delete({ where: { id: conn.id } });
console.log("Deleted:", result);
await prisma.$disconnect();
