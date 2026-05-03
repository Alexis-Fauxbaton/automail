// Pure helpers used by the manual classification edit server action.
// Keep this module dependency-light: no Prisma, no Shopify client.

import { SUPPORT_INTENTS, type SupportIntent } from "./types";
import type { OrderFacts } from "./types";

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
