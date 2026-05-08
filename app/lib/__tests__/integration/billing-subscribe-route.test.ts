import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
});

vi.mock('../../../shopify.server', () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

describe('api.billing.subscribe action', () => {
  it('returns confirmationUrl for valid plan', async () => {
    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          appSubscriptionCreate: {
            confirmationUrl: 'https://x.myshopify.com/admin/charges/1/confirm',
            appSubscription: { id: 'gid://shopify/AppSubscription/1' },
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

    const { action } = await import('../../../routes/api.billing.subscribe');

    const formData = new FormData();
    formData.set('planId', 'starter');
    const response = await action({
      request: new Request('https://x/api/billing/subscribe', { method: 'POST', body: formData }),
    } as any);

    const json = await response.json();
    expect(json.confirmationUrl).toBe('https://x.myshopify.com/admin/charges/1/confirm');
    expect(adminGraphql).toHaveBeenCalled();
  });

  it('returns 400 for missing planId', async () => {
    const { authenticate } = await import('../../../shopify.server');
    (authenticate.admin as any).mockResolvedValue({
      session: { shop: TEST_SHOP },
      admin: { graphql: vi.fn() },
    });

    const { action } = await import('../../../routes/api.billing.subscribe');

    const response = await action({
      request: new Request('https://x/api/billing/subscribe', { method: 'POST', body: new FormData() }),
    } as any);

    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid planId', async () => {
    const { authenticate } = await import('../../../shopify.server');
    (authenticate.admin as any).mockResolvedValue({
      session: { shop: TEST_SHOP },
      admin: { graphql: vi.fn() },
    });

    const { action } = await import('../../../routes/api.billing.subscribe');

    const formData = new FormData();
    formData.set('planId', 'enterprise');
    const response = await action({
      request: new Request('https://x/api/billing/subscribe', { method: 'POST', body: formData }),
    } as any);

    expect(response.status).toBe(400);
  });
});
