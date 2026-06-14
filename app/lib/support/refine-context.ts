import type { FulfillmentTrackingFacts, OrderFacts, OrderLineItemFacts, SupportAnalysis, Warning } from "./types";
import { computeUnfulfilledItems } from "./fulfillment";

const MAX_LINE_ITEMS = 5;

// Warning codes worth surfacing to the Refine LLM. Cosmetic/infra codes
// (llm_fallback, crawl_*) are excluded — they don't change what the
// merchant should write to the customer.
const REFINE_VISIBLE_WARNINGS = new Set([
  "ambiguous_match",
  "no_order_match",
  "no_identifiers",
  "no_fulfillment",
  "inferred_carrier",
  "shopify_api_error",
  "tracking_lookup_error",
]);

function renderOrderSection(order: OrderFacts): string {
  const lines: string[] = ["=== ORDER ==="];

  const created = order.createdAt
    ? ` — placed ${order.createdAt.slice(0, 10)}`
    : "";
  lines.push(`Order: ${order.name}${created}`);

  const status = order.displayFulfillmentStatus ?? "unknown";
  const financial = order.displayFinancialStatus
    ? ` (${order.displayFinancialStatus})`
    : "";
  lines.push(`Status: ${status}${financial}`);

  if (order.lineItems.length > 0) {
    lines.push("Items:");
    const shown = order.lineItems.slice(0, MAX_LINE_ITEMS);
    for (const item of shown) {
      lines.push(`  • ${item.quantity}× ${item.title}`);
    }
    if (order.lineItems.length > MAX_LINE_ITEMS) {
      lines.push(`  + ${order.lineItems.length - MAX_LINE_ITEMS} more`);
    }
  }

  if (order.customerName || order.customerEmail) {
    const name = order.customerName ?? "";
    const email = order.customerEmail ? `<${order.customerEmail}>` : "";
    lines.push(`Customer: ${[name, email].filter(Boolean).join(" ")}`);
  }

  return lines.join("\n");
}

function renderUnfulfilledSection(items: OrderLineItemFacts[]): string | null {
  if (items.length === 0) return null;
  const lines: string[] = ["=== NOT YET SHIPPED ==="];
  for (const item of items.slice(0, MAX_LINE_ITEMS)) {
    lines.push(`  • ${item.quantity}× ${item.title}`);
  }
  if (items.length > MAX_LINE_ITEMS) {
    lines.push(`  + ${items.length - MAX_LINE_ITEMS} more`);
  }
  lines.push("These items have no tracking yet — do not imply they have shipped.");
  return lines.join("\n");
}

function renderTrackingSection(t: FulfillmentTrackingFacts): string | null {
  if (!t.trackingNumber) return null;

  const lines: string[] = ["=== TRACKING ==="];
  const carrier = t.carrier ? ` (${t.carrier})` : "";
  lines.push(`${t.trackingNumber}${carrier}`);

  if (t.status) lines.push(`Status: ${t.status}`);

  // Prefer agentStatus (richer) over the raw last* fields when present.
  const lastEvent = t.agentStatus?.lastEvent ?? t.lastEvent ?? null;
  const lastLocation = t.agentStatus?.lastLocation ?? t.lastLocation ?? null;
  const lastDate = t.lastEventDate ?? null;
  if (lastEvent) {
    const dateStr = lastDate ? `${lastDate.slice(0, 10)} — ` : "";
    const locStr = lastLocation ? ` (${lastLocation})` : "";
    lines.push(`Last event: ${dateStr}${lastEvent}${locStr}`);
  }

  const eta = t.agentStatus?.estimatedDelivery;
  if (eta) lines.push(`ETA: ${eta}`);

  return lines.join("\n");
}

function renderWarningsSection(warnings: Warning[]): string | null {
  const visible = warnings.filter((w) => REFINE_VISIBLE_WARNINGS.has(w.code));
  if (visible.length === 0) return null;
  return ["=== WARNINGS ===", ...visible.map((w) => `- ${w.code}: ${w.message}`)].join("\n");
}

/**
 * Build a compact, English plain-text summary of the verified facts in
 * `analysis`. Fed into the Refine LLM call so it can rewrite the draft
 * without inventing or contradicting order/tracking data.
 *
 * Returns `null` when there is nothing useful to say — caller should
 * then omit the context block from the prompt entirely.
 *
 * Section labels stay in English on purpose: the LLM handles stable
 * tags ("ORDER", "TRACKING") more reliably than translated headers,
 * and the surrounding draft language is enforced by the system prompt
 * in refineDraft.
 */
export function buildRefineContext(analysis: SupportAnalysis): string | null {
  const sections: string[] = [];

  if (analysis.order) {
    sections.push(renderOrderSection(analysis.order));
  }

  const unfulfilledBlock = renderUnfulfilledSection(computeUnfulfilledItems(analysis.order));
  if (unfulfilledBlock) sections.push(unfulfilledBlock);

  for (const t of analysis.trackings) {
    const block = renderTrackingSection(t);
    if (block) sections.push(block);
  }

  const warningsBlock = renderWarningsSection(analysis.warnings);
  if (warningsBlock) sections.push(warningsBlock);

  if (sections.length === 0) return null;
  return sections.join("\n\n");
}
