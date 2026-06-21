import { scoreConfidence } from "./confidence-scoring";
import { buildCrawlTasks, crawlContexts } from "./crawl/context-crawler";
import type { CrawledContext } from "./crawl/context-crawler";
import { detectEndOfLoop } from "./end-of-loop";
import { llmParseEmail } from "./llm-parser";
import { generateLLMDraft } from "./llm-draft";
import { parseMessage } from "./message-parser";
import { DEFAULT_SETTINGS, getSettings, type SupportSettings } from "./settings";
import type { TrackedCallContext } from "../llm/client";
import { createLogger } from "../log/logger";
import {
  type AdminGraphqlClient,
  searchOrders,
} from "./shopify/order-search";
import { normalizeOrder } from "./shopify/order-normalizer";
import { getTrackingFacts } from "./tracking/tracking-service";
import type { ConversationMessage, ConversationMeta, ExtractedIdentifiers, FulfillmentTrackingFacts, OrderFacts, SupportAnalysis, SupportIntent, Warning } from "./types";

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
  /**
   * The merchant's connected mailbox address (e.g. info@ambienthome.fr).
   * When provided, it is excluded from the extracted "customer email" so a
   * quoted reply chain ("On <date>, MERCHANT <merchant@store.com> wrote:")
   * doesn't get parsed as the customer's address.
   */
  mailboxAddress?: string;
  /** Optional context for LLM cost tracking (emailId, threadId). */
  trackedCallContext?: Partial<TrackedCallContext>;
  /**
   * Identifiers already resolved at the canonical thread level
   * (Thread.resolved*). When confidence is "medium" or "high" they
   * override the per-message parser output — see spec §3C (full-thread
   * parse only as fallback when nothing was resolved cheaply).
   */
  threadResolution?: {
    identifiers: ExtractedIdentifiers;
    confidence: "none" | "low" | "medium" | "high";
  };
  /**
   * When true, skip the LLM draft generation step (step 6).
   * Use this during background auto-sync to avoid generating drafts
   * automatically — the user must click "Generate draft" explicitly.
   */
  skipDraft?: boolean;
  /**
   * When true, skip the tracking lookup (17track) and the live context
   * crawler. Shopify order search still runs so the matched order remains
   * displayable. Intent and identifiers are always extracted.
   * Use this for resolved threads during resync — tracking freshness has
   * no value once the conversation is closed, but seeing the linked order
   * stays useful.
   */
  skipTracking?: boolean;
  /**
   * When provided, skip step 1 (llmParseEmail) and use these values
   * instead. The supplied identifiers are used for any downstream steps
   * (e.g. Shopify search) if reuseOrder is not also provided.
   * Use this when the caller already has a valid intent classification
   * and wants to avoid an unnecessary LLM call.
   */
  reuseIntents?: {
    intent: SupportIntent;
    intents: SupportIntent[];
    identifiers: ExtractedIdentifiers;
  };
  /**
   * When provided, skip step 2 (Shopify order search) and use these
   * values instead. The supplied order is forwarded to the tracking
   * step so tracking can still refresh.
   * Use this when the caller already has a valid order match and wants
   * to avoid an unnecessary Shopify API call.
   */
  reuseOrder?: {
    order: OrderFacts | null;
    orderCandidates: OrderFacts[];
  };
  /**
   * Tracking facts from the previous analysis run.
   * When provided, a transient 17track failure for a tracking number that
   * previously had a good `source: "seventeen_track"` result will preserve
   * that data rather than downgrading it to a Shopify fallback.
   * Pass `undefined` (or omit) to keep today's behaviour.
   */
  previousTrackings?: FulfillmentTrackingFacts[];
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
  const log = createLogger({
    shop: input.shop ?? "<unknown>",
    mod: "orchestrator",
    ...(input.trackedCallContext?.emailId
      ? { emailId: input.trackedCallContext.emailId }
      : {}),
    ...(input.trackedCallContext?.threadId
      ? { threadId: input.trackedCallContext.threadId }
      : {}),
  });

  // 0. Load per-shop settings
  let settings: SupportSettings | undefined = input.settings;
  if (!settings && input.shop) {
    try {
      settings = await getSettings(input.shop);
    } catch (err) {
      log.error({ err }, "Could not load settings");
    }
  }
  const resolvedSettings: SupportSettings =
    settings ?? { shop: input.shop ?? "", ...DEFAULT_SETTINGS };

  const tctx: Partial<TrackedCallContext> = { shop: input.shop, ...input.trackedCallContext };

  // 1. Parse + LLM extraction (regex fallback built-in)
  //    Skipped when reuseIntents is provided — the caller supplies intent,
  //    intents, and identifiers from a previous analysis, avoiding the LLM call.
  const parsed = parseMessage(input.subject, input.body);
  let intent: SupportIntent;
  let intents: SupportIntent[];
  let identifiers: ExtractedIdentifiers;

  if (input.reuseIntents) {
    intent = input.reuseIntents.intent;
    intents = input.reuseIntents.intents;
    identifiers = input.reuseIntents.identifiers;
  } else {
    const { intent: llmIntent, intents: llmIntents, identifiers: parserIdentifiers, usedLLM } =
      await llmParseEmail(parsed, tctx, input.mailboxAddress);

    // Merge thread-level resolved identifiers on top when confidence is
    // strong. This implements spec §3C: prefer the thread's consolidated
    // state over re-parsing the full thread body on every call.
    const threadRes = input.threadResolution;
    const strongThread =
      threadRes && (threadRes.confidence === "medium" || threadRes.confidence === "high");
    identifiers = strongThread
      ? { ...parserIdentifiers, ...pruneEmpty(threadRes.identifiers) }
      : { ...pruneEmpty(threadRes?.identifiers ?? {}), ...parserIdentifiers };

    if (!usedLLM) {
      warnings.push({
        code: "llm_fallback",
        message: "OpenAI key not set — using regex parser as fallback.",
      });
    }

    intent = llmIntent;
    intents = llmIntents;
  }

  // 2. Shopify order search
  //    Skipped when reuseOrder is provided — the caller supplies the previous
  //    order and candidates to avoid an unnecessary Shopify API call.
  let matchedBy: Awaited<ReturnType<typeof searchOrders>>["matchedBy"] = null;
  let candidates: ReturnType<typeof normalizeOrder>[] = [];
  if (input.reuseOrder) {
    candidates = input.reuseOrder.orderCandidates;
    // matchedBy stays null — we don't know the original match method,
    // but confidence scoring handles null matchedBy gracefully.
  } else {
    try {
      const result = await searchOrders(input.admin, identifiers, { shop: input.shop });
      matchedBy = result.matchedBy;
      candidates = result.orders.map(normalizeOrder);
    } catch (err) {
      warnings.push({
        code: "shopify_api_error",
        message: "Shopify order search failed.",
      });
      log.error({ err }, "Shopify search failed");
    }
  }

  // Auto-select the matched order only when we're confident it's the right
  // one. When the match is weak (multiple email candidates, or any name-only
  // match — names can collide between distinct customers), leave `order =
  // null` and force the agent to pick manually from `orderCandidates`.
  let order: ReturnType<typeof normalizeOrder> | null;
  if (input.reuseOrder) {
    order = input.reuseOrder.order;
  } else if (candidates.length === 0) {
    order = null;
  } else if (matchedBy === "orderNumber" || matchedBy === "trackingNumber") {
    order = candidates[0];
  } else if (matchedBy === "email" && candidates.length === 1) {
    order = candidates[0];
  } else {
    // matchedBy === "customerName" (always manual) or
    // matchedBy === "email" with >1 candidate (ambiguous).
    order = null;
  }

  // 3. Tracking facts — one entry per fulfillment, 17track first
  let trackings: FulfillmentTrackingFacts[] = [];
  if (!input.skipTracking) {
    try {
      trackings = await getTrackingFacts(order, { previousTrackings: input.previousTrackings });
    } catch (err) {
      warnings.push({
        code: "tracking_lookup_error",
        message: "Tracking lookup failed; using Shopify-only data.",
      });
      log.error({ err }, "Tracking lookup failed");
    }
  }

  // 4. Context crawler — fetch and extract relevant live data
  let crawledContexts: CrawledContext[] = [];
  if (!input.skipTracking) {
    try {
      const tasks = buildCrawlTasks(intent, trackings, order);
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
      log.error({ err }, "Crawler failed");
    }
  }

  // 5. Confidence scoring
  const scoring = scoreConfidence({
    identifiers,
    matchedBy,
    order,
    candidatesCount: candidates.length,
    trackings,
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
  // Skipped when skipDraft=true (e.g. background auto-sync — draft is
  // generated on demand when the user clicks "Generate draft").
  const draftReply =
    input.skipDraft || endOfLoop.noReplyNeeded
      ? ""
      : await generateLLMDraft({
          parsed,
          intent,
          order,
          orderCandidates: candidates,
          trackings,
          crawledContexts: crawledContexts.filter((c) => c.success),
          warnings: allWarnings,
          settings: resolvedSettings,
          conversationMessages: input.conversationMessages,
          trackedCallContext: tctx,
        });

  return {
    intent,
    intents,
    identifiers,
    order,
    orderCandidates: candidates,
    trackings,
    confidence: scoring.confidence,
    warnings: allWarnings,
    draftReply,
    conversation: conversationMeta,
    crawledContexts,
  };
}

/** Drop undefined/empty-string fields so they don't overwrite real values. */
function pruneEmpty(obj: ExtractedIdentifiers): ExtractedIdentifiers {
  const out: ExtractedIdentifiers = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      (out as Record<string, string>)[k] = v as string;
    }
  }
  return out;
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
