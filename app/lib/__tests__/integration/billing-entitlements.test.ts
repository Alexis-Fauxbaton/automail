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

async function setInstallDate(shop: string, firstInstallDate: Date) {
  await testDb.shopFlag.upsert({
    where: { shop },
    create: { shop, firstInstallDate },
    update: { firstInstallDate },
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

  it('reports real used count during trial', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 2 * DAY_MS));
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date('2026-05-01T00:00:00Z'),
        analyzedThreadsCount: 7,
      },
    });

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([]) as any,
      now,
    });

    expect(ent.state).toBe('trial_active');
    expect(ent.quotaStatus.used).toBe(7);
    expect(ent.quotaStatus.limit).toBe(Infinity);
  });
});

describe('resolveEntitlements — trial expired, no subscription', () => {
  it('blocks Tier 3 + dashboard, but allows connecting a first mailbox', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([]) as any,
      now,
    });

    expect(ent.state).toBe('trial_expired');
    expect(ent.canGenerateDraft).toBe(false);
    expect(ent.canViewAdvancedDashboard).toBe(false);
    // Mailbox connect remains allowed under trial_expired (1 mailbox cap)
    // so merchants can still see their data and Tier 1+2 classification.
    // Only Tier 3 / draft generation is gated.
    expect(ent.canConnectMailbox).toBe(true);
    expect(ent.mailboxStatus.limit).toBe(1);
    expect(ent.isSyncSuspended).toBe(true);
  });

  it('refuses a SECOND mailbox under trial_expired', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    // Seed one mailbox already.
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        email: 'one@example.com',
        accessToken: 'a',
        refreshToken: 'r',
        tokenExpiry: new Date(now.getTime() + 3600_000),
      },
    });

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([]) as any,
      now,
    });
    expect(ent.canConnectMailbox).toBe(false);
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
        analyzedThreadsCount: 40, // 40/50 = 80%
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
        analyzedThreadsCount: 50,
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

  it('flags critical at 95%', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date('2026-05-01T00:00:00Z'),
        analyzedThreadsCount: 48, // 48/50 = 96% → critical
      },
    });

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([
        { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
      ]) as any,
      now,
    });

    expect(ent.quotaStatus.level).toBe('critical');
    expect(ent.canGenerateDraft).toBe(true);
  });
});

describe('resolveEntitlements — internal flag bypass', () => {
  it('grants pro-level entitlements when isInternal=true regardless of plan', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await testDb.shopFlag.create({
      data: { shop: TEST_SHOP, isInternal: true, firstInstallDate: new Date(now.getTime() - 30 * DAY_MS) },
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

describe('resolveEntitlements — first-touch (no BillingShopFlag yet)', () => {
  it('creates the flag with firstInstallDate=now and starts trial', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    // No setInstallDate call — shop has nothing yet
    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([]) as any,
      now,
    });
    expect(ent.state).toBe('trial_active');
    expect(ent.trialDaysRemaining).toBe(14);

    // Verify the flag was created
    const flag = await testDb.shopFlag.findUnique({ where: { shop: TEST_SHOP } });
    expect(flag).not.toBeNull();
    expect(flag?.firstInstallDate.toISOString()).toBe(now.toISOString());
    expect(flag?.isInternal).toBe(false);
  });

  it('handles concurrent first-touch without unique-constraint violation', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    const [a, b] = await Promise.all([
      resolveEntitlements({ shop: TEST_SHOP, admin: makeAdmin([]) as any, now }),
      resolveEntitlements({ shop: TEST_SHOP, admin: makeAdmin([]) as any, now }),
    ]);
    expect(a.state).toBe('trial_active');
    expect(b.state).toBe('trial_active');
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

describe('resolveEntitlements — isSyncSuspended', () => {
  it('false during trial_active', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 2 * DAY_MS));
    const ent = await resolveEntitlements({ shop: TEST_SHOP, admin: makeAdmin([]) as any, now });
    expect(ent.isSyncSuspended).toBe(false);
  });

  it('true when trial_expired', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    const ent = await resolveEntitlements({ shop: TEST_SHOP, admin: makeAdmin([]) as any, now });
    expect(ent.isSyncSuspended).toBe(true);
  });

  it('false on paid_active with quota OK', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart: new Date('2026-05-01T00:00:00Z'), analyzedThreadsCount: 10 },
    });
    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([
        { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
      ]) as any,
      now,
    });
    expect(ent.isSyncSuspended).toBe(false);
  });

  it('true on paid_active with quota exceeded', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart: new Date('2026-05-01T00:00:00Z'), analyzedThreadsCount: 50 },
    });
    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([
        { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
      ]) as any,
      now,
    });
    expect(ent.isSyncSuspended).toBe(true);
  });

  it('false for internal (bypass)', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await testDb.shopFlag.create({
      data: { shop: TEST_SHOP, isInternal: true, firstInstallDate: new Date(now.getTime() - 30 * DAY_MS) },
    });
    const ent = await resolveEntitlements({ shop: TEST_SHOP, admin: makeAdmin([]) as any, now });
    expect(ent.isSyncSuspended).toBe(false);
  });
});
