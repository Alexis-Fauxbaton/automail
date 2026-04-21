import type { OrderFacts, OrderFulfillmentFacts } from "../types";
import type { RawOrderNode } from "./order-search";

/**
 * Convert a raw GraphQL order node into the simple, UI- and template-friendly
 * `OrderFacts` contract. Missing fields are preserved as null/empty arrays —
 * never invented.
 */
export function normalizeOrder(raw: RawOrderNode): OrderFacts {
  const customer = raw.customer;
  const customerName = customer
    ? [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim() ||
      null
    : null;

  const rawFulfillments = raw.fulfillments ?? [];
  if (rawFulfillments.length === 0 && raw.id) {
    console.warn(
      `[order-normalizer] Order ${raw.name} (${raw.id}) has no fulfillments in GraphQL response. ` +
      `displayFulfillmentStatus=${raw.displayFulfillmentStatus}. Check read_fulfillments scope and fulfillmentLineItems query.`,
    );
  }

  const fulfillments: OrderFulfillmentFacts[] = rawFulfillments.map(
    (f) => {
      const trackingNumbers = (f.trackingInfo ?? [])
        .map((t) => t.number)
        .filter((n): n is string => !!n);
      const trackingUrls = (f.trackingInfo ?? [])
        .map((t) => t.url)
        .filter((u): u is string => !!u);
      const carrier =
        (f.trackingInfo ?? []).find((t) => t.company)?.company ?? null;

      const lineItems = (f.fulfillmentLineItems?.edges ?? []).map((e) => ({
        title: e.node.lineItem.title,
        // Use fulfillment-level quantity (partial fulfillment possible)
        quantity: e.node.quantity,
      }));

      return {
        status: f.status ?? null,
        trackingNumbers,
        trackingUrls,
        carrier,
        updatedAt: f.updatedAt ?? null,
        estimatedDeliveryAt: f.estimatedDeliveryAt ?? null,
        lineItems,
      };
    },
  );

  return {
    id: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    displayFinancialStatus: raw.displayFinancialStatus,
    displayFulfillmentStatus: raw.displayFulfillmentStatus,
    customerName: customerName || null,
    customerEmail: customer?.email ?? null,
    lineItems: (raw.lineItems?.edges ?? []).map((e) => ({
      title: e.node.title,
      quantity: e.node.quantity,
    })),
    fulfillments,
  };
}
