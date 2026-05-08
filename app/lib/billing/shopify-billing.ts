/**
 * Thin wrapper around Shopify's Billing API GraphQL mutations.
 *
 * - createSubscription: kicks off the merchant subscription flow. Returns
 *   the Shopify confirmationUrl that the merchant must visit to complete
 *   the purchase. The route handler redirects them.
 * - cancelSubscription: cancels an active subscription (Shopify keeps it
 *   active until the end of the paid period).
 *
 * Trial handling: Shopify's `trialDays` field is honored on first install
 * for new subscriptions. We pass 14 to grant a fresh trial when applicable;
 * Shopify automatically refuses extra trials per its own rules, so this is
 * safe to always pass.
 */

import { PLANS, type PlanId } from './plans';

interface AdminClient {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<{
    json: () => Promise<any>;
  }>;
}

const CREATE_MUTATION = `#graphql
  mutation AppSubscriptionCreate(
    $name: String!
    $returnUrl: URL!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $trialDays: Int
    $test: Boolean
    $replacementBehavior: AppSubscriptionReplacementBehavior
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      lineItems: $lineItems
      trialDays: $trialDays
      test: $test
      replacementBehavior: $replacementBehavior
    ) {
      confirmationUrl
      appSubscription { id }
      userErrors { field message }
    }
  }
`;

const CANCEL_MUTATION = `#graphql
  mutation AppSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status }
      userErrors { field message }
    }
  }
`;

export async function createSubscription(input: {
  admin: AdminClient;
  planId: Exclude<PlanId, 'trial'>;
  returnUrl: string;
  test?: boolean;
  trialDays?: number;
}): Promise<{ confirmationUrl: string; subscriptionId: string }> {
  const plan = PLANS[input.planId];
  const response = await input.admin.graphql(CREATE_MUTATION, {
    variables: {
      name: input.planId,
      returnUrl: input.returnUrl,
      trialDays: input.trialDays ?? 14,
      test: input.test ?? false,
      replacementBehavior: 'STANDARD',
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: plan.priceUsd, currencyCode: 'USD' },
              interval: 'EVERY_30_DAYS',
            },
          },
        },
      ],
    },
  });

  const body = await response.json();
  const result = body?.data?.appSubscriptionCreate;
  if (!result) throw new Error('Invalid Shopify response (no appSubscriptionCreate)');
  if (result.userErrors?.length) {
    throw new Error(
      `Shopify userErrors: ${result.userErrors.map((e: any) => e.message).join('; ')}`
    );
  }
  if (!result.confirmationUrl || !result.appSubscription?.id) {
    throw new Error('Shopify did not return a confirmation URL');
  }
  return {
    confirmationUrl: result.confirmationUrl,
    subscriptionId: result.appSubscription.id,
  };
}

export async function cancelSubscription(input: {
  admin: AdminClient;
  subscriptionId: string;
}): Promise<{ subscriptionId: string; status: string }> {
  const response = await input.admin.graphql(CANCEL_MUTATION, {
    variables: { id: input.subscriptionId },
  });
  const body = await response.json();
  const result = body?.data?.appSubscriptionCancel;
  if (!result) throw new Error('Invalid Shopify response (no appSubscriptionCancel)');
  if (result.userErrors?.length) {
    throw new Error(
      `Shopify userErrors: ${result.userErrors.map((e: any) => e.message).join('; ')}`
    );
  }
  if (!result.appSubscription) {
    throw new Error('Shopify did not return a subscription');
  }
  return {
    subscriptionId: result.appSubscription.id,
    status: result.appSubscription.status,
  };
}
