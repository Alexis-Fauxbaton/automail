import type { ExtractedIdentifiers } from "../types";

// The admin client comes from `authenticate.admin(request)` in a route action.
// We type it loosely to avoid coupling to a specific codegen shape.
export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

const ORDER_FIELDS = /* GraphQL */ `
  fragment OrderFields on Order {
    id
    name
    createdAt
    displayFinancialStatus
    displayFulfillmentStatus
    customer {
      firstName
      lastName
      email
    }
    lineItems(first: 20) {
      edges {
        node {
          title
          quantity
        }
      }
    }
    fulfillments {
      id
      status
      updatedAt
      estimatedDeliveryAt
      trackingInfo {
        company
        number
        url
      }
      fulfillmentLineItems(first: 20) {
        edges {
          node {
            lineItem {
              title
              quantity
            }
            quantity
          }
        }
      }
    }
  }
`;

// NOTE on read_all_orders scope: this query intentionally has no date filter.
// Customer support emails regularly reference orders placed more than 60 days
// ago (delayed shipments, long-tail refund requests, repeat customers checking
// on old purchases). The `read_orders` scope only exposes orders within the
// last 60 days; without `read_all_orders` the Admin API silently returns an
// empty set for those older orders, making the copilot unable to assist.
const SEARCH_QUERY = /* GraphQL */ `
  ${ORDER_FIELDS}
  query SupportOrderSearch($query: String!) {
    orders(first: 5, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          ...OrderFields
        }
      }
    }
  }
`;

/**
 * Sanitize identifiers extracted from LLM output before using them in
 * Shopify GraphQL search queries. Even though Shopify variables prevent
 * injection at the protocol level, malformed values can produce unexpected
 * search results or reveal unrelated orders.
 */
function sanitizeIdentifiers(ids: ExtractedIdentifiers): ExtractedIdentifiers {
  return {
    orderNumber: ids.orderNumber?.replace(/[^0-9]/g, "").slice(0, 10) || undefined,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ids.email ?? "")
      ? ids.email!.slice(0, 254)
      : undefined,
    customerName: ids.customerName
      ?.replace(/[^\p{L}\p{N}\s''\-\.]/gu, "")
      .slice(0, 100) || undefined,
    trackingNumber: ids.trackingNumber
      ?.replace(/[^A-Za-z0-9\-]/g, "")
      .slice(0, 50) || undefined,
  };
}

/**
 * Build a Shopify-compatible search string.
 * Docs: https://shopify.dev/docs/api/usage/search-syntax
 */
function buildSearchQueries(ids: ExtractedIdentifiers): string[] {
  const queries: string[] = [];

  if (ids.orderNumber) {
    // The `name` search expects e.g. "#1234" or "1234"; use `name:`.
    queries.push(`name:#${ids.orderNumber}`);
  }
  if (ids.email) {
    queries.push(`email:${ids.email}`);
  }
  if (ids.customerName) {
    // No dedicated field — fall back to a free-text search.
    queries.push(ids.customerName);
  }
  if (ids.trackingNumber) {
    // `fulfillment_status` won't help; most shops can find by tracking via
    // free-text. This is best-effort.
    queries.push(ids.trackingNumber);
  }

  return queries;
}

export interface RawOrderNode {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  customer: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  } | null;
  lineItems: { edges: Array<{ node: { title: string; quantity: number } }> };
  fulfillments: Array<{
    id: string;
    status: string | null;
    updatedAt: string | null;
    estimatedDeliveryAt: string | null;
    trackingInfo: Array<{
      company: string | null;
      number: string | null;
      url: string | null;
    }>;
    fulfillmentLineItems: {
      edges: Array<{
        node: {
          lineItem: { title: string; quantity: number };
          quantity: number;
        };
      }>;
    };
  }>;
}

export interface OrderSearchResult {
  /** Which identifier ultimately produced the hits. */
  matchedBy: "orderNumber" | "email" | "customerName" | "trackingNumber" | null;
  orders: RawOrderNode[];
}

/**
 * Search Shopify for orders matching the given identifiers, in priority order.
 * Stops at the first query that returns at least one order.
 */
export async function searchOrders(
  admin: AdminGraphqlClient,
  ids: ExtractedIdentifiers,
): Promise<OrderSearchResult> {
  const safe = sanitizeIdentifiers(ids);
  const priorities: Array<{
    key: OrderSearchResult["matchedBy"];
    query: string | undefined;
  }> = [
    { key: "orderNumber", query: safe.orderNumber ? `name:#${safe.orderNumber}` : undefined },
    { key: "email", query: safe.email ? `email:${safe.email}` : undefined },
    { key: "customerName", query: safe.customerName },
    { key: "trackingNumber", query: safe.trackingNumber },
  ];

  for (const { key, query } of priorities) {
    if (!query) continue;
    const orders = await runSearch(admin, query);
    if (orders.length > 0) {
      return { matchedBy: key, orders };
    }
  }

  return { matchedBy: null, orders: [] };
}

async function runSearch(
  admin: AdminGraphqlClient,
  query: string,
): Promise<RawOrderNode[]> {
  // Backoff schedule for THROTTLED errors. Shopify's leaky-bucket allows
  // recovery within ~1s for typical query costs, but big bursts (resync of
  // hundreds of resolved threads) can saturate it. Three retries with
  // exponential backoff cover the realistic worst case without stalling.
  const RETRY_DELAYS_MS = [400, 1000, 2500];
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const response = await admin.graphql(SEARCH_QUERY, {
      variables: { query },
    });
    const json = (await response.json()) as {
      data?: { orders?: { edges: Array<{ node: RawOrderNode }> } };
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
    };

    if (json.errors && json.errors.length > 0) {
      const throttled = json.errors.some(
        (e) => e.extensions?.code === "THROTTLED" || /throttled/i.test(e.message),
      );
      const msg = json.errors.map((e) => e.message).join(" | ");
      lastError = new Error(`Shopify GraphQL error: ${msg}`);
      if (throttled && attempt < RETRY_DELAYS_MS.length) {
        // Add ±25% jitter so a burst of throttled requests doesn't all
        // resume in lock-step and trigger a second throttle wave.
        const base = RETRY_DELAYS_MS[attempt];
        const jitter = base * (0.5 - Math.random()) * 0.5; // ±25%
        const delay = Math.max(50, Math.round(base + jitter));
        console.warn(
          `[order-search] Throttled (attempt ${attempt + 1}), retrying in ${delay}ms | query: ${query}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      console.error("[order-search] GraphQL errors:", msg, "| query:", query);
      throw lastError;
    }

    if (!json.data) {
      console.error("[order-search] Unexpected response (no data):", JSON.stringify(json).slice(0, 500));
    }
    if (!json.data?.orders) return [];
    return json.data.orders.edges.map((e) => e.node);
  }

  // Exhausted retries on throttle.
  throw lastError ?? new Error("Shopify GraphQL throttle: retries exhausted");
}

// Exported for potential reuse / tests.
export const __internals = { SEARCH_QUERY, buildSearchQueries };
