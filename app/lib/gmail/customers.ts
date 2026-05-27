import type { AdminGraphqlClient } from "../support/shopify/order-search";
import {
  partitionGraphqlErrors,
  warnPcdOnce,
  type ShopifyGraphqlError,
} from "../support/shopify/protected-customer-data";

const CUSTOMERS_QUERY = `#graphql
  query RecentCustomerEmails($first: Int!) {
    customers(first: $first, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        email
      }
    }
  }
`;

// 5 minutes — multi-instance staleness ceiling. The previous 20-minute TTL
// meant that after the merchant added a new customer, replica B could
// mis-classify their first email as "probably_non_client" for up to 20 min.
// 5 min keeps the Shopify Admin API load manageable while reducing the
// window meaningfully.
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 200;

type CacheEntry = { emails: Set<string>; fetchedAt: number };
const cache = new Map<string, CacheEntry>();

function setCacheEntry(shop: string, value: CacheEntry) {
  // Best-effort sweep of expired entries before deciding to evict; this
  // protects an idle-but-cached shop from being kicked out by a churn of
  // ephemeral lookups when the cache is near MAX_CACHE_SIZE.
  if (cache.size >= MAX_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.fetchedAt >= CACHE_TTL_MS) cache.delete(k);
    }
  }
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(shop, value);
}

/** Drop the cache entry for one shop. Call from uninstall / shop-redact. */
export function invalidateCustomerEmailsCache(shop: string): void {
  cache.delete(shop);
}

export async function fetchCustomerEmails(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<Set<string>> {
  const cached = cache.get(shop);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.emails;
  }

  const emails = new Set<string>();
  try {
    const res = await admin.graphql(CUSTOMERS_QUERY, {
      variables: { first: 250 },
    });
    const data = (await res.json()) as {
      data?: { customers?: { nodes: Array<{ email: string | null }> } };
      errors?: ShopifyGraphqlError[];
    };
    if (data.errors && data.errors.length > 0) {
      const { pcdErrors, realErrors } = partitionGraphqlErrors(data.errors);
      if (pcdErrors.length > 0) warnPcdOnce(shop, "fetchCustomerEmails");
      if (realErrors.length > 0) {
        console.error(
          "[gmail/customers] GraphQL errors:",
          realErrors.map((e) => e.message).join(" | "),
        );
      }
    }
    for (const node of data?.data?.customers?.nodes ?? []) {
      if (node.email) emails.add(node.email.toLowerCase());
    }
  } catch (err) {
    console.error("[gmail/customers] Failed to fetch customer emails:", err);
  }

  setCacheEntry(shop, { emails, fetchedAt: Date.now() });
  return emails;
}
