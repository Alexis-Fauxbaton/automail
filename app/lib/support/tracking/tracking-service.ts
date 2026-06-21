import type { FulfillmentTrackingFacts, OrderFacts } from "../types";
import { resolveTrackingForFulfillment } from "./provider-resolver";
import { fetchTrackingFrom17track } from "./adapters/seventeen-track";
import { isOpen as is17trackBreakerOpen } from "./seventeen-track-breaker";
import {
  trackingResolutionTotal,
  trackingCorroborationTotal,
  trackingHintTotal,
} from "../../metrics/definitions";

/**
 * Resolve tracking facts for a single fulfillment.
 *
 * Priority:
 *   1. 17track API — live carrier data when SEVENTEEN_TRACK_API_KEY is set.
 *   2. Shopify tracking URL / carrier data.
 *   3. Pattern-based carrier guess (inferred).
 */
/** 17track `param` = "<Alpha-2 country>-<postal code>", required by some
 *  carriers (Cainiao / postal) to register a number. Null when the order has
 *  no usable destination. */
function build17trackParam(order: OrderFacts): string | null {
  const country = order.destinationCountry?.trim();
  const zip = order.destinationZip?.trim();
  if (!country || !zip) return null;
  return `${country}-${zip}`;
}

async function resolveOneFulfillment(
  fulfillment: OrderFacts["fulfillments"][number],
  fulfillmentIndex: number,
  trackingNumber: string | null,
  trackingUrl: string | null,
  param: string | null,
  orderCountry: string | null,
  previousCarrierCode: number | null = null,
): Promise<FulfillmentTrackingFacts> {
  const lineItems = fulfillment.lineItems;
  const attemptAt = new Date().toISOString();

  // No tracking number → nothing to ask 17track about.
  if (!trackingNumber) {
    const base = resolveTrackingForFulfillment(fulfillment, trackingNumber, trackingUrl);
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
    const result = await fetchTrackingFrom17track(trackingNumber, { param, trackingUrl, orderCountry, previousCarrierCode /* TODO populate from last persisted carrier code (stable tie-breaker) */ });
    if (result && result.state === "ok") {
      // Corroboration: emit for every ok result — either a country was returned
      // (match) or it was absent (unverified). This covers both the inferred
      // and the plain-ok cases without a gap.
      trackingCorroborationTotal.inc({ result: result.recipientCountry ? "match" : "absent_unverified" });
      // Resolution outcome: recoveredViaHint is the authoritative signal for
      // whether the reactive hint branch ran and produced the result.
      // inferredCarrier only means the carrier was unverified (recipientCountry absent)
      // — it is NOT equivalent to a hint recovery.
      trackingResolutionTotal.inc({ outcome: result.recoveredViaHint ? "ok_hint_recovered" : "ok_auto" });
      if (result.recoveredViaHint) {
        trackingHintTotal.inc({ source: "reactive", result: "recovered" });
      }
      return {
        source: "seventeen_track",
        carrier: result.carrierName ?? fulfillment.carrier ?? null,
        trackingNumber,
        trackingUrl: trackingUrl ?? null,
        status: result.status,
        inferred: result.inferredCarrier ?? false,
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
      trackingResolutionTotal.inc({ outcome: "pending" });
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
    if (result && result.state === "quota_exhausted") {
      // Our 17track plan ran out for the period. The API is healthy, retry
      // won't help until the next billing cycle. Fall back to Shopify-only
      // tracking and mark the attempt as "skipped" so the adaptive retry
      // logic doesn't burn 17track quota uselessly trying again soon.
      console.warn(`[tracking] 17track quota exhausted for ${trackingNumber}; using Shopify fallback`);
      const base = resolveTrackingForFulfillment(fulfillment, trackingNumber, trackingUrl);
      return {
        ...base,
        fulfillmentIndex,
        lineItems,
        last17trackAttempt: "skipped",
        last17trackAttemptAt: attemptAt,
      };
    }
    if (result && result.state === "corroboration_mismatch") {
      // 17track's recipient country contradicts the order country — likely another
      // customer's parcel. Fall back to Shopify data and mark it unverified.
      trackingCorroborationTotal.inc({ result: "mismatch_rejected" });
      trackingResolutionTotal.inc({ outcome: "notfound" });
      const base = resolveTrackingForFulfillment(fulfillment, trackingNumber, trackingUrl);
      return {
        ...base,
        inferred: true,
        fulfillmentIndex,
        lineItems,
        last17trackAttempt: "ok",
        last17trackAttemptAt: attemptAt,
      };
    }
    // result === null → 17track failed (HTTP error, breaker open, no API key, or unexpected rejection).
    // Three buckets:
    //   - no/placeholder API key → "skipped" (never retry faster)
    //   - breaker open            → "skipped" (will be open for 15 min, faster retry is wasted)
    //   - everything else         → "error"  (real transient failure, retry in 10 min)
    const keyConfigured =
      !!process.env.SEVENTEEN_TRACK_API_KEY &&
      process.env.SEVENTEEN_TRACK_API_KEY !== "your-17track-key-here";
    let attempt: "error" | "skipped";
    if (!keyConfigured) attempt = "skipped";
    else if (is17trackBreakerOpen()) attempt = "skipped";
    else attempt = "error";
    if (attempt === "error") trackingResolutionTotal.inc({ outcome: "error" });
    const base = resolveTrackingForFulfillment(fulfillment, trackingNumber, trackingUrl);
    return {
      ...base,
      fulfillmentIndex,
      lineItems,
      last17trackAttempt: attempt,
      last17trackAttemptAt: attemptAt,
    };
  } catch (err) {
    trackingResolutionTotal.inc({ outcome: "error" });
    console.error(`[tracking] 17track failed for fulfillment ${fulfillmentIndex}, using Shopify:`, err);
    const base = resolveTrackingForFulfillment(fulfillment, trackingNumber, trackingUrl);
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

  // One entry per (fulfillment, tracking number). A fulfillment can carry
  // several tracking numbers (split parcels under one shipment) — resolve each
  // independently instead of dropping all but the first. Fulfillments with no
  // tracking number still produce a single "none" entry.
  const param = build17trackParam(order);
  const tasks: Array<Promise<FulfillmentTrackingFacts>> = [];
  order.fulfillments.forEach((fulfillment, index) => {
    const numbers =
      fulfillment.trackingNumbers.length > 0 ? fulfillment.trackingNumbers : [null];
    numbers.forEach((trackingNumber, ti) => {
      const trackingUrl = trackingNumber
        ? (fulfillment.trackingUrls[ti] ?? fulfillment.trackingUrls[0] ?? null)
        : null;
      tasks.push(resolveOneFulfillment(fulfillment, index, trackingNumber, trackingUrl, param, order.destinationCountry ?? null, null));
    });
  });
  return Promise.all(tasks);
}
