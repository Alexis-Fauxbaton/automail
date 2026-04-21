import type { OrderFacts, OrderFulfillmentFacts, TrackingFacts } from "../types";

// Very conservative pattern-based carrier guess. Only used as a last resort,
// and the result is always flagged `inferred: true` so drafts can say so.
const CARRIER_PATTERNS: Array<{ carrier: string; re: RegExp; urlFor?: (n: string) => string }> = [
  {
    carrier: "UPS",
    re: /^1Z[0-9A-Z]{16}$/,
    urlFor: (n) => `https://www.ups.com/track?tracknum=${n}`,
  },
  {
    carrier: "La Poste / Colissimo",
    re: /^[0-9]{13}$/,
    urlFor: (n) => `https://www.laposte.fr/outils/suivre-vos-envois?code=${n}`,
  },
  {
    carrier: "La Poste (international)",
    re: /^[A-Z]{2}\d{9}[A-Z]{2}$/,
    urlFor: (n) => `https://www.laposte.fr/outils/suivre-vos-envois?code=${n}`,
  },
];

/**
 * Decide where tracking facts should come from for a single fulfillment.
 * Priority: Shopify tracking URL > Shopify carrier > pattern inference > none.
 * This is used as the fallback when 17track is unavailable or pending.
 */
export function resolveTrackingForFulfillment(
  fulfillment: OrderFulfillmentFacts,
): TrackingFacts {
  const trackingNumber = fulfillment.trackingNumbers[0] ?? null;
  const trackingUrl = fulfillment.trackingUrls[0] ?? null;
  const carrier = fulfillment.carrier ?? null;

  if (trackingUrl) {
    return {
      source: "shopify_url",
      carrier,
      trackingNumber,
      trackingUrl,
      status: fulfillment.status ?? null,
      inferred: false,
    };
  }

  if (carrier && trackingNumber) {
    return {
      source: "shopify_carrier",
      carrier,
      trackingNumber,
      trackingUrl: null,
      status: fulfillment.status ?? null,
      inferred: false,
    };
  }

  if (trackingNumber) {
    const guess = CARRIER_PATTERNS.find((p) => p.re.test(trackingNumber));
    if (guess) {
      return {
        source: "pattern_guess",
        carrier: guess.carrier,
        trackingNumber,
        trackingUrl: guess.urlFor ? guess.urlFor(trackingNumber) : null,
        status: fulfillment.status ?? null,
        inferred: true,
      };
    }
    return {
      source: "pattern_guess",
      carrier: null,
      trackingNumber,
      trackingUrl: null,
      status: fulfillment.status ?? null,
      inferred: true,
    };
  }

  return { source: "none", inferred: false };
}

/**
 * @deprecated Use resolveTrackingForFulfillment directly.
 * Kept for backward-compatibility with context-crawler.
 */
export function resolveTracking(order: OrderFacts | null): TrackingFacts | null {
  if (!order) return null;
  const fulfillment = order.fulfillments[0];
  if (!fulfillment) return null;
  return resolveTrackingForFulfillment(fulfillment);
}
