import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
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
  };
});

describe('handleRedraft — quota enforcement', () => {
  it('refuses when shop is at quota cap on Starter', async () => {
    await testDb.shopFlag.create({
      data: { shop: TEST_SHOP, installDate: new Date(Date.now() - 30 * 86400000) },
    });
    const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart, draftsCount: 50 },
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
