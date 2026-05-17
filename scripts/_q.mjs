import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const res = await p.$executeRawUnsafe(`
  UPDATE "IncomingEmail"
  SET "processingStatus" = 'ingested',
      "tier1Result" = NULL,
      "tier2Result" = NULL,
      "analysisResult" = NULL,
      "detectedIntent" = NULL,
      "analysisConfidence" = NULL,
      "lastAnalyzedAt" = NULL
  WHERE shop = '2ed20e.myshopify.com'
    AND "processingStatus" IN ('outgoing', 'classified')
    AND LOWER("fromAddress") != 'info@ambienthome.fr';
`);
console.log(`rows updated: ${res}`);
await p.$disconnect();
