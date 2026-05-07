import prisma from "../app/db.server.js";

const rows = await prisma.incomingEmail.findMany({
  where: { id: "cmovjufso000k784ozkxj94p6" },
  take: 1,
  select: {
    id: true,
    shop: true,
    subject: true,
    fromAddress: true,
    receivedAt: true,
    threadId: true,
    canonicalThreadId: true,
    tier1Result: true,
    tier2Result: true,
    processingStatus: true,
    detectedIntent: true,
    lastAnalyzedAt: true,
    analysisResult: true,
    bodyText: true,
    bodyHtml: true,
    snippet: true,
    externalMessageId: true,
    errorMessage: true,
    rfcMessageId: true,
    inReplyTo: true,
    rfcReferences: true,
  },
});

console.log("Found", rows.length, "matching emails");
for (const r of rows) {
  console.log("---");
  console.log(JSON.stringify(r, null, 2));
  if (r.canonicalThreadId) {
    const t = await prisma.thread.findUnique({
      where: { id: r.canonicalThreadId },
      select: {
        id: true,
        supportNature: true,
        operationalState: true,
        previousOperationalState: true,
        operationalStateUpdatedAt: true,
        resolvedOrderNumber: true,
      },
    });
    console.log("Thread:", JSON.stringify(t, null, 2));
  } else {
    console.log("Thread: <no canonicalThreadId>");
  }
}
await prisma.$disconnect();
