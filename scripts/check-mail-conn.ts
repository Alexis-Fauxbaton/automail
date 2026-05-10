/**
 * Quick diagnostic: dump non-secret fields of MailConnection rows
 * to see what `provider` is actually stored as.
 */
import prisma from "../app/db.server";

const rows = await prisma.mailConnection.findMany({
  select: {
    shop: true,
    provider: true,
    email: true,
    tokenExpiry: true,
    historyId: true,
    deltaToken: true,
    zohoAccountId: true,
    onboardingBackfillDoneAt: true,
    autoSyncEnabled: true,
    lastSyncAt: true,
    lastSyncError: true,
    createdAt: true,
  },
});

for (const r of rows) {
  console.log(JSON.stringify({
    ...r,
    hasHistoryId: !!r.historyId,
    hasDeltaToken: !!r.deltaToken,
    historyId: undefined,
    deltaToken: undefined,
  }, null, 2));
}

await prisma.$disconnect();
