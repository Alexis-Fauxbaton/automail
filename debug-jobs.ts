import prisma from "./app/db.server.ts";

async function main() {
  // Fix stuck jobs: pending with attempts >= MAX_ATTEMPTS can never be claimed
  const fixed = await prisma.syncJob.updateMany({
    where: { status: "pending", attempts: { gte: 3 } },
    data: { status: "error", finishedAt: new Date(), lastError: "Fixed: stuck pending job with exhausted attempts" },
  });
  if (fixed.count > 0) console.log(`Fixed ${fixed.count} stuck pending job(s).`);

  const jobs = await prisma.syncJob.findMany({
    where: {
      OR: [
        { status: { in: ["pending", "running"] } },
        { startedAt: { gt: new Date(Date.now() - 2 * 3600_000) } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      shop: true,
      kind: true,
      status: true,
      attempts: true,
      lastError: true,
      startedAt: true,
      nextRetryAt: true,
      createdAt: true,
    },
  });

  console.log(`\n=== SyncJob queue (${jobs.length} rows) ===`);
  for (const j of jobs) {
    console.log(
      `[${j.status.padEnd(7)}] ${j.kind.padEnd(9)} attempts=${j.attempts} ` +
      `startedAt=${j.startedAt?.toISOString() ?? "null"} ` +
      `nextRetry=${j.nextRetryAt?.toISOString() ?? "null"} ` +
      (j.lastError ? `\n  ERROR: ${j.lastError}` : ""),
    );
  }

  const conn = await prisma.mailConnection.findFirst({
    select: { shop: true, lastSyncAt: true, lastSyncError: true },
  });
  console.log("\n=== MailConnection ===");
  console.log(conn);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
