import type { OrderFacts, OrderLineItemFacts } from "./types";

/**
 * Order line items not (fully) covered by any fulfillment — i.e. still to ship.
 *
 * Matched by title (Shopify line-item facts carry no SKU/id at this layer);
 * each returned entry carries its *remaining* unfulfilled quantity. Empty when
 * the order is fully fulfilled (or there is no order). When nothing has shipped
 * yet (no fulfillments / UNFULFILLED), every item is returned.
 *
 * Pure + dependency-free so it is safe to use from both server and client code
 * (the inbox detail panel renders it directly from the persisted analysis).
 */
export function computeUnfulfilledItems(order: OrderFacts | null): OrderLineItemFacts[] {
  if (!order) return [];
  // Trust Shopify when it reports everything shipped.
  if (order.displayFulfillmentStatus === "FULFILLED") return [];

  const fulfilledByTitle = new Map<string, number>();
  for (const f of order.fulfillments) {
    for (const li of f.lineItems) {
      fulfilledByTitle.set(li.title, (fulfilledByTitle.get(li.title) ?? 0) + li.quantity);
    }
  }

  const result: OrderLineItemFacts[] = [];
  for (const li of order.lineItems) {
    const remaining = li.quantity - (fulfilledByTitle.get(li.title) ?? 0);
    if (remaining > 0) result.push({ title: li.title, quantity: remaining });
  }
  return result;
}
