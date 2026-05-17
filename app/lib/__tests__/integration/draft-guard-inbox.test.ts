import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb, createTestThread } from './helpers/db';
import { __resetCacheForTests } from '../../billing/entitlements';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
  __resetCacheForTests();
});

vi.mock('../../gmail/pipeline', async () => {
  const actual = await vi.importActual<typeof import('../../gmail/pipeline')>('../../gmail/pipeline');
  return {
    ...actual,
    redraftEmail: vi.fn().mockResolvedValue(undefined),
    reanalyzeEmail: vi.fn().mockResolvedValue({ draftReply: 'mocked' }),
  };
});

describe('handleRedraft — quota enforcement', () => {
  it('refuses when shop is at quota cap on Starter', async () => {
    await testDb.shopFlag.create({
      data: { shop: TEST_SHOP, firstInstallDate: new Date(Date.now() - 30 * 86400000) },
    });
    const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart, analyzedThreadsCount: 50 },
    });

    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
            ],
          },
        },
      }),
    });

    const { handleRedraft } = await import('../../support/inbox-actions');
    const result = await handleRedraft({
      shop: TEST_SHOP,
      emailId: 'fake-email-id',
      admin: { graphql: adminGraphql } as any,
    });

    expect((result as any).quotaExceeded).toBe(true);
    expect((result as any).quotaStatus.used).toBe(50);
    expect((result as any).quotaStatus.limit).toBe(50);
  });
});

describe('handleSync — Tier 3 suspension', () => {
  it('passes tier3Allowed=false to processNewEmails when state=trial_expired, returns syncSuspended:true', async () => {
    // firstInstallDate = 30 days ago → trial_expired → isSyncSuspended=true
    await testDb.shopFlag.create({
      data: { shop: TEST_SHOP, firstInstallDate: new Date(Date.now() - 30 * 86400000) },
    });
    // No mail connection: processNewEmails throws inside _processNewEmails
    // with "No mail connection for this shop". handleSync now CATCHES that
    // throw and returns a structured `{ syncError }` field so the UI doesn't
    // render a generic full-screen error page. Assert both: pipeline was
    // reached (tier3Allowed=false didn't gate upstream) AND error was caught.
    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({ data: { currentAppInstallation: { activeSubscriptions: [] } } }),
    });

    const { handleSync } = await import('../../support/inbox-actions');
    const result = await handleSync({
      shop: TEST_SHOP,
      admin: { graphql: adminGraphql } as any,
    });
    expect((result as any).syncSuspended).toBe(true);
    expect((result as any).syncError).toMatch(/No mail connection/);
    expect((result as any).syncCompleted).toBe(false);
    expect((result as any).report).toBeNull();
  });

});


describe('handleReanalyze — strict quota gate', () => {
  it('IS blocked under quota exceeded even on a previously-analyzed thread', async () => {
    // Strict policy: Tier 3 runs real LLM/Shopify calls; we refuse them under
    // any suspended state, even for threads that were analyzed earlier.
    await testDb.shopFlag.create({
      data: { shop: TEST_SHOP, firstInstallDate: new Date(Date.now() - 30 * 86400000) },
    });
    const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart, analyzedThreadsCount: 50 },
    });

    const thread = await createTestThread({});
    await testDb.thread.update({
      where: { id: thread.id },
      data: { analyzedAt: new Date() },
    });
    const email = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: 'ext-already-analyzed',
        threadId: 'tid',
        canonicalThreadId: thread.id,
        fromAddress: 'c@x.com',
        subject: 'S',
        bodyText: 'B',
        receivedAt: new Date(),
        processingStatus: 'analyzed',
      },
      select: { id: true },
    });

    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
            ],
          },
        },
      }),
    });

    const { handleReanalyze } = await import('../../support/inbox-actions');
    const result = await handleReanalyze({
      shop: TEST_SHOP,
      emailId: email.id,
      admin: { graphql: adminGraphql } as any,
      skipDraft: false,
    });

    expect((result as any).quotaExceeded).toBe(true);
    expect((result as any).reanalyzed).toBeNull();
  });

  it('IS blocked when quota is at 50/50 and the thread has never been analyzed', async () => {
    await testDb.shopFlag.create({
      data: { shop: TEST_SHOP, firstInstallDate: new Date(Date.now() - 30 * 86400000) },
    });
    const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart, analyzedThreadsCount: 50 },
    });

    const thread = await createTestThread({}); // analyzedAt stays null
    const email = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: 'ext-never-analyzed',
        threadId: 'tid',
        canonicalThreadId: thread.id,
        fromAddress: 'c@x.com',
        subject: 'S',
        bodyText: 'B',
        receivedAt: new Date(),
        processingStatus: 'ingested',
      },
      select: { id: true },
    });

    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
            ],
          },
        },
      }),
    });

    const { handleReanalyze } = await import('../../support/inbox-actions');
    const result = await handleReanalyze({
      shop: TEST_SHOP,
      emailId: email.id,
      admin: { graphql: adminGraphql } as any,
      skipDraft: false,
    });

    expect((result as any).quotaExceeded).toBe(true);
  });
});
