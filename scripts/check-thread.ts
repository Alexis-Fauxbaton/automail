import prisma from "../app/db.server.js";

const threadId = process.argv[2] ?? "cmovjufeq0006784ov3m1t5ya";

const thread = await prisma.thread.findUnique({
  where: { id: threadId },
});
console.log("Thread:", JSON.stringify(thread, null, 2));

const emails = await prisma.incomingEmail.findMany({
  where: { canonicalThreadId: threadId },
  orderBy: { receivedAt: "asc" },
  select: {
    id: true,
    externalMessageId: true,
    fromAddress: true,
    subject: true,
    receivedAt: true,
    processingStatus: true,
    tier1Result: true,
    tier2Result: true,
  },
});
console.log(`\n${emails.length} email(s) in thread:`);
for (const e of emails) {
  console.log(JSON.stringify(e, null, 2));
}

await prisma.$disconnect();
