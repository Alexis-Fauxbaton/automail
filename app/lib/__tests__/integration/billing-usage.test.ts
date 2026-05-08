import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import {
  tryReserveDraft,
  releaseDraft,
  getUsage,
  getCurrentPeriodStart,
} from '../../billing/usage';

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

describe('tryReserveDraft / releaseDraft / getUsage', () => {
  it('first reserve creates a row at count=1', async () => {
    const result = await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newCount).toBe(1);
    }
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(1);
  });

  it('subsequent reserves increment monotonically', async () => {
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    const r3 = await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.newCount).toBe(3);
  });

  it('refuses reserve when limit reached', async () => {
    for (let i = 0; i < 5; i++) {
      await tryReserveDraft({ shop: TEST_SHOP, limit: 5 });
    }
    const r6 = await tryReserveDraft({ shop: TEST_SHOP, limit: 5 });
    expect(r6.ok).toBe(false);
    if (!r6.ok) expect(r6.reason).toBe('quota_exceeded');
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(5); // not incremented past limit
  });

  it('releaseDraft decrements the counter', async () => {
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    await releaseDraft({ shop: TEST_SHOP });
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(1);
  });

  it('releaseDraft never goes below 0', async () => {
    await releaseDraft({ shop: TEST_SHOP });
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(0);
  });

  it('isolates counters across shops', async () => {
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    await tryReserveDraft({ shop: 'other.myshopify.com', limit: 50 });
    await tryReserveDraft({ shop: 'other.myshopify.com', limit: 50 });

    const a = await getUsage(TEST_SHOP);
    const b = await getUsage('other.myshopify.com');
    expect(a.count).toBe(1);
    expect(b.count).toBe(2);

    // Cleanup other shop
    await testDb.billingUsage.deleteMany({ where: { shop: 'other.myshopify.com' } });
  });

  it('rolls over to a new period (different periodStart)', async () => {
    const may = new Date('2026-05-15T12:00:00Z');
    const june = new Date('2026-06-02T12:00:00Z');

    await tryReserveDraft({ shop: TEST_SHOP, limit: 50, now: may });
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50, now: may });
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50, now: june });

    const mayUsage = await getUsage(TEST_SHOP, may);
    const juneUsage = await getUsage(TEST_SHOP, june);
    expect(mayUsage.count).toBe(2);
    expect(juneUsage.count).toBe(1);
  });
});

describe('tryReserveDraft — race conditions', () => {
  it('two concurrent reserves at limit-1 result in one success and one quota_exceeded', async () => {
    // Pre-fill to 49/50
    for (let i = 0; i < 49; i++) {
      await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    }

    const [a, b] = await Promise.all([
      tryReserveDraft({ shop: TEST_SHOP, limit: 50 }),
      tryReserveDraft({ shop: TEST_SHOP, limit: 50 }),
    ]);

    const successes = [a, b].filter((r) => r.ok).length;
    const failures = [a, b].filter((r) => !r.ok).length;
    expect(successes).toBe(1);
    expect(failures).toBe(1);

    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(50); // exactly at limit
  });
});
