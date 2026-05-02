import type { AdminGraphqlClient } from "../support/shopify/order-search";

const CUSTOMERS_QUERY = `#graphql
  query RecentCustomerEmails($first: Int!) {
    customers(first: $first, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        email
      }
    }
  }
`;

const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes

const cache = new Map<string, { emails: Set<string>; fetchedAt: number }>();

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
    const data = await res.json();
    for (const node of data?.data?.customers?.nodes ?? []) {
      if (node.email) emails.add(node.email.toLowerCase());
    }
  } catch (err) {
    console.error("[gmail/customers] Failed to fetch customer emails:", err);
  }

  cache.set(shop, { emails, fetchedAt: Date.now() });
  return emails;
}
