import prisma from "./app/db.server";

async function main() {
  const conns = await prisma.mailConnection.findMany();
  console.log("Mail connections:");
  conns.forEach((c) => {
    console.log(`  - Shop: ${c.shop}, Provider: ${c.provider}, Email: ${c.email}`);
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
