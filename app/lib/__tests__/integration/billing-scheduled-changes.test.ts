import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import {
  scheduleDowngrade,
  cancelScheduledChange,
  getPendingChange,
  listDueChanges,
  markApplied,
} from '../../billing/scheduled-changes';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
});

describe('scheduleDowngrade', () => {
  it('creates a pending change row', async () => {
    const effectiveAt = new Date('2026-06-01T00:00:00Z');
    const change = await scheduleDowngrade({
      shop: TEST_SHOP,
      fromPlan: 'pro',
      toPlan: 'starter',
      effectiveAt,
    });

    expect(change.fromPlan).toBe('pro');
    expect(change.toPlan).toBe('starter');
    expect(change.effectiveAt.toISOString()).toBe(effectiveAt.toISOString());
    expect(change.appliedAt).toBeNull();
    expect(change.cancelledAt).toBeNull();
  });

  it('cancels any prior pending change for the same shop before creating a new one', async () => {
    const dateA = new Date('2026-06-01T00:00:00Z');
    const dateB = new Date('2026-07-01T00:00:00Z');

    const a = await scheduleDowngrade({
      shop: TEST_SHOP, fromPlan: 'pro', toPlan: 'starter', effectiveAt: dateA,
    });
    const b = await scheduleDowngrade({
      shop: TEST_SHOP, fromPlan: 'pro', toPlan: 'starter', effectiveAt: dateB,
    });

    const aReloaded = await testDb.billingScheduledChange.findUnique({ where: { id: a.id } });
    expect(aReloaded?.cancelledAt).not.toBeNull();

    const pending = await getPendingChange(TEST_SHOP);
    expect(pending?.id).toBe(b.id);
  });
});

describe('cancelScheduledChange', () => {
  it('marks the pending change as cancelled', async () => {
    const change = await scheduleDowngrade({
      shop: TEST_SHOP, fromPlan: 'pro', toPlan: 'starter',
      effectiveAt: new Date('2026-06-01T00:00:00Z'),
    });

    await cancelScheduledChange(TEST_SHOP);

    const reloaded = await testDb.billingScheduledChange.findUnique({ where: { id: change.id } });
    expect(reloaded?.cancelledAt).not.toBeNull();

    const pending = await getPendingChange(TEST_SHOP);
    expect(pending).toBeNull();
  });
});

describe('getPendingChange', () => {
  it('returns null when nothing is scheduled', async () => {
    const result = await getPendingChange(TEST_SHOP);
    expect(result).toBeNull();
  });

  it('ignores already-applied changes', async () => {
    const change = await scheduleDowngrade({
      shop: TEST_SHOP, fromPlan: 'pro', toPlan: 'starter',
      effectiveAt: new Date('2026-06-01T00:00:00Z'),
    });
    await markApplied(change.id);
    const pending = await getPendingChange(TEST_SHOP);
    expect(pending).toBeNull();
  });
});

describe('listDueChanges', () => {
  it('returns only changes whose effectiveAt is <= now and not yet applied or cancelled', async () => {
    const past = new Date('2026-04-01T00:00:00Z');
    const future = new Date('2026-12-01T00:00:00Z');

    const due = await scheduleDowngrade({
      shop: TEST_SHOP, fromPlan: 'pro', toPlan: 'starter', effectiveAt: past,
    });
    await scheduleDowngrade({
      shop: 'other.myshopify.com', fromPlan: 'pro', toPlan: 'starter', effectiveAt: future,
    });

    const now = new Date('2026-05-08T00:00:00Z');
    const list = await listDueChanges(now);
    expect(list.map((c) => c.id)).toContain(due.id);
    expect(list.map((c) => c.shop)).not.toContain('other.myshopify.com');

    // Cleanup
    await testDb.billingScheduledChange.deleteMany({ where: { shop: 'other.myshopify.com' } });
  });
});
