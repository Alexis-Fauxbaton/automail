// Pure helpers used by the manual classification edit server action.
// Keep this module dependency-light: no Prisma, no Shopify client.

import { SUPPORT_INTENTS, type SupportIntent, type OrderFacts, type ManualOverrides, type SupportAnalysis } from "./types";
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

export interface ClassificationEdit {
  /** Replace the intents array. Mutually exclusive with resetIntents. */
  intents?: SupportIntent[];
  /** Clear intents and remove the intents override. */
  resetIntents?: boolean;
  /** Replace the linked order. Mutually exclusive with detachOrder/resetOrder. */
  order?: OrderFacts | null;
  /** Set order to null while keeping the override marker (manual detach). */
  detachOrder?: boolean;
  /** Clear order and remove the order override. */
  resetOrder?: boolean;
  /** Injected for deterministic tests. */
  now?: Date;
}

/**
 * Pure transform of an analysis JSON given a classification edit.
 * Caller is responsible for persisting the returned object.
 */
export function applyClassificationEditToAnalysis(
  current: SupportAnalysis,
  edit: ClassificationEdit,
): SupportAnalysis {
  const now = (edit.now ?? new Date()).toISOString();
  const next: SupportAnalysis = { ...current };
  const overrides: ManualOverrides = { ...(current.manualOverrides ?? {}) };

  // Intents
  if (edit.resetIntents) {
    next.intent = "unknown";
    next.intents = [];
    delete overrides.intents;
  } else if (edit.intents) {
    const validated = validateIntentEdit(edit.intents);
    next.intent = validated[0];
    next.intents = validated;
    overrides.intents = { editedAt: now };
  }

  // Order
  if (edit.resetOrder) {
    next.order = null;
    delete overrides.order;
  } else if (edit.detachOrder) {
    next.order = null;
    overrides.order = { editedAt: now };
  } else if (edit.order !== undefined) {
    next.order = edit.order;
    overrides.order = { editedAt: now };
  }

  next.manualOverrides = Object.keys(overrides).length > 0 ? overrides : undefined;
  return next;
}

// Persistence layer — loads, mutates, and saves the analysis to the anchor email.

import prisma from "../../db.server";
import type { Prisma } from "@prisma/client";

export interface PersistClassificationEditInput {
  shop: string;
  threadId: string;
  edit: ClassificationEdit;
}

/**
 * Load the anchor email for the thread, apply the edit to its analysis JSON,
 * and persist the result. Returns the anchor email id and the updated analysis.
 *
 * "Anchor" = the latest analyzed incoming email of the thread. This is the
 * email that holds the canonical analysisResult for the inbox UI.
 */
export async function persistClassificationEdit(
  input: PersistClassificationEditInput,
): Promise<{ emailId: string; analysis: SupportAnalysis }> {
  const { shop, threadId, edit } = input;

  const anchor = await prisma.incomingEmail.findFirst({
    where: {
      shop,
      canonicalThreadId: threadId,
      processingStatus: "analyzed",
      analysisResult: { not: null },
    },
    orderBy: { receivedAt: "desc" },
    select: { id: true, analysisResult: true },
  });

  if (!anchor || !anchor.analysisResult) {
    throw new Error("Thread has no analyzed email to edit");
  }

  const current = JSON.parse(anchor.analysisResult) as SupportAnalysis;
  const next = applyClassificationEditToAnalysis(current, edit);

  const data: Prisma.IncomingEmailUpdateInput = {
    analysisResult: JSON.stringify(next),
    detectedIntent: next.intent,
  };

  await prisma.incomingEmail.update({
    where: { id: anchor.id },
    data,
  });

  // Keep Thread.resolvedOrderNumber aligned with the manual edit so the
  // inbox-list and detail-header badges reflect the new state. Only touch
  // it when the order field was actually edited; intent-only edits leave
  // the resolved order untouched.
  const orderTouched =
    edit.resetOrder === true || edit.detachOrder === true || edit.order !== undefined;
  if (orderTouched) {
    const newOrderNumber = next.order?.name?.replace(/^#/, "") ?? null;
    await prisma.thread.update({
      where: { id: threadId },
      data: { resolvedOrderNumber: newOrderNumber },
    }).catch((err) => {
      console.error("[manual-classification] thread.update failed:", err);
    });
  }

  return { emailId: anchor.id, analysis: next };
}
