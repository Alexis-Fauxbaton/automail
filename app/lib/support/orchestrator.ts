import { scoreConfidence } from "./confidence-scoring";
import { llmParseEmail } from "./llm-parser";
import { parseMessage } from "./message-parser";
import { buildDraft } from "./response-draft";
import {
  type AdminGraphqlClient,
  searchOrders,
} from "./shopify/order-search";
import { normalizeOrder } from "./shopify/order-normalizer";
import { enrichTrackingWithAgent } from "./tracking/tracking-agent";
import { getTrackingFacts } from "./tracking/tracking-service";
import type { SupportAnalysis, SupportIntent, Warning } from "./types";

export interface AnalyzeInput {
  subject: string;
  body: string;
  admin: AdminGraphqlClient;
}

/** Intents that benefit from live tracking page enrichment. */
const TRACKING_INTENTS: SupportIntent[] = [
  "where_is_my_order",
  "delivery_delay",
  "marked_delivered_not_received",
  "package_stuck",
];

/**
 * Orchestrates the full support pipeline:
 * parse → LLM extract+classify → Shopify search → normalize
 *       → tracking (Shopify) → tracking agent (live fetch) → score → draft
 */
export async function analyzeSupportEmail(
  input: AnalyzeInput,
): Promise<SupportAnalysis> {
  const warnings: Warning[] = [];

  // 1. Parse + LLM extraction (falls back to regex if no API key)
  const parsed = parseMessage(input.subject, input.body);
  const { intent, identifiers, usedLLM } = await llmParseEmail(parsed);

  if (!usedLLM) {
    warnings.push({
      code: "llm_fallback",
      message:
        "OpenAI API key not configured or call failed — using regex parser as fallback.",
    });
  }

  // 2. Shopify order search — any API failure becomes a soft warning
  let matchedBy: Awaited<ReturnType<typeof searchOrders>>["matchedBy"] = null;
  let candidates: ReturnType<typeof normalizeOrder>[] = [];
  try {
    const result = await searchOrders(input.admin, identifiers);
    matchedBy = result.matchedBy;
    candidates = result.orders.map(normalizeOrder);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warnings.push({
      code: "shopify_api_error",
      message: `Shopify order search failed: ${detail}`,
    });
    console.error("[support/orchestrator] Shopify search failed:", err);
  }

  const order = candidates[0] ?? null;

  // 3. Tracking — Shopify data first
  let tracking: Awaited<ReturnType<typeof getTrackingFacts>> = null;
  try {
    tracking = await getTrackingFacts(order);
  } catch (err) {
    warnings.push({
      code: "tracking_lookup_error",
      message: "Tracking lookup failed; proceeding with Shopify-only data.",
    });
    console.error("[support/orchestrator] Tracking lookup failed:", err);
  }

  // 4. Tracking agent — live page fetch + LLM parse
  //    Only when the intent is tracking-related and we have a URL to visit
  if (tracking && TRACKING_INTENTS.includes(intent)) {
    try {
      tracking = await enrichTrackingWithAgent(tracking);
    } catch (err) {
      warnings.push({
        code: "tracking_agent_error",
        message: "Live tracking check failed; using Shopify data only.",
      });
      console.error("[support/orchestrator] Tracking agent failed:", err);
    }
  }

  // 5. Score confidence
  const scoring = scoreConfidence({
    identifiers,
    matchedBy,
    order,
    candidatesCount: candidates.length,
    tracking,
  });

  const allWarnings = [...warnings, ...scoring.warnings];

  const analysisWithoutDraft = {
    intent,
    identifiers,
    order,
    orderCandidates: candidates,
    tracking,
    confidence: scoring.confidence,
    warnings: allWarnings,
  };

  const draftReply = buildDraft(analysisWithoutDraft);

  return { ...analysisWithoutDraft, draftReply };
}
