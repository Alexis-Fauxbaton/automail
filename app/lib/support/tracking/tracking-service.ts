import type { FulfillmentTrackingFacts, OrderFacts, TrackingFacts } from "../types";
import { resolveTrackingForFulfillment } from "./provider-resolver";
import { fetchTrackingFrom17track } from "./adapters/seventeen-track";

/**
 * Resolve tracking facts for a single fulfillment.
 *
 * Priority:
 *   1. 17track API — live carrier data when SEVENTEEN_TRACK_API_KEY is set.
 *   2. Shopify tracking URL / carrier data.
 *   3. Pattern-based carrier guess (inferred).
 */
async function resolveOneFulfillment(
  fulfillment: OrderFacts["fulfillments"][number],
  fulfillmentIndex: number,
): Promise<FulfillmentTrackingFacts> {
  const trackingNumber = fulfillment.trackingNumbers[0] ?? null;
  const trackingUrl = fulfillment.trackingUrls[0] ?? null;
  const lineItems = fulfillment.lineItems;

  // --- 1. Try 17track first ---
  if (trackingNumber) {
    try {
      const result = await fetchTrackingFrom17track(trackingNumber, fulfillment.carrier ?? null);
      if (result && result.state === "ok") {
        return {
          source: "seventeen_track",
          carrier: result.carrierName ?? fulfillment.carrier ?? null,
          trackingNumber,
          // Keep Shopify URL for the customer-facing link when available.
          trackingUrl: trackingUrl ?? null,
          status: result.status,
          inferred: false,
          events: result.events,
          lastEvent: result.lastEvent,
          lastLocation: result.lastLocation,
          lastEventDate: result.lastEventDate,
          delivered: result.delivered,
          fulfillmentIndex,
          lineItems,
        };
      }
      if (result && result.state === "pending") {
        // 17track registered the number but data isn't ready yet.
        // Return a "pending" entry so the draft can say tracking is initializing
        // instead of falling back to an unreliable scraping source.
        console.log(`[tracking] 17track pending after retries for ${trackingNumber} (fulfillment ${fulfillmentIndex})`);
        return {
          source: "seventeen_track",
          carrier: fulfillment.carrier ?? null,
          trackingNumber,
          trackingUrl: trackingUrl ?? null,
          status: "Pending (tracking initializing)",
          inferred: false,
          events: [],
          lastEvent: null,
          lastLocation: null,
          lastEventDate: null,
          delivered: false,
          fulfillmentIndex,
          lineItems,
        };
      }
    } catch (err) {
      console.error(`[tracking] 17track failed for fulfillment ${fulfillmentIndex}, using Shopify:`, err);
    }
  }

  // --- 2. Fallback: Shopify data + pattern inference ---
  const base: TrackingFacts = resolveTrackingForFulfillment(fulfillment);
  return { ...base, fulfillmentIndex, lineItems };
}

/**
 * Returns one `FulfillmentTrackingFacts` per fulfillment in the order.
 * Fulfillments with no tracking info produce a `source: "none"` entry.
 */
export async function getTrackingFacts(
  order: OrderFacts | null,
): Promise<FulfillmentTrackingFacts[]> {
  if (!order || order.fulfillments.length === 0) return [];

  return Promise.all(
    order.fulfillments.map((fulfillment, index) =>
      resolveOneFulfillment(fulfillment, index),
    ),
  );
}
