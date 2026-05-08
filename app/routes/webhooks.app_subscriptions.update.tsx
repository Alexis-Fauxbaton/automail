import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { invalidateCache } from "../lib/billing/subscription";

/**
 * Webhook: app_subscriptions/update
 *
 * Fires when a merchant's subscription status changes (created, activated,
 * cancelled, frozen, expired). We use this purely to invalidate our 5min
 * in-memory cache so the next request sees the fresh state.
 *
 * The actual subscription state remains read from Shopify's API on demand
 * (see `subscription.ts`). We don't mirror state in our DB — Shopify is
 * the source of truth.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  invalidateCache(shop);
  return new Response(null, { status: 200 });
};
