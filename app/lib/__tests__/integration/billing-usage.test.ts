import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import { getUsage, getCurrentPeriodStart } from '../../billing/usage';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
});

describe('getCurrentPeriodStart', () => {
  it('returns the 1st of the current month at 00:00:00 UTC', () => {
    const now = new Date('2026-05-15T13:42:00Z');
    const result = getCurrentPeriodStart(now);
    expect(result.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('handles January correctly', () => {
    const now = new Date('2026-01-31T23:59:59Z');
    const result = getCurrentPeriodStart(now);
    expect(result.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('getUsage', () => {
  it('returns count=0 when no row exists for the period', async () => {
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(0);
    expect(usage.shop).toBe(TEST_SHOP);
  });

  it('returns the stored count for the current period', async () => {
    const periodStart = getCurrentPeriodStart();
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart, analyzedThreadsCount: 7 },
    });
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(7);
  });

  it('isolates counters across shops', async () => {
    const periodStart = getCurrentPeriodStart();
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart, analyzedThreadsCount: 3 },
    });
    await testDb.billingUsage.create({
      data: { shop: 'other.myshopify.com', periodStart, analyzedThreadsCount: 9 },
    });

    const a = await getUsage(TEST_SHOP);
    const b = await getUsage('other.myshopify.com');
    expect(a.count).toBe(3);
    expect(b.count).toBe(9);

    await testDb.billingUsage.deleteMany({ where: { shop: 'other.myshopify.com' } });
  });

  it('returns the count for the requested period', async () => {
    const may = new Date('2026-05-15T12:00:00Z');
    const june = new Date('2026-06-02T12:00:00Z');

    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: getCurrentPeriodStart(may),
        analyzedThreadsCount: 2,
      },
    });
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: getCurrentPeriodStart(june),
        analyzedThreadsCount: 1,
      },
    });

    const mayUsage = await getUsage(TEST_SHOP, may);
    const juneUsage = await getUsage(TEST_SHOP, june);
    expect(mayUsage.count).toBe(2);
    expect(juneUsage.count).toBe(1);
  });
});
