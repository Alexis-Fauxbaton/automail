import { scoreConfidence } from "./confidence-scoring";
import { buildCrawlTasks, crawlContexts } from "./crawl/context-crawler";
import type { CrawledContext } from "./crawl/context-crawler";
import { detectEndOfLoop } from "./end-of-loop";
import { llmParseEmail } from "./llm-parser";
import { generateLLMDraft } from "./llm-draft";
import { parseMessage } from "./message-parser";
import { getSettings, type SupportSettings } from "./settings";
import type { TrackedCallContext } from "../llm/client";
import {
  type AdminGraphqlClient,
  searchOrders,
} from "./shopify/order-search";
import { normalizeOrder } from "./shopify/order-normalizer";
import { getTrackingFacts } from "./tracking/tracking-service";
import type { ConversationMessage, ConversationMeta, SupportAnalysis, Warning } from "./types";

export interface AnalyzeInput {
  subject: string;
  body: string;
  admin: AdminGraphqlClient;
  /** Ordered conversation messages (oldest first) when available. */
  conversationMessages?: ConversationMessage[];
  /** Shop domain — used to load per-shop draft settings. */
  shop?: string;
  /** Pre-loaded settings (overrides shop lookup when provided). */
  settings?: SupportSettings;
  /** Optional context for LLM cost tracking (emailId, threadId). */
  trackedCallContext?: Partial<TrackedCallContext>;
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
  const conversation = buildConversationMeta(input.conversationMessages);

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

  const tctx: Partial<TrackedCallContext> = { shop: input.shop, ...input.trackedCallContext };

  // 1. Parse + LLM extraction (regex fallback built-in)
  const parsed = parseMessage(input.subject, input.body);
  const { intent, identifiers, usedLLM } = await llmParseEmail(parsed, tctx);

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
    warnings.push({
      code: "shopify_api_error",
      message: "Shopify order search failed.",
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
    crawledContexts = await crawlContexts(tasks, tctx);
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

  const latestMessage = input.conversationMessages?.find((m) => m.isLatest);
  const endOfLoop = detectEndOfLoop({
    latestMessageBody: latestMessage?.body ?? input.body,
    incomingCount: conversation.incomingCount,
    lastMessageDirection: conversation.lastMessageDirection,
  });

  const conversationMeta: ConversationMeta = {
    ...conversation,
    noReplyNeeded: endOfLoop.noReplyNeeded,
    noReplyReason: endOfLoop.reason,
  };

  // 6. LLM draft (template fallback built-in)
  const draftReply = endOfLoop.noReplyNeeded
    ? ""
    : await generateLLMDraft({
        parsed,
        intent,
        order,
        orderCandidates: candidates,
        tracking,
        crawledContexts: crawledContexts.filter((c) => c.success),
        warnings: allWarnings,
        settings: resolvedSettings,
        conversationMessages: input.conversationMessages,
        trackedCallContext: tctx,
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
    conversation: conversationMeta,
    crawledContexts,
  };
}

function buildConversationMeta(
  messages: ConversationMessage[] | undefined,
): Omit<ConversationMeta, "noReplyNeeded" | "noReplyReason"> {
  if (!messages || messages.length === 0) {
    return {
      messageCount: 1,
      incomingCount: 1,
      outgoingCount: 0,
      lastMessageDirection: "incoming",
    };
  }

  const incomingCount = messages.filter((m) => m.direction === "incoming").length;
  const outgoingCount = messages.filter((m) => m.direction === "outgoing").length;
  const latest = messages.find((m) => m.isLatest) ?? messages[messages.length - 1];

  return {
    messageCount: messages.length,
    incomingCount,
    outgoingCount,
    lastMessageDirection: latest?.direction ?? "unknown",
  };
}
