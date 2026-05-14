import type { FulfillmentTrackingFacts, OrderFacts } from "../types";
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
  const attemptAt = new Date().toISOString();

  // No tracking number → nothing to ask 17track about.
  if (!trackingNumber) {
    const base = resolveTrackingForFulfillment(fulfillment);
    return {
      ...base,
      fulfillmentIndex,
      lineItems,
      last17trackAttempt: "skipped",
      last17trackAttemptAt: attemptAt,
    };
  }

  // --- 1. Try 17track first ---
  try {
    const result = await fetchTrackingFrom17track(trackingNumber, fulfillment.carrier ?? null);
    if (result && result.state === "ok") {
      return {
        source: "seventeen_track",
        carrier: result.carrierName ?? fulfillment.carrier ?? null,
        trackingNumber,
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
        last17trackAttempt: "ok",
        last17trackAttemptAt: attemptAt,
      };
    }
    if (result && result.state === "pending") {
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
        last17trackAttempt: "pending",
        last17trackAttemptAt: attemptAt,
      };
    }
    // result === null → 17track failed (HTTP error, breaker open, no API key, or unexpected rejection).
    // Differentiate "no API key" from "real error" so the breaker-open / fail
    // cases drive faster retries while no-key never does.
    const attempt: "error" | "skipped" =
      process.env.SEVENTEEN_TRACK_API_KEY && process.env.SEVENTEEN_TRACK_API_KEY !== "your-17track-key-here"
        ? "error"
        : "skipped";
    const base = resolveTrackingForFulfillment(fulfillment);
    return {
      ...base,
      fulfillmentIndex,
      lineItems,
      last17trackAttempt: attempt,
      last17trackAttemptAt: attemptAt,
    };
  } catch (err) {
    console.error(`[tracking] 17track failed for fulfillment ${fulfillmentIndex}, using Shopify:`, err);
    const base = resolveTrackingForFulfillment(fulfillment);
    return {
      ...base,
      fulfillmentIndex,
      lineItems,
      last17trackAttempt: "error",
      last17trackAttemptAt: attemptAt,
    };
  }
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
