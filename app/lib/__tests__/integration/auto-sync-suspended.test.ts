// 2026-05-14 — entitlement gating moved from the scheduling loop into
// `runJob`. The scheduler now enqueues regardless of suspension state so a
// slow Shopify response on one shop can't serialise scheduling for the
// others; the worker that runs the job is responsible for honouring the
// suspension. This test file reflects that new contract.
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

async function seedShopWithDueSync(shop: string, firstInstallDate: Date) {
  await testDb.shopFlag.create({
    data: { shop, firstInstallDate },
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

describe('enqueueDuePeriodicSyncs', () => {
  it('enqueues a due shop regardless of billing state (gating moved to runJob)', async () => {
    // Old behaviour: scheduler skipped suspended shops, paying for a Shopify
    // GraphQL round-trip per shop inside the scheduling tick.
    // New behaviour: scheduler always enqueues. The job claims its slot via
    // SyncJob row + per-shop running-lock, then runJob performs the entitlement
    // check and short-circuits to markJobDone if the shop is suspended. This
    // keeps the scheduling loop O(1) per shop and bounded.
    await seedShopWithDueSync(TEST_SHOP, new Date(Date.now() - 30 * 86400000)); // trial expired

    const { enqueueJob } = await import('../../mail/job-queue');
    (enqueueJob as any).mockClear();

    const autoSync = await import('../../mail/auto-sync');
    await (autoSync as any).enqueueDuePeriodicSyncs();

    expect(enqueueJob).toHaveBeenCalledWith(TEST_SHOP, 'sync');
  });

  it('still enqueues a healthy shop (trial_active)', async () => {
    await seedShopWithDueSync(TEST_SHOP, new Date(Date.now() - 2 * 86400000));

    const { enqueueJob } = await import('../../mail/job-queue');
    (enqueueJob as any).mockClear();

    const autoSync = await import('../../mail/auto-sync');
    await (autoSync as any).enqueueDuePeriodicSyncs();

    expect(enqueueJob).toHaveBeenCalledWith(TEST_SHOP, 'sync');
  });

  it('does not enqueue when the offline Shopify session is missing', async () => {
    // Defensive: no Session row means the worker can't authenticate to Shopify
    // anyway. Scheduler keeps this fast-path filter (cheap DB check, no API).
    await testDb.shopFlag.create({
      data: { shop: TEST_SHOP, firstInstallDate: new Date() },
    });
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
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
    // Intentionally no Session row.

    const { enqueueJob } = await import('../../mail/job-queue');
    (enqueueJob as any).mockClear();

    const autoSync = await import('../../mail/auto-sync');
    await (autoSync as any).enqueueDuePeriodicSyncs();

    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
