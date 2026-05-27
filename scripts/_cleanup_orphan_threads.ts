/**
 * One-shot cleanup: delete Thread rows that have no IncomingEmail attached.
 * Caused by the pre-fix ingest bug (post-migration ingest created Thread but
 * IncomingEmail.create failed silently because mailConnectionId was missing).
 *
 * Run AFTER the pipeline fix is deployed, so the bug doesn't re-create more.
 *
 * Usage:
 *   DATABASE_URL=<prod> DIRECT_URL=<prod-direct> npx tsx scripts/_cleanup_orphan_threads.ts
 *
 * Then trigger a resync for each affected mailbox from /app/connections so
 * the historical messages (since onboardingBackfillDoneAt) get re-ingested.
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const orphans = await prisma.thread.findMany({
    where: { messages: { none: {} } },
    select: { id: true, shop: true, mailConnectionId: true },
  });
  console.log(`Found ${orphans.length} orphan Thread rows.`);
  const byMailbox: Record<string, number> = {};
  for (const o of orphans) {
    byMailbox[o.mailConnectionId] = (byMailbox[o.mailConnectionId] ?? 0) + 1;
  }
  console.log("By mailConnectionId:", byMailbox);

  if (process.env.APPLY !== "1") {
    console.log("Dry-run. Re-run with APPLY=1 to actually delete.");
    return;
  }
  const result = await prisma.thread.deleteMany({
    where: { messages: { none: {} } },
  });
  console.log(`Deleted ${result.count} orphan Threads.`);
}
main().finally(() => prisma.$disconnect());
