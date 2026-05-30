// app/lib/__tests__/integration/helpers/db.ts
import type { MailConnection, Thread, IncomingEmail } from "@prisma/client";
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

/** Deletes all data for a given shop. Defaults to TEST_SHOP. Never touches other shops' data. */
export async function cleanTestShop(shop: string = TEST_SHOP) {
  await testDb.$transaction(async (tx) => {
    await tx.llmCallLog.deleteMany({ where: { shop } });
    await tx.draftAttachment.deleteMany({ where: { shop } });
    await tx.replyDraft.deleteMany({ where: { shop } });
    await tx.incomingEmail.deleteMany({ where: { shop } });
    await tx.threadStateHistory.deleteMany({ where: { shop } });
    await tx.threadProviderId.deleteMany({ where: { shop } });
    await tx.thread.deleteMany({ where: { shop } });
    await tx.syncJob.deleteMany({ where: { shop } });
    await tx.billingUsage.deleteMany({ where: { shop } });
    await tx.billingScheduledChange.deleteMany({ where: { shop } });
    await tx.shopFlag.deleteMany({ where: { shop } });
    await tx.mailConnection.deleteMany({ where: { shop } });
    await tx.supportSettings.deleteMany({ where: { shop } });
  });
}

/** Creates a minimal Thread for testing state transitions.
 *  A MailConnection is created inline when mailConnectionId is not provided. */
export async function createTestThread(overrides: Partial<{
  mailConnectionId: string;
  operationalState: string;
  previousOperationalState: string;
  supportNature: string;
  lastMessageAt: Date;
  firstMessageAt: Date;
  operationalStateUpdatedAt: Date;
  analyzedAt: Date;
  dismissedFromAnalyzeAt: Date;
}> = {}) {
  let mailConnectionId = overrides.mailConnectionId;
  if (!mailConnectionId) {
    const mc = await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        email: `auto-${Math.random().toString(36).slice(2, 8)}@test.com`,
        provider: 'gmail',
        accessToken: 'test-access',
        refreshToken: 'test-refresh',
        tokenExpiry: new Date(Date.now() + 3600_000),
      },
    });
    mailConnectionId = mc.id;
  }

  const { mailConnectionId: _omit, ...rest } = overrides;
  return testDb.thread.create({
    data: {
      shop: TEST_SHOP,
      mailConnectionId,
      provider: 'gmail',
      lastMessageAt: new Date(),
      firstMessageAt: new Date(),
      operationalStateUpdatedAt: new Date(),
      operationalState: 'open',
      supportNature: 'unknown',
      historyStatus: 'complete',
      ...rest,
    },
  });
}

// ---------------------------------------------------------------------------
// Multi-mailbox seeders
// ---------------------------------------------------------------------------

export async function seedMailConnection(opts: {
  shop?: string;
  email?: string;
  provider?: string;
  id?: string;
  /** CSV of OAuth scopes granted — used by canSend checks. */
  grantedScopes?: string;
}): Promise<MailConnection> {
  return prisma.mailConnection.create({
    data: {
      id: opts.id,
      shop: opts.shop ?? TEST_SHOP,
      email: opts.email ?? `box-${Math.random().toString(36).slice(2, 8)}@brand.com`,
      provider: opts.provider ?? 'gmail',
      accessToken: 'test-access',
      refreshToken: 'test-refresh',
      tokenExpiry: new Date(Date.now() + 3600_000),
      grantedScopes: opts.grantedScopes ?? null,
    },
  });
}

export async function seedThread(opts: {
  shop: string;
  mailConnectionId: string;
  receivedAt?: Date;
  supportNature?: string;
  operationalState?: string;
}): Promise<Thread> {
  const now = opts.receivedAt ?? new Date();
  return prisma.thread.create({
    data: {
      shop: opts.shop,
      mailConnectionId: opts.mailConnectionId,
      provider: 'gmail',
      firstMessageAt: now,
      lastMessageAt: now,
      supportNature: opts.supportNature ?? 'confirmed_support',
      operationalState: opts.operationalState ?? 'open',
    },
  });
}

export async function seedIncomingEmail(opts: {
  shop: string;
  mailConnectionId: string;
  canonicalThreadId: string;
  receivedAt?: Date;
  /** Override the RFC Message-ID stored on the row. */
  rfcMessageId?: string;
  fromAddress?: string;
  fromName?: string;
  subject?: string;
  bodyText?: string;
}): Promise<IncomingEmail> {
  return prisma.incomingEmail.create({
    data: {
      shop: opts.shop,
      mailConnectionId: opts.mailConnectionId,
      canonicalThreadId: opts.canonicalThreadId,
      externalMessageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
      threadId: `t-${Math.random().toString(36).slice(2, 8)}`,
      receivedAt: opts.receivedAt ?? new Date(),
      processingStatus: 'ingested',
      fromAddress: opts.fromAddress ?? 'customer@example.com',
      fromName: opts.fromName ?? '',
      subject: opts.subject ?? 'Test subject',
      bodyText: opts.bodyText ?? 'Test body',
      bodyHtml: '<p>Test body</p>',
      rfcMessageId: opts.rfcMessageId ?? `msg-${Math.random().toString(36).slice(2, 8)}@test.com`,
    },
  });
}

/** Alias for cleanTestShop(TEST_SHOP) — convenience for beforeEach hooks. */
export async function resetTestDb() {
  await cleanTestShop(TEST_SHOP);
}

/** Call in afterAll() to prevent Vitest from hanging on open DB connections. */
export async function disconnectTestDb() {
  await testDb.$disconnect();
}
