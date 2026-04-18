import type { OrderFacts, TrackingFacts } from "../types";
import { resolveTracking } from "./provider-resolver";

/**
 * Facade over tracking providers.
 *
 * For the MVP we intentionally do NOT hit any external carrier API or scrape.
 * We only surface what Shopify already knows and — as a clearly marked
 * fallback — infer a carrier from the tracking number pattern.
 *
 * External adapters (UPS, DHL, La Poste, ...) will plug in here later via
 * `adapters/` without changing callers.
 */
export async function getTrackingFacts(
  order: OrderFacts | null,
): Promise<TrackingFacts | null> {
  return resolveTracking(order);
}
