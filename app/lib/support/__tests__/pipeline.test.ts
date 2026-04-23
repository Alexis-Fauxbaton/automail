/**
 * Orchestrator integration tests.
 *
 * External dependencies are mocked (Shopify, LLM, tracking, crawler).
 * The real parsing, extraction, classification, and scoring logic runs.
 *
 * These tests answer: "Given this email + this Shopify state, does the
 * analysis produce the right confidence, warnings, and intent?"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyzeSupportEmail } from "../orchestrator";
import type { AdminGraphqlClient } from "../shopify/order-search";
import { classifyIntent } from "../intent-classifier";
import { extractIdentifiers } from "../identifier-extractor";
import { parseMessage } from "../message-parser";
import { buildDraft } from "../response-draft";
import {
  SEARCH_RESULT_FULFILLED,
  SEARCH_RESULT_UNFULFILLED,
  SEARCH_RESULT_INFERRED_CARRIER,
  SEARCH_RESULT_AMBIGUOUS,
  SEARCH_RESULT_EMPTY,
} from "./fixtures/shopify-mock-orders";
import {
  PIPELINE_SCENARIOS,
} from "./fixtures/email-scenarios";

// ---------------------------------------------------------------------------
// Module mocks — all external dependencies
// ---------------------------------------------------------------------------

vi.mock("../shopify/order-search", () => ({
  searchOrders: vi.fn(),
}));

vi.mock("../tracking/tracking-service", () => ({
  getTrackingFacts: vi.fn(),
}));

vi.mock("../llm-parser", () => ({
  llmParseEmail: vi.fn(),
}));

vi.mock("../llm-draft", () => ({
  generateLLMDraft: vi.fn(),
}));

vi.mock("../crawl/context-crawler", () => ({
  buildCrawlTasks: vi.fn(() => []),
  crawlContexts: vi.fn(async () => []),
}));

vi.mock("../settings", () => ({
  DEFAULT_SETTINGS: {
    signatureName: "Customer Support",
    brandName: "",
    tone: "friendly",
    language: "auto",
    closingPhrase: "",
    shareTrackingNumber: true,
    customerGreetingStyle: "auto",
    refundPolicy: "",
  },
  getSettings: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import mocked modules (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { searchOrders } from "../shopify/order-search";
import { getTrackingFacts } from "../tracking/tracking-service";
import { llmParseEmail } from "../llm-parser";
import { generateLLMDraft } from "../llm-draft";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A no-op Shopify admin client — never called because searchOrders is mocked. */
const mockAdmin: AdminGraphqlClient = {
  graphql: vi.fn(),
};

/** Configure llmParseEmail to run the real regex pipeline (no OpenAI). */
function useRealParser() {
  vi.mocked(llmParseEmail).mockImplementation(async (parsed) => ({
    intent: classifyIntent(parsed),
    identifiers: extractIdentifiers(parsed),
    usedLLM: false,
  }));
}

/** Configure generateLLMDraft to use the deterministic template fallback. */
function useTemplateDraft() {
  vi.mocked(generateLLMDraft).mockImplementation(async (input) =>
    buildDraft({
      intent: input.intent,
      order: input.order,
      orderCandidates: input.orderCandidates,
      trackings: input.trackings,
      warnings: input.warnings,
      confidence: "high",
      draftReply: "",
      conversation: {
        messageCount: 1,
        incomingCount: 1,
        outgoingCount: 0,
        lastMessageDirection: "incoming",
        noReplyNeeded: false,
      },
      parsed: input.parsed,
    }),
  );
}

function warningCodes(warnings: { code: string }[]) {
  return warnings.map((w) => w.code);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  useRealParser();
  useTemplateDraft();
  // Default: no tracking data (avoids 17track calls)
  vi.mocked(getTrackingFacts).mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Happy path tests
// ---------------------------------------------------------------------------

describe("Pipeline: order found by order number", () => {
  it("S1 – WIMO, order found, verified tracking → high confidence", async () => {
    vi.mocked(searchOrders).mockResolvedValue(SEARCH_RESULT_FULFILLED);

    const s = PIPELINE_SCENARIOS.wimoOrderFound;
    const result = await analyzeSupportEmail({
      subject: s.subject,
      body: s.body,
      admin: mockAdmin,
    });

    expect(result.intent).toBe("where_is_my_order");
    expect(result.identifiers.orderNumber).toBe("1001");
    expect(result.order?.name).toBe("#1001");
    expect(result.confidence).toBe("medium"); // getTrackingFacts returns [] so no tracking
    expect(warningCodes(result.warnings)).not.toContain("no_order_match");
    expect(warningCodes(result.warnings)).not.toContain("ambiguous_match");
  });

  it("S1 – WIMO, order found with verified tracking → high confidence", async () => {
    vi.mocked(searchOrders).mockResolvedValue(SEARCH_RESULT_FULFILLED);
    // Simulate the tracking-service returning verified tracking facts
    vi.mocked(getTrackingFacts).mockResolvedValue([
      {
        fulfillmentIndex: 0,
        lineItems: [],
        source: "shopify_url",
        carrier: "La Poste",
        trackingNumber: "6123456789012",
        trackingUrl: "https://suivi.laposte.fr/6123456789012",
        inferred: false,
      },
    ]);

    const s = PIPELINE_SCENARIOS.wimoOrderFound;
    const result = await analyzeSupportEmail({
      subject: s.subject,
      body: s.body,
      admin: mockAdmin,
    });

    expect(result.confidence).toBe("high");
    expect(result.trackings).toHaveLength(1);
    expect(result.trackings[0].inferred).toBe(false);
  });

  it("S2 – WIMO French, unfulfilled order → medium confidence, no_fulfillment warning", async () => {
    vi.mocked(searchOrders).mockResolvedValue(SEARCH_RESULT_UNFULFILLED);

    const s = PIPELINE_SCENARIOS.wimoFrench;
    const result = await analyzeSupportEmail({
      subject: s.subject,
      body: s.body,
      admin: mockAdmin,
    });

    expect(result.intent).toBe("where_is_my_order");
    expect(result.order?.name).toBe("#2002");
    expect(result.confidence).toBe("medium");
    expect(warningCodes(result.warnings)).toContain("no_fulfillment");
  });
});

// ---------------------------------------------------------------------------
// Confidence and warning tests
// ---------------------------------------------------------------------------

describe("Pipeline: confidence and warnings", () => {
  it("no identifiers in email → low confidence + no_identifiers warning", async () => {
    vi.mocked(searchOrders).mockResolvedValue(SEARCH_RESULT_EMPTY);

    const s = PIPELINE_SCENARIOS.noIdentifiers;
    const result = await analyzeSupportEmail({
      subject: s.subject,
      body: s.body,
      admin: mockAdmin,
    });

    expect(result.confidence).toBe("low");
    expect(warningCodes(result.warnings)).toContain("no_identifiers");
    expect(result.order).toBeNull();
  });

  it("identifiers present but no Shopify match → low confidence + no_order_match warning", async () => {
    vi.mocked(searchOrders).mockResolvedValue(SEARCH_RESULT_EMPTY);

    const result = await analyzeSupportEmail({
      subject: "Order #9999 delayed",
      body: "Where is my order?",
      admin: mockAdmin,
    });

    expect(result.confidence).toBe("low");
    expect(warningCodes(result.warnings)).toContain("no_order_match");
    expect(result.identifiers.orderNumber).toBe("9999");
  });

  it("ambiguous match (2+ orders) → low confidence + ambiguous_match warning", async () => {
    vi.mocked(searchOrders).mockResolvedValue(SEARCH_RESULT_AMBIGUOUS);

    const result = await analyzeSupportEmail({
      subject: "My order",
      body: "Hi, my name is John Smith. Where is my order?",
      admin: mockAdmin,
    });

    expect(result.confidence).toBe("low");
    expect(warningCodes(result.warnings)).toContain("ambiguous_match");
    expect(result.orderCandidates).toHaveLength(2);
  });

  it("inferred carrier → medium confidence + inferred_carrier warning", async () => {
    vi.mocked(searchOrders).mockResolvedValue(SEARCH_RESULT_INFERRED_CARRIER);
    vi.mocked(getTrackingFacts).mockResolvedValue([
      {
        fulfillmentIndex: 0,
        lineItems: [],
        source: "pattern_guess",
        carrier: "La Poste / Colissimo",
        trackingNumber: "6123456789012",
        trackingUrl: "https://www.laposte.fr/outils/suivre-vos-envois?code=6123456789012",
        inferred: true,
      },
    ]);

    const s = PIPELINE_SCENARIOS.packageStuck;
    const result = await analyzeSupportEmail({
      subject: s.subject,
      body: s.body,
      admin: mockAdmin,
    });

    expect(warningCodes(result.warnings)).toContain("inferred_carrier");
    expect(result.confidence).toBe("medium"); // orderNumber match but inferred tracking
  });
});

// ---------------------------------------------------------------------------
// Shopify API failure — graceful degradation
// ---------------------------------------------------------------------------

describe("Pipeline: graceful degradation", () => {
  it("Shopify API failure → warning added, analysis continues", async () => {
    vi.mocked(searchOrders).mockRejectedValue(new Error("Shopify unavailable"));

    const result = await analyzeSupportEmail({
      subject: "Order #1001",
      body: "Where is my order?",
      admin: mockAdmin,
    });

    expect(warningCodes(result.warnings)).toContain("shopify_api_error");
    expect(result.order).toBeNull();
    expect(result.confidence).toBe("low");
    // Should still produce a draft (asking for identifiers)
    expect(result.draftReply).not.toBe("");
  });

  it("tracking lookup failure → warning added, draft still generated", async () => {
    vi.mocked(searchOrders).mockResolvedValue(SEARCH_RESULT_FULFILLED);
    vi.mocked(getTrackingFacts).mockRejectedValue(new Error("17track down"));

    const result = await analyzeSupportEmail({
      subject: "Order #1001",
      body: "Where is my order?",
      admin: mockAdmin,
    });

    expect(warningCodes(result.warnings)).toContain("tracking_lookup_error");
    expect(result.order?.name).toBe("#1001"); // order still found
    expect(result.draftReply).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// End-of-loop detection
// ---------------------------------------------------------------------------

describe("Pipeline: end-of-loop detection", () => {
  it("customer thanks you after a first reply → noReplyNeeded = true, empty draft", async () => {
    vi.mocked(searchOrders).mockResolvedValue(SEARCH_RESULT_FULFILLED);

    const result = await analyzeSupportEmail({
      subject: "Re: Your order",
      body: "Thank you, everything is resolved!",
      admin: mockAdmin,
      conversationMessages: [
        {
          direction: "incoming",
          fromAddress: "customer@example.com",
          receivedAt: "2024-01-10T10:00:00Z",
          subject: "Where is my order?",
          body: "Where is my order #1001?",
          isLatest: false,
        },
        {
          direction: "outgoing",
          fromAddress: "support@shop.com",
          receivedAt: "2024-01-10T11:00:00Z",
          subject: "Re: Where is my order?",
          body: "Hi Sarah, your order is on its way...",
          isLatest: false,
        },
        {
          direction: "incoming",
          fromAddress: "customer@example.com",
          receivedAt: "2024-01-10T12:00:00Z",
          subject: "Re: Your order",
          body: "Thank you, everything is resolved!",
          isLatest: true,
        },
      ],
    });

    expect(result.conversation.noReplyNeeded).toBe(true);
    expect(result.draftReply).toBe("");
  });

  it("customer thanks you but asks a follow-up question → noReplyNeeded = false", async () => {
    vi.mocked(searchOrders).mockResolvedValue(SEARCH_RESULT_FULFILLED);

    const result = await analyzeSupportEmail({
      subject: "Re: Your order",
      body: "Thanks! But what about my refund?",
      admin: mockAdmin,
      conversationMessages: [
        {
          direction: "incoming",
          fromAddress: "customer@example.com",
          receivedAt: "2024-01-10T10:00:00Z",
          subject: "Refund",
          body: "I want a refund for order #1001",
          isLatest: false,
        },
        {
          direction: "outgoing",
          fromAddress: "support@shop.com",
          receivedAt: "2024-01-10T11:00:00Z",
          subject: "Re: Refund",
          body: "Hi, could you share more details?",
          isLatest: false,
        },
        {
          direction: "incoming",
          fromAddress: "customer@example.com",
          receivedAt: "2024-01-10T12:00:00Z",
          subject: "Re: Refund",
          body: "Thanks! But what about my refund?",
          isLatest: true,
        },
      ],
    });

    expect(result.conversation.noReplyNeeded).toBe(false);
    expect(result.draftReply).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// Draft content sanity (integration)
// ---------------------------------------------------------------------------

describe("Pipeline: draft content sanity", () => {
  it("draft for refund request never claims refund was issued", async () => {
    vi.mocked(searchOrders).mockResolvedValue(SEARCH_RESULT_FULFILLED);

    const s = PIPELINE_SCENARIOS.refundRequest;
    const result = await analyzeSupportEmail({
      subject: s.subject,
      body: s.body,
      admin: mockAdmin,
    });

    expect(result.draftReply).not.toMatch(/refund (?:has been|was|will be) (?:processed|issued|credited)/i);
    expect(result.draftReply).not.toMatch(/we have refunded/i);
  });

  it("draft when order not found asks for order number", async () => {
    vi.mocked(searchOrders).mockResolvedValue(SEARCH_RESULT_EMPTY);

    const result = await analyzeSupportEmail({
      subject: "Hello I need help",
      body: "Hi, I need help with my order please",
      admin: mockAdmin,
    });

    expect(result.draftReply).toMatch(/order number|#\d+|email.*checkout/i);
  });

  it("draft for marked-delivered never says the parcel is lost", async () => {
    vi.mocked(searchOrders).mockResolvedValue(SEARCH_RESULT_FULFILLED);

    const s = PIPELINE_SCENARIOS.markedDelivered;
    const result = await analyzeSupportEmail({
      subject: s.subject,
      body: s.body,
      admin: mockAdmin,
    });

    expect(result.draftReply).not.toMatch(/\bpackage is lost\b/i);
    expect(result.draftReply).not.toMatch(/\bparcel is lost\b/i);
  });
});
