import { scoreConfidence } from "./confidence-scoring";
import { buildCrawlTasks, crawlContexts } from "./crawl/context-crawler";
import type { CrawledContext } from "./crawl/context-crawler";
import { llmParseEmail } from "./llm-parser";
import { generateLLMDraft } from "./llm-draft";
import { parseMessage } from "./message-parser";
import { getSettings, type SupportSettings } from "./settings";
import {
  type AdminGraphqlClient,
  searchOrders,
} from "./shopify/order-search";
import { normalizeOrder } from "./shopify/order-normalizer";
import { getTrackingFacts } from "./tracking/tracking-service";
import type { SupportAnalysis, Warning } from "./types";

export interface AnalyzeInput {
  subject: string;
  body: string;
  admin: AdminGraphqlClient;
  /** Shop domain — used to load per-shop draft settings. */
  shop?: string;
  /** Pre-loaded settings (overrides shop lookup when provided). */
  settings?: SupportSettings;
}

export interface SupportAnalysisExtended extends SupportAnalysis {
  /** Contexts retrieved by the crawler, exposed for the UI. */
  crawledContexts: CrawledContext[];
}

/**
 * Full pipeline:
 *  parse → LLM extract+classify → Shopify search → tracking
 *       → context crawler → LLM draft
 */
export async function analyzeSupportEmail(
  input: AnalyzeInput,
): Promise<SupportAnalysisExtended> {
  const warnings: Warning[] = [];

  // 0. Load per-shop settings
  let settings: SupportSettings | undefined = input.settings;
  if (!settings && input.shop) {
    try {
      settings = await getSettings(input.shop);
    } catch (err) {
      console.error("[orchestrator] Could not load settings:", err);
    }
  }
  const resolvedSettings: SupportSettings = settings ?? {
    shop: input.shop ?? "",
    signatureName: "Customer Support",
    brandName: "",
    tone: "friendly",
    language: "auto",
    closingPhrase: "",
    shareTrackingNumber: true,
    customerGreetingStyle: "auto",
    refundPolicy: "",
  };

  // 1. Parse + LLM extraction (regex fallback built-in)
  const parsed = parseMessage(input.subject, input.body);
  const { intent, identifiers, usedLLM } = await llmParseEmail(parsed);

  if (!usedLLM) {
    warnings.push({
      code: "llm_fallback",
      message: "OpenAI key not set — using regex parser as fallback.",
    });
  }

  // 2. Shopify order search
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
    console.error("[orchestrator] Shopify search failed:", err);
  }

  const order = candidates[0] ?? null;

  // 3. Tracking facts (Shopify data)
  let tracking: Awaited<ReturnType<typeof getTrackingFacts>> = null;
  try {
    tracking = await getTrackingFacts(order);
  } catch (err) {
    warnings.push({
      code: "tracking_lookup_error",
      message: "Tracking lookup failed; using Shopify-only data.",
    });
    console.error("[orchestrator] Tracking lookup failed:", err);
  }

  // 4. Context crawler — fetch and extract relevant live data
  let crawledContexts: CrawledContext[] = [];
  try {
    const tasks = buildCrawlTasks(intent, tracking, order);
    crawledContexts = await crawlContexts(tasks);
    const failedCrawls = crawledContexts.filter((c) => !c.success);
    if (failedCrawls.length > 0) {
      warnings.push({
        code: "crawl_partial_failure",
        message: `Could not retrieve live context from: ${failedCrawls.map((c) => c.url).join(", ")}`,
      });
    }
  } catch (err) {
    warnings.push({
      code: "crawl_error",
      message: "Context retrieval failed; draft based on Shopify data only.",
    });
    console.error("[orchestrator] Crawler failed:", err);
  }

  // 5. Confidence scoring
  const scoring = scoreConfidence({
    identifiers,
    matchedBy,
    order,
    candidatesCount: candidates.length,
    tracking,
  });

  const allWarnings = [...warnings, ...scoring.warnings];

  // 6. LLM draft (template fallback built-in)
  const draftReply = await generateLLMDraft({
    parsed,
    intent,
    order,
    orderCandidates: candidates,
    tracking,
    crawledContexts: crawledContexts.filter((c) => c.success),
    warnings: allWarnings,
    settings: resolvedSettings,
  });

  return {
    intent,
    identifiers,
    order,
    orderCandidates: candidates,
    tracking,
    confidence: scoring.confidence,
    warnings: allWarnings,
    draftReply,
    crawledContexts,
  };
}
