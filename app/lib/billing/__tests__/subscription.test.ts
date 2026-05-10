import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveActivePlan, __resetCacheForTests } from '../subscription';

type FakeAdminClient = {
  graphql: ReturnType<typeof vi.fn>;
};

function makeClient(activeSubscriptions: any[]): FakeAdminClient {
  return {
    graphql: vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          currentAppInstallation: { activeSubscriptions },
        },
      }),
    }),
  };
}

beforeEach(() => {
  __resetCacheForTests();
});

describe('resolveActivePlan', () => {
  it('returns "none" when no active subscriptions', async () => {
    const client = makeClient([]);
    const result = await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(result.plan).toBe('none');
  });

  it('returns "starter" when an active starter subscription exists', async () => {
    const client = makeClient([
      {
        id: 'gid://shopify/AppSubscription/1',
        name: 'starter',
        status: 'ACTIVE',
        trialDays: 14,
        createdAt: '2026-05-01T00:00:00Z',
        currentPeriodEnd: '2026-06-01T00:00:00Z',
      },
    ]);
    const result = await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(result.plan).toBe('starter');
    expect(result.subscriptionId).toBe('gid://shopify/AppSubscription/1');
    expect(result.currentPeriodEnd?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('returns "pro" when an active pro subscription exists', async () => {
    const client = makeClient([
      {
        id: 'gid://shopify/AppSubscription/2',
        name: 'pro',
        status: 'ACTIVE',
        trialDays: 14,
        createdAt: '2026-05-01T00:00:00Z',
        currentPeriodEnd: '2026-06-01T00:00:00Z',
      },
    ]);
    const result = await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(result.plan).toBe('pro');
  });

  it('caches the result for 5 minutes', async () => {
    const client = makeClient([
      { id: 'gid://1', name: 'pro', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
    ]);
    await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(client.graphql).toHaveBeenCalledTimes(1);
  });

  it('isolates cache per shop', async () => {
    const c1 = makeClient([{ id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' }]);
    const c2 = makeClient([{ id: 'gid://2', name: 'pro',     status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' }]);

    const a = await resolveActivePlan({ shop: 'a.myshopify.com', admin: c1 as any });
    const b = await resolveActivePlan({ shop: 'b.myshopify.com', admin: c2 as any });
    expect(a.plan).toBe('starter');
    expect(b.plan).toBe('pro');
  });

  it('ignores subscriptions with status != ACTIVE', async () => {
    const client = makeClient([
      { id: 'gid://1', name: 'pro', status: 'CANCELLED', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
    ]);
    const result = await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(result.plan).toBe('none');
  });

  it('returns "none" with unknown plan name', async () => {
    const client = makeClient([
      { id: 'gid://1', name: 'enterprise', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
    ]);
    const result = await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(result.plan).toBe('none');
  });
});

describe('cache invalidation', () => {
  it('__resetCacheForTests clears the cache', async () => {
    const client = makeClient([
      { id: 'gid://1', name: 'pro', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
    ]);
    await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    __resetCacheForTests();
    await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(client.graphql).toHaveBeenCalledTimes(2);
  });
});
