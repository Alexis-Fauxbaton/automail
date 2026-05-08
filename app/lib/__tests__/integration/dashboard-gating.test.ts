import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import { __resetCacheForTests } from '../../billing/subscription';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
  __resetCacheForTests();
});

vi.mock('../../../shopify.server', () => ({
  authenticate: { admin: vi.fn() },
}));

describe('dashboard loader — Starter gating', () => {
  it('strips advanced data and clamps range to 7d', async () => {
    await testDb.billingShopFlag.create({
      data: { shop: TEST_SHOP, installDate: new Date(Date.now() - 30 * 86400000) },
    });

    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              {
                id: 'gid://1',
                name: 'starter',
                status: 'ACTIVE',
                trialDays: 14,
                createdAt: '2026-05-01T00:00:00Z',
                currentPeriodEnd: '2026-06-01T00:00:00Z',
              },
            ],
          },
        },
      }),
    });

    const { authenticate } = await import('../../../shopify.server');
    (authenticate.admin as any).mockResolvedValue({
      session: { shop: TEST_SHOP },
      admin: { graphql: adminGraphql },
    });

    const { loader } = await import('../../../routes/app.dashboard');
    const result = await loader({
      request: new Request('https://x/app/dashboard?range=90d'),
    } as any);

    const data = result instanceof Response ? await (result as any).json() : result;
    expect(data.isAdvancedDashboard).toBe(false);
    expect(data.heatmap).toEqual([]);
    expect(data.alerts).toEqual([]);
    expect(data.reopened).toEqual([]);
    expect(data.rangeMaxDays).toBe(7);
  });
});
