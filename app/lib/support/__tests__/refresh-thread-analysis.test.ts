/**
 * Tests for refreshThreadAnalysis (Path A — fine-grained orchestrator flags).
 *
 * Mocks:
 * - prisma (db.server) — no real DB
 * - analyzeSupportEmail (orchestrator) — no real LLM/Shopify
 * - buildThreadContext + getMailClient (pipeline) — no real mail client
 * - extractAndCache + mergeThreadIdentifiers + getThreadResolution (thread-identifiers)
 *
 * Path B note: tests 5 and 6 (LLM/Shopify mock NOT called) are Path A specific
 * and are included here. They verify that when reclassifyIntent/reSearchOrder
 * is false, analyzeSupportEmail receives reuseIntents/reuseOrder — proving the
 * orchestrator will skip those steps.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupportAnalysis } from "../types";
import type { SupportAnalysisExtended } from "../orchestrator";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../../db.server", () => ({
  default: {
    incomingEmail: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    mailConnection: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    thread: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../orchestrator", () => ({
  analyzeSupportEmail: vi.fn(),
}));

vi.mock("../../gmail/pipeline", () => ({
  buildThreadContext: vi.fn(),
  getMailClient: vi.fn(),
}));

vi.mock("../thread-identifiers", () => ({
  extractAndCache: vi.fn(),
  mergeThreadIdentifiers: vi.fn(),
  getThreadResolution: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

import prisma from "../../../db.server";
import { analyzeSupportEmail } from "../orchestrator";
import { buildThreadContext, getMailClient } from "../../gmail/pipeline";
import { extractAndCache, mergeThreadIdentifiers, getThreadResolution } from "../thread-identifiers";
import { refreshThreadAnalysis } from "../refresh-thread-analysis";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHOP = "test.myshopify.com";
const EMAIL_ID = "email-abc";

function makeAnalysis(overrides: Partial<SupportAnalysis> = {}): SupportAnalysis {
  return {
    intent: "where_is_my_order",
    intents: ["where_is_my_order"],
    identifiers: { orderNumber: "1001" },
    order: {
      id: "gid://Order/1",
      name: "#1001",
      createdAt: "2026-04-01T00:00:00Z",
      customerName: "Alice",
      customerEmail: "alice@example.com",
      lineItems: [],
      fulfillments: [],
    },
    orderCandidates: [],
    trackings: [],
    confidence: "high",
    warnings: [],
    draftReply: "Previous draft",
    conversation: {
      messageCount: 1,
      incomingCount: 1,
      outgoingCount: 0,
      lastMessageDirection: "incoming",
      noReplyNeeded: false,
    },
    ...overrides,
  };
}

function makeExtendedAnalysis(overrides: Partial<SupportAnalysis> = {}): SupportAnalysisExtended {
  return { ...makeAnalysis(overrides), crawledContexts: [] };
}

/** Minimal Prisma record stub */
function makePrismaRecord(analysisResult: SupportAnalysis | null = null) {
  return {
    id: EMAIL_ID,
    shop: SHOP,
    subject: "Where is my order?",
    bodyText: "I haven't received #1001 yet.",
    threadId: "thread-1",
    canonicalThreadId: "canonical-1",
    analysisResult: analysisResult ? JSON.stringify(analysisResult) : null,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: no mail connection
  (prisma.mailConnection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  // Default: buildThreadContext returns minimal context
  (buildThreadContext as ReturnType<typeof vi.fn>).mockResolvedValue({
    body: "Where is my order?",
    messages: [],
  });

  // Default: thread identifier helpers succeed silently
  (extractAndCache as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (mergeThreadIdentifiers as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (getThreadResolution as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  // Default: prisma.update succeeds
  (prisma.incomingEmail.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refreshThreadAnalysis", () => {
  it("throws when email not found", async () => {
    (prisma.incomingEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      refreshThreadAnalysis(EMAIL_ID, {} as never, SHOP, {
        reclassifyIntent: true,
        reSearchOrder: true,
        refreshTracking: true,
      }),
    ).rejects.toThrow("Email not found");
  });

  it("throws when email belongs to a different shop", async () => {
    (prisma.incomingEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePrismaRecord(null),
    );

    await expect(
      refreshThreadAnalysis(EMAIL_ID, {} as never, "other.myshopify.com", {
        reclassifyIntent: true,
        reSearchOrder: true,
        refreshTracking: true,
      }),
    ).rejects.toThrow("Email not found");
  });

  // Test 1 — reclassifyIntent: false → previous intent/intents preserved
  it("preserves previous intent and intents when reclassifyIntent is false", async () => {
    const prevAnalysis = makeAnalysis({
      intent: "refund_request",
      intents: ["refund_request", "damaged_product"],
    });
    (prisma.incomingEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePrismaRecord(prevAnalysis),
    );

    const freshFromOrchestrator = makeExtendedAnalysis({
      // The orchestrator would return a different intent if it ran LLM —
      // but with reuseIntents supplied, analyzeSupportEmail receives the
      // previous values and the orchestrator skips the LLM step.
      // We simulate the orchestrator faithfully returning what it was given.
      intent: "refund_request",
      intents: ["refund_request", "damaged_product"],
      trackings: [
        {
          source: "shopify_carrier",
          carrier: "UPS",
          trackingNumber: "1Z999",
          trackingUrl: null,
          status: "IN_TRANSIT",
          inferred: false,
          fulfillmentIndex: 0,
          lineItems: [],
        },
      ],
    });
    (analyzeSupportEmail as ReturnType<typeof vi.fn>).mockResolvedValue(freshFromOrchestrator);

    const result = await refreshThreadAnalysis(EMAIL_ID, {} as never, SHOP, {
      reclassifyIntent: false,
      reSearchOrder: true,
      refreshTracking: true,
    });

    expect(result.intent).toBe("refund_request");
    expect(result.intents).toEqual(["refund_request", "damaged_product"]);

    // Verify that analyzeSupportEmail received reuseIntents (Path A cost saving)
    const callArg = (analyzeSupportEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.reuseIntents).toEqual({
      intent: "refund_request",
      intents: ["refund_request", "damaged_product"],
      identifiers: prevAnalysis.identifiers,
    });

    // Persisted data should match the result
    const updateCall = (prisma.incomingEmail.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const persisted = JSON.parse(updateCall.data.analysisResult) as SupportAnalysis;
    expect(persisted.intent).toBe("refund_request");
    expect(persisted.intents).toEqual(["refund_request", "damaged_product"]);
  });

  // Test 2 — reSearchOrder: false → previous order/orderCandidates preserved
  it("preserves previous order and orderCandidates when reSearchOrder is false", async () => {
    const prevOrder = {
      id: "gid://Order/99",
      name: "#9999",
      createdAt: "2026-03-01T00:00:00Z",
      customerName: "Bob",
      customerEmail: "bob@example.com",
      lineItems: [],
      fulfillments: [],
    };
    const prevAnalysis = makeAnalysis({
      order: prevOrder,
      orderCandidates: [prevOrder],
    });
    (prisma.incomingEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePrismaRecord(prevAnalysis),
    );

    // Orchestrator returns the order it was given (no Shopify search)
    const freshFromOrchestrator = makeExtendedAnalysis({
      order: prevOrder,
      orderCandidates: [prevOrder],
    });
    (analyzeSupportEmail as ReturnType<typeof vi.fn>).mockResolvedValue(freshFromOrchestrator);

    const result = await refreshThreadAnalysis(EMAIL_ID, {} as never, SHOP, {
      reclassifyIntent: true,
      reSearchOrder: false,
      refreshTracking: true,
    });

    expect(result.order?.id).toBe("gid://Order/99");
    expect(result.orderCandidates).toHaveLength(1);
    expect(result.orderCandidates[0].name).toBe("#9999");

    // Verify reuseOrder was passed to analyzeSupportEmail
    const callArg = (analyzeSupportEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.reuseOrder).toEqual({
      order: prevOrder,
      orderCandidates: [prevOrder],
    });

    const updateCall = (prisma.incomingEmail.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const persisted = JSON.parse(updateCall.data.analysisResult) as SupportAnalysis;
    expect(persisted.order?.name).toBe("#9999");
  });

  // Test 3 — refreshTracking: true → trackings reflect fresh pipeline result
  it("uses fresh trackings from the pipeline result", async () => {
    const prevAnalysis = makeAnalysis({ trackings: [] });
    (prisma.incomingEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePrismaRecord(prevAnalysis),
    );

    const freshTracking = {
      source: "seventeen_track" as const,
      carrier: "DHL",
      trackingNumber: "JD014600005544",
      trackingUrl: "https://track.dhl.com/JD014600005544",
      status: "DELIVERED",
      inferred: false,
      fulfillmentIndex: 0,
      lineItems: [],
    };
    const freshFromOrchestrator = makeExtendedAnalysis({ trackings: [freshTracking] });
    (analyzeSupportEmail as ReturnType<typeof vi.fn>).mockResolvedValue(freshFromOrchestrator);

    const result = await refreshThreadAnalysis(EMAIL_ID, {} as never, SHOP, {
      reclassifyIntent: true,
      reSearchOrder: true,
      refreshTracking: true,
    });

    expect(result.trackings).toHaveLength(1);
    expect(result.trackings[0].carrier).toBe("DHL");
    expect(result.trackings[0].status).toBe("DELIVERED");

    const updateCall = (prisma.incomingEmail.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const persisted = JSON.parse(updateCall.data.analysisResult) as SupportAnalysis;
    expect(persisted.trackings[0].carrier).toBe("DHL");
  });

  // Test 4 — manualOverrides always preserved
  it("always preserves manualOverrides from the previous analysis", async () => {
    const prevAnalysis = makeAnalysis({
      intent: "damaged_product",
      intents: ["damaged_product"],
      manualOverrides: {
        intents: { editedAt: "2026-05-01T12:00:00.000Z" },
        order: { editedAt: "2026-05-02T08:00:00.000Z" },
      },
    });
    (prisma.incomingEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePrismaRecord(prevAnalysis),
    );

    // Orchestrator returns analysis WITHOUT manualOverrides (as it should —
    // manualOverrides is not a field the orchestrator produces)
    const freshFromOrchestrator = makeExtendedAnalysis({
      intent: "where_is_my_order",
      intents: ["where_is_my_order"],
      // no manualOverrides
    });
    (analyzeSupportEmail as ReturnType<typeof vi.fn>).mockResolvedValue(freshFromOrchestrator);

    const result = await refreshThreadAnalysis(EMAIL_ID, {} as never, SHOP, {
      reclassifyIntent: true,
      reSearchOrder: true,
      refreshTracking: true,
    });

    // manualOverrides from the previous analysis must be on the result
    expect(result.manualOverrides?.intents?.editedAt).toBe("2026-05-01T12:00:00.000Z");
    expect(result.manualOverrides?.order?.editedAt).toBe("2026-05-02T08:00:00.000Z");

    // Also check the persisted JSON
    const updateCall = (prisma.incomingEmail.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const persisted = JSON.parse(updateCall.data.analysisResult) as SupportAnalysis;
    expect(persisted.manualOverrides?.intents?.editedAt).toBe("2026-05-01T12:00:00.000Z");
    expect(persisted.manualOverrides?.order?.editedAt).toBe("2026-05-02T08:00:00.000Z");
  });

  // Test 5 (Path A) — reclassifyIntent: false → orchestrator receives reuseIntents (not called with LLM)
  it("passes reuseIntents to analyzeSupportEmail when reclassifyIntent is false", async () => {
    const prevAnalysis = makeAnalysis({
      intent: "order_error",
      intents: ["order_error"],
      identifiers: { orderNumber: "2002", email: "customer@shop.com" },
    });
    (prisma.incomingEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePrismaRecord(prevAnalysis),
    );
    (analyzeSupportEmail as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeExtendedAnalysis({ intent: "order_error", intents: ["order_error"] }),
    );

    await refreshThreadAnalysis(EMAIL_ID, {} as never, SHOP, {
      reclassifyIntent: false,
      reSearchOrder: true,
      refreshTracking: true,
    });

    const callArg = (analyzeSupportEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // reuseIntents must be set — this tells the orchestrator to skip llmParseEmail
    expect(callArg.reuseIntents).toBeDefined();
    expect(callArg.reuseIntents.intent).toBe("order_error");
    expect(callArg.reuseIntents.identifiers).toEqual({
      orderNumber: "2002",
      email: "customer@shop.com",
    });
    // reuseOrder must NOT be set
    expect(callArg.reuseOrder).toBeUndefined();
  });

  // Test 6 (Path A) — reSearchOrder: false → orchestrator receives reuseOrder (no Shopify call)
  it("passes reuseOrder to analyzeSupportEmail when reSearchOrder is false", async () => {
    const prevOrder = {
      id: "gid://Order/42",
      name: "#4242",
      createdAt: "2026-04-15T00:00:00Z",
      customerName: "Carol",
      customerEmail: "carol@example.com",
      lineItems: [],
      fulfillments: [],
    };
    const prevAnalysis = makeAnalysis({ order: prevOrder, orderCandidates: [prevOrder] });
    (prisma.incomingEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePrismaRecord(prevAnalysis),
    );
    (analyzeSupportEmail as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeExtendedAnalysis({ order: prevOrder, orderCandidates: [prevOrder] }),
    );

    await refreshThreadAnalysis(EMAIL_ID, {} as never, SHOP, {
      reclassifyIntent: true,
      reSearchOrder: false,
      refreshTracking: true,
    });

    const callArg = (analyzeSupportEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // reuseOrder must be set — this tells the orchestrator to skip searchOrders
    expect(callArg.reuseOrder).toBeDefined();
    expect(callArg.reuseOrder.order?.id).toBe("gid://Order/42");
    expect(callArg.reuseOrder.orderCandidates).toHaveLength(1);
    // reuseIntents must NOT be set
    expect(callArg.reuseIntents).toBeUndefined();
  });

  // Bonus: skipDraft is always true
  it("always passes skipDraft: true to the orchestrator", async () => {
    const prevAnalysis = makeAnalysis();
    (prisma.incomingEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePrismaRecord(prevAnalysis),
    );
    (analyzeSupportEmail as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeExtendedAnalysis(),
    );

    await refreshThreadAnalysis(EMAIL_ID, {} as never, SHOP, {
      reclassifyIntent: true,
      reSearchOrder: true,
      refreshTracking: true,
    });

    const callArg = (analyzeSupportEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.skipDraft).toBe(true);
  });

  // When there is no previous analysis, a full pipeline run is performed
  it("runs full pipeline when there is no previous analysisResult", async () => {
    (prisma.incomingEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePrismaRecord(null),
    );
    (analyzeSupportEmail as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeExtendedAnalysis(),
    );

    const result = await refreshThreadAnalysis(EMAIL_ID, {} as never, SHOP, {
      reclassifyIntent: false, // would reuse — but no previous analysis, so full run
      reSearchOrder: false,
      refreshTracking: true,
    });

    const callArg = (analyzeSupportEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // No previous analysis means reuseIntents/reuseOrder should NOT be passed
    expect(callArg.reuseIntents).toBeUndefined();
    expect(callArg.reuseOrder).toBeUndefined();

    expect(result.intent).toBe("where_is_my_order"); // from makeExtendedAnalysis default
  });
});
