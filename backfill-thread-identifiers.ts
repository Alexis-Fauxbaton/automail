// One-shot backfill: run per-message extraction + thread merge on
// existing canonical threads. Safe to re-run (idempotent).

import prisma from "./app/db.server.ts";
import { extractAndCache, mergeThreadIdentifiers } from "./app/lib/support/thread-identifiers.ts";

const emails = await prisma.incomingEmail.findMany({
  where: { processingStatus: { notIn: ["outgoing"] } },
  select: { id: true, subject: true, bodyText: true, canonicalThreadId: true, shop: true },
});

console.log(`Extracting identifiers for ${emails.length} messages...`);
for (const e of emails) {
  await extractAndCache(e.id, e.subject, e.bodyText);
}

const threadShopMap = new Map<string, string>();
for (const e of emails) {
  if (e.canonicalThreadId && !threadShopMap.has(e.canonicalThreadId)) {
    threadShopMap.set(e.canonicalThreadId, e.shop);
  }
}
const canonicalIds = Array.from(threadShopMap.keys());
console.log(`Merging identifiers for ${canonicalIds.length} threads...`);
for (const id of canonicalIds) {
  await mergeThreadIdentifiers(id, threadShopMap.get(id)!);
}

const resolved = await prisma.thread.count({
  where: { resolvedOrderNumber: { not: null } },
});
console.log(`Done. ${resolved}/${canonicalIds.length} threads have a resolved order number.`);
await prisma.$disconnect();
