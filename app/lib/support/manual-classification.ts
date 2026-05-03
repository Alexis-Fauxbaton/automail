// Pure helpers used by the manual classification edit server action.
// Keep this module dependency-light: no Prisma, no Shopify client.

import { SUPPORT_INTENTS, type SupportIntent, type OrderFacts } from "./types";
import { searchOrders, type AdminGraphqlClient } from "./shopify/order-search";
import { normalizeOrder } from "./shopify/order-normalizer";

const ALLOWED = new Set<string>(SUPPORT_INTENTS);

/**
 * Validate and normalize an array of intents coming from the client.
 * Throws on empty array or unknown values. Dedups while preserving order
 * so the first occurrence wins (the first item is the primary intent).
 */
export function validateIntentEdit(input: readonly SupportIntent[]): SupportIntent[] {
  if (input.length === 0) {
    throw new Error("At least one intent is required");
  }
  const seen = new Set<SupportIntent>();
  const out: SupportIntent[] = [];
  for (const value of input) {
    if (!ALLOWED.has(value)) {
      throw new Error(`Unknown intent: ${String(value)}`);
    }
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Find a candidate order by its ID (GID).
 * Returns the matching order or null if not found.
 */
export function findCandidateById(
  candidates: OrderFacts[],
  orderId: string,
): OrderFacts | null {
  return candidates.find((o) => o.id === orderId) ?? null;
}

export type ExactOrderSearchResult =
  | { kind: "found"; order: OrderFacts }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: OrderFacts[] };

/**
 * Search Shopify for an exact order number (with or without the leading `#`).
 * - 0 matches → "not_found"
 * - 1 match → "found"
 * - >1 matches → "ambiguous" (caller must show candidates and ask the user
 *   to pick one)
 */
export async function searchOrderByExactNumber(
  admin: AdminGraphqlClient,
  rawNumber: string,
): Promise<ExactOrderSearchResult> {
  const trimmed = rawNumber.trim().replace(/^#/, "");
  if (trimmed.length === 0) {
    throw new Error("Order number cannot be empty");
  }
  const result = await searchOrders(admin, { orderNumber: trimmed });
  if (result.orders.length === 0) return { kind: "not_found" };
  if (result.orders.length > 1) {
    return { kind: "ambiguous", candidates: result.orders.map(normalizeOrder) };
  }
  return { kind: "found", order: normalizeOrder(result.orders[0]) };
}
