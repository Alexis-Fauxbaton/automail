import prisma from "../app/db.server.js";

const SHOP = "2ed20e.myshopify.com";
const NOW = new Date("2026-05-07T22:00:00Z");
const D30 = new Date(NOW.getTime() - 30 * 24 * 3600 * 1000);

// Find threads with activity in period but firstMessageAt before
const r = await prisma.$queryRaw<{ id: string; first: Date; last: Date }[]>`
  SELECT t.id, t."firstMessageAt" AS first, t."lastMessageAt" AS last
  FROM "Thread" t
  WHERE t.shop = ${SHOP}
    AND t."supportNature" IN ('confirmed_support', 'probable_support')
    AND t."firstMessageAt" < ${D30}
    AND EXISTS (
      SELECT 1 FROM "IncomingEmail" e
      WHERE e."canonicalThreadId" = t.id
        AND e."receivedAt" >= ${D30}
        AND e."receivedAt" < ${NOW}
        AND e."processingStatus" != 'outgoing'
    )
`;
console.log("Threads with email activity in period but created before:", r.length);

for (const t of r) {
  const emails = await prisma.incomingEmail.findMany({
    where: { canonicalThreadId: t.id, receivedAt: { gte: D30, lt: NOW } },
    select: { detectedIntent: true, receivedAt: true, processingStatus: true },
  });
  const intents = [...new Set(emails.map(e => e.detectedIntent).filter(Boolean))];
  console.log(`  ${t.id} | first=${t.first.toISOString().slice(0, 10)} | emails=${emails.length} | intents=${intents.join(",") || "(none)"}`);
}
process.exit(0);
