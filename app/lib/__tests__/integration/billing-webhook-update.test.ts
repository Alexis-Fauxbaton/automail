import { describe, it, expect, vi, afterAll } from 'vitest';
import { disconnectTestDb } from './helpers/db';

afterAll(async () => {
  await disconnectTestDb();
});

vi.mock('../../../shopify.server', () => ({
  authenticate: {
    webhook: vi.fn(),
  },
}));

describe('webhooks.app_subscriptions.update', () => {
  it('invalidates the subscription cache for the shop and returns 200', async () => {
    const { authenticate } = await import('../../../shopify.server');
    (authenticate.webhook as any).mockResolvedValue({
      shop: 'webhook-test.myshopify.com',
      topic: 'APP_SUBSCRIPTIONS_UPDATE',
      payload: { app_subscription: { status: 'ACTIVE' } },
    });

    const subscriptionModule = await import('../../billing/subscription');
    const spy = vi.spyOn(subscriptionModule, 'invalidateCache');

    const { action } = await import('../../../routes/webhooks.app_subscriptions.update');
    const response = await action({
      request: new Request('https://x/webhooks/app_subscriptions/update', { method: 'POST' }),
    } as any);

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('webhook-test.myshopify.com');
  });
});
