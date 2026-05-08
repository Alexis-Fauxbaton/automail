import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import { __resetCacheForTests } from '../../billing/entitlements';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
  // cleanTestShop does not remove Session rows — delete the offline session used
  // by seedShopWithDueSync so each test starts from a clean state.
  await testDb.session.deleteMany({ where: { shop: TEST_SHOP } });
  __resetCacheForTests();
});

vi.mock('../../../shopify.server', () => ({
  unauthenticated: {
    admin: vi.fn(),
  },
}));

vi.mock('../../mail/job-queue', () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
}));

async function seedShopWithDueSync(shop: string, installDate: Date) {
  await testDb.billingShopFlag.create({
    data: { shop, installDate },
  });
  await testDb.mailConnection.create({
    data: {
      shop,
      provider: 'gmail',
      email: 'a@b.c',
      accessToken: 'x',
      refreshToken: 'x',
      tokenExpiry: new Date(Date.now() + 86400000),
      autoSyncEnabled: true,
      autoSyncIntervalMinutes: 1,
      lastSyncAt: new Date(Date.now() - 5 * 60_000),
    },
  });
  await testDb.session.create({
    data: {
      id: `offline_${shop}`,
      shop,
      state: 'active',
      isOnline: false,
      accessToken: 'x',
    },
  });
}

describe('enqueueDuePeriodicSyncs — entitlement gating', () => {
  it('skips a suspended shop (trial_expired)', async () => {
    await seedShopWithDueSync(TEST_SHOP, new Date(Date.now() - 30 * 86400000));

    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({ data: { currentAppInstallation: { activeSubscriptions: [] } } }),
    });
    const { unauthenticated } = await import('../../../shopify.server');
    (unauthenticated.admin as any).mockResolvedValue({ admin: { graphql: adminGraphql } });

    const { enqueueJob } = await import('../../mail/job-queue');
    (enqueueJob as any).mockClear();

    const autoSync = await import('../../mail/auto-sync');
    await (autoSync as any).enqueueDuePeriodicSyncs();

    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('enqueues a healthy shop (trial_active)', async () => {
    await seedShopWithDueSync(TEST_SHOP, new Date(Date.now() - 2 * 86400000));

    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({ data: { currentAppInstallation: { activeSubscriptions: [] } } }),
    });
    const { unauthenticated } = await import('../../../shopify.server');
    (unauthenticated.admin as any).mockResolvedValue({ admin: { graphql: adminGraphql } });

    const { enqueueJob } = await import('../../mail/job-queue');
    (enqueueJob as any).mockClear();

    const autoSync = await import('../../mail/auto-sync');
    await (autoSync as any).enqueueDuePeriodicSyncs();

    expect(enqueueJob).toHaveBeenCalledWith(TEST_SHOP, 'sync');
  });
});
