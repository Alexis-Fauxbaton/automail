import { describe, it, expect, vi } from 'vitest';
import { createSubscription, cancelSubscription } from '../shopify-billing';

function makeAdmin(graphqlImpl: (query: string, opts?: any) => Promise<any>) {
  return { graphql: vi.fn(graphqlImpl) };
}

describe('createSubscription', () => {
  it('calls appSubscriptionCreate with starter pricing', async () => {
    const admin = makeAdmin(async () => ({
      json: async () => ({
        data: {
          appSubscriptionCreate: {
            confirmationUrl: 'https://example.myshopify.com/admin/charges/123/confirm',
            appSubscription: { id: 'gid://shopify/AppSubscription/123' },
            userErrors: [],
          },
        },
      }),
    }));

    const result = await createSubscription({
      admin: admin as any,
      planId: 'starter',
      returnUrl: 'https://app.example.com/app/billing?subscribed=1',
      test: true,
    });

    expect(result.confirmationUrl).toBe(
      'https://example.myshopify.com/admin/charges/123/confirm'
    );
    expect(result.subscriptionId).toBe('gid://shopify/AppSubscription/123');

    const callArgs = admin.graphql.mock.calls[0];
    const variables = callArgs[1]?.variables;
    expect(variables.name).toBe('starter');
    expect(variables.lineItems[0].plan.appRecurringPricingDetails.price.amount).toBe(9);
    expect(variables.test).toBe(true);
    expect(variables.trialDays).toBe(14);
  });

  it('calls appSubscriptionCreate with pro pricing', async () => {
    const admin = makeAdmin(async () => ({
      json: async () => ({
        data: {
          appSubscriptionCreate: {
            confirmationUrl: 'https://x/confirm',
            appSubscription: { id: 'gid://1' },
            userErrors: [],
          },
        },
      }),
    }));

    await createSubscription({
      admin: admin as any,
      planId: 'pro',
      returnUrl: 'https://x',
      test: true,
    });

    const variables = admin.graphql.mock.calls[0][1]?.variables;
    expect(variables.name).toBe('pro');
    expect(variables.lineItems[0].plan.appRecurringPricingDetails.price.amount).toBe(49);
  });

  it('throws on userErrors from Shopify', async () => {
    const admin = makeAdmin(async () => ({
      json: async () => ({
        data: {
          appSubscriptionCreate: {
            confirmationUrl: null,
            appSubscription: null,
            userErrors: [{ field: ['name'], message: 'Invalid plan name' }],
          },
        },
      }),
    }));

    await expect(
      createSubscription({
        admin: admin as any,
        planId: 'starter',
        returnUrl: 'https://x',
        test: true,
      })
    ).rejects.toThrow(/Invalid plan name/);
  });
});

describe('cancelSubscription', () => {
  it('calls appSubscriptionCancel with the right id', async () => {
    const admin = makeAdmin(async () => ({
      json: async () => ({
        data: {
          appSubscriptionCancel: {
            appSubscription: { id: 'gid://shopify/AppSubscription/123', status: 'CANCELLED' },
            userErrors: [],
          },
        },
      }),
    }));

    const result = await cancelSubscription({
      admin: admin as any,
      subscriptionId: 'gid://shopify/AppSubscription/123',
    });

    expect(result.subscriptionId).toBe('gid://shopify/AppSubscription/123');
    expect(result.status).toBe('CANCELLED');
  });

  it('throws on userErrors', async () => {
    const admin = makeAdmin(async () => ({
      json: async () => ({
        data: {
          appSubscriptionCancel: {
            appSubscription: null,
            userErrors: [{ field: ['id'], message: 'Subscription not found' }],
          },
        },
      }),
    }));

    await expect(
      cancelSubscription({ admin: admin as any, subscriptionId: 'gid://x' })
    ).rejects.toThrow(/Subscription not found/);
  });
});
