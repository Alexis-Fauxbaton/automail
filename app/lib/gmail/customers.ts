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

export async function fetchCustomerEmails(
  admin: AdminGraphqlClient,
): Promise<Set<string>> {
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
  return emails;
}
