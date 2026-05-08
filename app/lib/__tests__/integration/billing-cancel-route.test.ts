import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
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
  authenticate: {
    admin: vi.fn(),
  },
}));

describe('api.billing.cancel — immediate', () => {
  it('cancels the active Shopify subscription', async () => {
    const adminGraphql = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({
          data: {
            currentAppInstallation: {
              activeSubscriptions: [
                { id: 'gid://shopify/AppSubscription/77', name: 'pro', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
              ],
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          data: {
            appSubscriptionCancel: {
              appSubscription: { id: 'gid://shopify/AppSubscription/77', status: 'CANCELLED' },
              userErrors: [],
            },
          },
        }),
      });

    const { authenticate } = await import('../../../shopify.server');
    (authenticate.admin as any).mockResolvedValue({
      session: { shop: TEST_SHOP },
      admin: { graphql: adminGraphql },
    });

    const { action } = await import('../../../routes/api.billing.cancel');

    const fd = new FormData();
    fd.set('mode', 'immediate');
    const response = await action({
      request: new Request('https://x/api/billing/cancel', { method: 'POST', body: fd }),
    } as any);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.cancelled).toBe(true);
  });
});

describe('api.billing.cancel — scheduled downgrade', () => {
  it('creates a BillingScheduledChange row', async () => {
    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              { id: 'gid://1', name: 'pro', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
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

    const { action } = await import('../../../routes/api.billing.cancel');

    const fd = new FormData();
    fd.set('mode', 'downgrade');
    fd.set('toPlan', 'starter');
    const response = await action({
      request: new Request('https://x/api/billing/cancel', { method: 'POST', body: fd }),
    } as any);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.scheduled).toBe(true);
    expect(json.effectiveAt).toBeDefined();

    const change = await testDb.billingScheduledChange.findFirst({
      where: { shop: TEST_SHOP, appliedAt: null, cancelledAt: null },
    });
    expect(change).not.toBeNull();
    expect(change?.fromPlan).toBe('pro');
    expect(change?.toPlan).toBe('starter');
  });

  it('returns 400 for invalid toPlan', async () => {
    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              { id: 'gid://1', name: 'pro', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
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

    const { action } = await import('../../../routes/api.billing.cancel');

    const fd = new FormData();
    fd.set('mode', 'downgrade');
    fd.set('toPlan', 'enterprise');
    const response = await action({
      request: new Request('https://x/api/billing/cancel', { method: 'POST', body: fd }),
    } as any);

    expect(response.status).toBe(400);
  });
});
