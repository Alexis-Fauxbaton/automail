import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import {
  resolveEntitlements,
  __resetCacheForTests,
} from '../../billing/entitlements';

const DAY_MS = 24 * 60 * 60 * 1000;

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
  __resetCacheForTests();
});

function makeAdmin(activeSubscriptions: any[]) {
  return {
    graphql: vi.fn().mockResolvedValue({
      json: async () => ({
        data: { currentAppInstallation: { activeSubscriptions } },
      }),
    }),
  };
}

async function setInstallDate(shop: string, installDate: Date) {
  await testDb.billingShopFlag.upsert({
    where: { shop },
    create: { shop, installDate },
    update: { installDate },
  });
}

describe('resolveEntitlements — trial active, no subscription', () => {
  it('grants pro-level access during trial', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 2 * DAY_MS));

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([]) as any,
      now,
    });

    expect(ent.state).toBe('trial_active');
    expect(ent.planId).toBe('trial');
    expect(ent.canGenerateDraft).toBe(true);
    expect(ent.canConnectMailbox).toBe(true);
    expect(ent.canViewAdvancedDashboard).toBe(true);
    expect(ent.trialDaysRemaining).toBe(12);
    expect(ent.quotaStatus.limit).toBe(Infinity);
  });
});

describe('resolveEntitlements — trial expired, no subscription', () => {
  it('blocks all writes', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([]) as any,
      now,
    });

    expect(ent.state).toBe('trial_expired');
    expect(ent.canGenerateDraft).toBe(false);
    expect(ent.canConnectMailbox).toBe(false);
    expect(ent.canViewAdvancedDashboard).toBe(false);
  });
});

describe('resolveEntitlements — starter active', () => {
  it('reports starter limits', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([
        { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
      ]) as any,
      now,
    });

    expect(ent.state).toBe('paid_active');
    expect(ent.planId).toBe('starter');
    expect(ent.quotaStatus.limit).toBe(50);
    expect(ent.canViewAdvancedDashboard).toBe(false);
  });

  it('flags warning at 80%', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date('2026-05-01T00:00:00Z'),
        draftsCount: 40, // 40/50 = 80%
      },
    });

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([
        { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
      ]) as any,
      now,
    });

    expect(ent.quotaStatus.level).toBe('warning');
    expect(ent.canGenerateDraft).toBe(true);
  });

  it('blocks generation at 100%', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date('2026-05-01T00:00:00Z'),
        draftsCount: 50,
      },
    });

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([
        { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
      ]) as any,
      now,
    });

    expect(ent.quotaStatus.level).toBe('exceeded');
    expect(ent.canGenerateDraft).toBe(false);
  });
});

describe('resolveEntitlements — internal flag bypass', () => {
  it('grants pro-level entitlements when isInternal=true regardless of plan', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await testDb.billingShopFlag.create({
      data: { shop: TEST_SHOP, isInternal: true, installDate: new Date(now.getTime() - 30 * DAY_MS) },
    });

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([]) as any, // no subscription, no trial
      now,
    });

    expect(ent.state).toBe('internal');
    expect(ent.canGenerateDraft).toBe(true);
    expect(ent.canConnectMailbox).toBe(true);
    expect(ent.canViewAdvancedDashboard).toBe(true);
  });
});

describe('resolveEntitlements — mailbox quota', () => {
  it('canConnectMailbox=false when starter has 1 mailbox connected', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        email: 'a@example.com',
        accessToken: 'x',
        refreshToken: 'x',
        tokenExpiry: new Date(),
      },
    });

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([
        { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
      ]) as any,
      now,
    });

    expect(ent.canConnectMailbox).toBe(false);
    expect(ent.mailboxStatus.used).toBe(1);
    expect(ent.mailboxStatus.limit).toBe(1);
  });
});
