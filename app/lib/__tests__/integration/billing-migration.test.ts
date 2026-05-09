import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import { backfillBillingShopFlags } from '../../billing/migration';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
  await testDb.billingShopFlag.deleteMany({ where: { shop: { in: ['legacy-a.myshopify.com', 'legacy-b.myshopify.com'] } } });
  await testDb.session.deleteMany({ where: { shop: { in: ['legacy-a.myshopify.com', 'legacy-b.myshopify.com'] } } });
});

describe('backfillBillingShopFlags', () => {
  it('creates a BillingShopFlag for shops with a session but no flag', async () => {
    await testDb.session.create({
      data: {
        id: 'offline_legacy-a.myshopify.com',
        shop: 'legacy-a.myshopify.com',
        state: 'active',
        isOnline: false,
        accessToken: 'x',
      },
    });

    const created = await backfillBillingShopFlags();
    expect(created).toContain('legacy-a.myshopify.com');

    const flag = await testDb.billingShopFlag.findUnique({
      where: { shop: 'legacy-a.myshopify.com' },
    });
    expect(flag).not.toBeNull();
    expect(flag?.isInternal).toBe(false);

    await testDb.billingShopFlag.deleteMany({ where: { shop: 'legacy-a.myshopify.com' } });
    await testDb.session.deleteMany({ where: { shop: 'legacy-a.myshopify.com' } });
  });

  it('does not touch shops that already have a flag (idempotent)', async () => {
    const initial = new Date('2026-01-01T00:00:00Z');
    await testDb.session.create({
      data: {
        id: 'offline_legacy-b.myshopify.com',
        shop: 'legacy-b.myshopify.com',
        state: 'active',
        isOnline: false,
        accessToken: 'x',
      },
    });
    await testDb.billingShopFlag.create({
      data: { shop: 'legacy-b.myshopify.com', installDate: initial },
    });

    const created = await backfillBillingShopFlags();
    expect(created).not.toContain('legacy-b.myshopify.com');

    const flag = await testDb.billingShopFlag.findUnique({
      where: { shop: 'legacy-b.myshopify.com' },
    });
    expect(flag?.installDate.toISOString()).toBe(initial.toISOString());

    await testDb.billingShopFlag.deleteMany({ where: { shop: 'legacy-b.myshopify.com' } });
    await testDb.session.deleteMany({ where: { shop: 'legacy-b.myshopify.com' } });
  });

  it('returns empty array when nothing to backfill', async () => {
    const created = await backfillBillingShopFlags();
    expect(Array.isArray(created)).toBe(true);
  });
});
