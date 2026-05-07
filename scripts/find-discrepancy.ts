import prisma from "../app/db.server.js";

const SHOP = "2ed20e.myshopify.com";
const NOW = new Date("2026-05-07T22:00:00Z");
const D30 = new Date(NOW.getTime() - 30 * 24 * 3600 * 1000);

// === VOLUME DISCREPANCY ===
console.log("=== Volume support: dashboard query vs raw ===\n");

// Dashboard query
const dashCount = await prisma.incomingEmail.count({
  where: {
    shop: SHOP,
    receivedAt: { gte: D30, lt: NOW },
    processingStatus: { not: "outgoing" },
    OR: [
      { tier2Result: "support_client" },
      { thread: { supportNature: { in: ["confirmed_support", "probable_support"] } } },
    ],
  },
});
console.log("Dashboard query count:", dashCount);

// All emails matching either condition (raw)
const allCandidates = await prisma.incomingEmail.findMany({
  where: { shop: SHOP, receivedAt: { gte: D30, lt: NOW }, processingStatus: { not: "outgoing" } },
  select: {
    id: true, receivedAt: true, tier2Result: true, canonicalThreadId: true,
    thread: { select: { supportNature: true } },
  },
});

const matching = allCandidates.filter(e =>
  e.tier2Result === "support_client" ||
  (e.thread?.supportNature === "confirmed_support" || e.thread?.supportNature === "probable_support")
);
console.log("Raw filtered (via thread relation):", matching.length);

// What if we use canonicalThreadId IN (support thread ids)?
const supportThreads = await prisma.thread.findMany({
  where: { shop: SHOP, supportNature: { in: ["confirmed_support", "probable_support"] } },
  select: { id: true },
});
const supSet = new Set(supportThreads.map(t => t.id));
const viaSet = allCandidates.filter(e =>
  e.tier2Result === "support_client" ||
  (e.canonicalThreadId !== null && supSet.has(e.canonicalThreadId))
);
console.log("Raw filtered (via thread id set):", viaSet.length);

// Show emails that match via set but NOT via relation (orphan canonicalThreadIds?)
const orphans = viaSet.filter(e =>
  !matching.find(m => m.id === e.id)
);
console.log("\nEmails matching via id set but not via thread relation:");
orphans.forEach(e => console.log(`  ${e.id} | canonicalThreadId=${e.canonicalThreadId} | tier2=${e.tier2Result}`));

// Inverse: emails that match via relation but not via set
const reverseOrphans = matching.filter(e =>
  !viaSet.find(v => v.id === e.id)
);
console.log("\nEmails matching via thread relation but not via id set:");
reverseOrphans.forEach(e => console.log(`  ${e.id} | canonicalThreadId=${e.canonicalThreadId} | thread.supportNature=${e.thread?.supportNature}`));

// === TOP INTENTS DISCREPANCY ===
console.log("\n\n=== Top intents: dashboard vs raw ===\n");

// Dashboard logic: threads with firstMessageAt in period + supportNature support
const dashIntents = await prisma.$queryRaw<{ intent: string; count: bigint }[]>`
  WITH latest_intent AS (
    SELECT DISTINCT ON (e."canonicalThreadId")
      e."canonicalThreadId", e."detectedIntent"
    FROM "IncomingEmail" e
    WHERE e.shop = ${SHOP}
      AND e."detectedIntent" IS NOT NULL
      AND e."canonicalThreadId" IS NOT NULL
      AND e."receivedAt" < ${NOW}
    ORDER BY e."canonicalThreadId", e."receivedAt" DESC
  )
  SELECT li."detectedIntent" AS intent, COUNT(*)::bigint AS count
  FROM "Thread" t
  JOIN latest_intent li ON li."canonicalThreadId" = t.id
  WHERE t.shop = ${SHOP}
    AND t."firstMessageAt" >= ${D30}
    AND t."firstMessageAt" < ${NOW}
    AND t."supportNature" IN ('confirmed_support', 'probable_support')
  GROUP BY li."detectedIntent"
  ORDER BY count DESC
`;
console.log("Dashboard intents (thread.firstMessageAt in period):");
dashIntents.forEach(r => console.log(`  ${r.intent}: ${r.count}`));

// Alternative: emails received in period
const altIntents = await prisma.$queryRaw<{ intent: string; count: bigint }[]>`
  WITH latest_intent AS (
    SELECT DISTINCT ON (e."canonicalThreadId")
      e."canonicalThreadId", e."detectedIntent"
    FROM "IncomingEmail" e
    JOIN "Thread" t ON t.id = e."canonicalThreadId"
    WHERE e.shop = ${SHOP}
      AND e."receivedAt" >= ${D30}
      AND e."receivedAt" < ${NOW}
      AND e."processingStatus" != 'outgoing'
      AND t."supportNature" IN ('confirmed_support', 'probable_support')
      AND e."detectedIntent" IS NOT NULL
    ORDER BY e."canonicalThreadId", e."receivedAt" DESC
  )
  SELECT intent, COUNT(*)::bigint AS count FROM (
    SELECT "detectedIntent" AS intent FROM latest_intent
  ) s
  GROUP BY intent ORDER BY count DESC
`;
console.log("\nRaw intents (emails received in period):");
altIntents.forEach(r => console.log(`  ${r.intent}: ${r.count}`));

process.exit(0);
