// app/lib/__tests__/integration/helpers/db.ts
import prisma from '../../../../db.server';

if (process.env.NODE_ENV !== 'test') {
  throw new Error('Integration tests must run with NODE_ENV=test');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must be set for integration tests');

// Use the same prisma instance the production code uses. This guarantees
// read-after-write consistency: dashboard helpers (which import prisma from
// db.server) see writes made via testDb because both go through the same
// connection pool.
export const testDb = prisma;

export const TEST_SHOP = 'integration-test.myshopify.com';

/** Deletes all data for the test shop. Never touches other shops' data. */
export async function cleanTestShop() {
  await testDb.$transaction(async (tx) => {
    await tx.llmCallLog.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.draftAttachment.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.replyDraft.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.incomingEmail.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.threadStateHistory.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.threadProviderId.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.thread.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.syncJob.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.billingUsage.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.billingScheduledChange.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.shopFlag.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.mailConnection.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.supportSettings.deleteMany({ where: { shop: TEST_SHOP } });
  });
}

/** Creates a minimal Thread for testing state transitions. */
export async function createTestThread(overrides: Partial<{
  operationalState: string;
  previousOperationalState: string;
  supportNature: string;
  lastMessageAt: Date;
  firstMessageAt: Date;
  operationalStateUpdatedAt: Date;
}> = {}) {
  return testDb.thread.create({
    data: {
      shop: TEST_SHOP,
      provider: 'gmail',
      lastMessageAt: new Date(),
      firstMessageAt: new Date(),
      operationalStateUpdatedAt: new Date(),
      operationalState: 'open',
      supportNature: 'unknown',
      historyStatus: 'complete',
      ...overrides,
    },
  });
}

/** Call in afterAll() to prevent Vitest from hanging on open DB connections. */
export async function disconnectTestDb() {
  await testDb.$disconnect();
}
