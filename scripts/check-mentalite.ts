import prisma from "../app/db.server.js";

const rows = await prisma.incomingEmail.findMany({
  where: {
    shop: "2ed20e.myshopify.com",
    receivedAt: { gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
  },
  orderBy: { receivedAt: "desc" },
  take: 10,
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
