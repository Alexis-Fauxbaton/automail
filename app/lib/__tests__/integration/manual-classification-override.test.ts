// Integration test: manual classification override survives auto-refresh.
//
// Verifies the full lifecycle:
//  1. Manual edit sets intent = "refund_request" on a thread the LLM had
//     classified as "where_is_my_order".
//  2. refreshStaleAnalysesForShop runs — with the mock orchestrator honouring
//     Path A (reuseIntents is forwarded when reclassifyIntent=false). The
//     persisted intent must stay "refund_request".
//  3. User resets the override → intent becomes "unknown". Next refresh runs
//     with reclassifyIntent=true; the mock returns "where_is_my_order" and
//     that value must be persisted.
//  4. Tracking is always refreshed (comes from the fresh analysis regardless).

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
} from "./helpers/db";
import { persistClassificationEdit } from "../../support/manual-classification";
import { refreshStaleAnalysesForShop } from "../../support/refresh-stale-analyses";
import type { SupportAnalysis, SupportIntent, FulfillmentTrackingFacts } from "../../support/types";
import type { AnalyzeInput } from "../../support/orchestrator";

// ---------------------------------------------------------------------------
// Mock the orchestrator and the gmail pipeline before any imports resolve.
// ---------------------------------------------------------------------------

vi.mock("../../support/orchestrator", () => ({ analyzeSupportEmail: vi.fn() }));

vi.mock("../../gmail/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gmail/pipeline")>();
  return {
    ...actual,
    getMailClient: vi.fn().mockResolvedValue(undefined),
    buildThreadContext: vi.fn().mockResolvedValue({
      body: "Test email body",
      messages: [],
    }),
  };
});

// Import after the mocks are registered.
import { analyzeSupportEmail } from "../../support/orchestrator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SupportAnalysis used as seed data. */
function makeAnalysis(intent: SupportIntent, overrides: Partial<SupportAnalysis> = {}): SupportAnalysis {
  return {
    intent,
    intents: [intent],
    identifiers: {},
    order: null,
    orderCandidates: [],
    trackings: [],
    confidence: "low",
    warnings: [],
    draftReply: "",
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

/**
 * Configure analyzeSupportEmail mock to honour Path A:
 * - When reuseIntents is provided → use those intent values (skip "LLM").
 * - Otherwise → return defaultIntent.
 * - trackings always come from the supplied list.
 */
function setupOrchestratorMock(defaultIntent: SupportIntent, trackings: FulfillmentTrackingFacts[] = []) {
  (analyzeSupportEmail as ReturnType<typeof vi.fn>).mockImplementation(
    async (input: AnalyzeInput) => {
      const intent = input.reuseIntents?.intent ?? defaultIntent;
      const intents = input.reuseIntents?.intents ?? [defaultIntent];
      return {
        intent,
        intents,
        identifiers: input.reuseIntents?.identifiers ?? {},
        order: input.reuseOrder?.order ?? null,
        orderCandidates: input.reuseOrder?.orderCandidates ?? [],
        trackings,
        confidence: "low",
        warnings: [],
        draftReply: "",
        conversation: {
          messageCount: 1,
          incomingCount: 1,
          outgoingCount: 0,
          lastMessageDirection: "incoming",
          noReplyNeeded: false,
        },
        crawledContexts: [],
      };
    },
  );
}

async function seedThread(analysis: SupportAnalysis) {
  const thread = await testDb.thread.create({
    data: {
      shop: TEST_SHOP,
      provider: "gmail",
      lastMessageAt: new Date(),
      firstMessageAt: new Date(),
      operationalStateUpdatedAt: new Date(),
      operationalState: "open",
      supportNature: "confirmed_support",
      historyStatus: "complete",
    },
  });

  const email = await testDb.incomingEmail.create({
    data: {
      shop: TEST_SHOP,
      externalMessageId: `ext-${thread.id}`,
      canonicalThreadId: thread.id,
      fromAddress: "customer@example.com",
      subject: "Where is my order?",
      bodyText: "I haven't received my order yet.",
      receivedAt: new Date(),
      processingStatus: "analyzed",
      analysisResult: JSON.stringify(analysis),
      detectedIntent: analysis.intent,
      // Stale: 2 hours ago — qualifies for any maxAgeMs ≤ 2h
      lastAnalyzedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    },
  });

  return { thread, email };
}

async function readAnalysis(emailId: string): Promise<SupportAnalysis> {
  const row = await testDb.incomingEmail.findUniqueOrThrow({
    where: { id: emailId },
    select: { analysisResult: true },
  });
  return JSON.parse(row.analysisResult as string) as SupportAnalysis;
}

// Force an email to be stale again (used after a refresh updated lastAnalyzedAt).
async function makeStale(emailId: string) {
  await testDb.incomingEmail.update({
    where: { id: emailId },
    data: { lastAnalyzedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
  });
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await cleanTestShop();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanTestShop();
  await disconnectTestDb();
  // Prevent Vitest from hanging on open DB connections in subsequent files.
  if (typeof global !== "undefined") {
    (global as Record<string, unknown>).prismaGlobal = undefined;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("manual classification override survives auto-refresh", () => {
  it("override survives refresh; reset causes re-classification on next pass", async () => {
    // Seed: thread with baseline "where_is_my_order" analysis.
    const { email } = await seedThread(makeAnalysis("where_is_my_order"));

    // ── Step 1: apply manual override ────────────────────────────────────
    const afterEdit = (await persistClassificationEdit({
      shop: TEST_SHOP,
      threadId: email.canonicalThreadId!,
      edit: { intents: ["refund_request"] },
    })).analysis;

    expect(afterEdit.intent).toBe("refund_request");
    expect(afterEdit.intents).toEqual(["refund_request"]);
    expect(afterEdit.manualOverrides?.intents?.editedAt).toBeDefined();

    // Confirm the DB reflects the edit.
    const dbAfterEdit = await readAnalysis(email.id);
    expect(dbAfterEdit.intent).toBe("refund_request");
    expect(dbAfterEdit.manualOverrides?.intents?.editedAt).toBeDefined();

    // ── Step 2: refresh — mock LLM would return "where_is_my_order" ──────
    // Because intent is "refund_request" (non-empty, non-unknown),
    // refreshStaleAnalysesForShop sets reclassifyIntent=false and passes
    // reuseIntents to the orchestrator. The mock honours reuseIntents (Path A)
    // and therefore returns "refund_request" back. refreshThreadAnalysis then
    // merges manualOverrides from the previous analysis on top.
    setupOrchestratorMock("where_is_my_order"); // would classify as WISMO if called without reuseIntents

    const fakeAdmin = {} as never;
    const r1 = await refreshStaleAnalysesForShop(TEST_SHOP, fakeAdmin, { maxAgeMs: 0 });

    expect(r1.refreshed).toBe(1);
    expect(r1.errors).toBe(0);

    const dbAfterRefresh = await readAnalysis(email.id);
    // Override must have survived: reuseIntents forwarded the correct values.
    expect(dbAfterRefresh.intent).toBe("refund_request");
    expect(dbAfterRefresh.intents).toEqual(["refund_request"]);
    expect(dbAfterRefresh.manualOverrides?.intents?.editedAt).toBeDefined();

    // ── Step 3: user resets the override ─────────────────────────────────
    const afterReset = (await persistClassificationEdit({
      shop: TEST_SHOP,
      threadId: email.canonicalThreadId!,
      edit: { resetIntents: true },
    })).analysis;

    expect(afterReset.intent).toBe("unknown");
    expect(afterReset.intents).toEqual([]);
    expect(afterReset.manualOverrides?.intents).toBeUndefined();

    // ── Step 4: refresh again — now reclassifyIntent=true ("unknown") ────
    // reuseIntents is NOT passed; the mock returns defaultIntent = "where_is_my_order".
    await makeStale(email.id);
    const r2 = await refreshStaleAnalysesForShop(TEST_SHOP, fakeAdmin, { maxAgeMs: 0 });

    expect(r2.refreshed).toBe(1);
    expect(r2.errors).toBe(0);

    const dbAfterReclassify = await readAnalysis(email.id);
    expect(dbAfterReclassify.intent).toBe("where_is_my_order");
    expect(dbAfterReclassify.intents).toEqual(["where_is_my_order"]);
    // manualOverrides.intents was reset — must be gone.
    expect(dbAfterReclassify.manualOverrides?.intents).toBeUndefined();
  });

  it("tracking is always refreshed regardless of override state", async () => {
    // Seed with an existing manual intent override.
    const { email } = await seedThread(
      makeAnalysis("refund_request", {
        manualOverrides: { intents: { editedAt: new Date().toISOString() } },
      }),
    );

    const freshTracking: FulfillmentTrackingFacts = {
      fulfillmentId: "gid://shopify/Fulfillment/123",
      trackingNumber: "1Z999AA1234567890",
      carrier: "UPS",
      trackingUrl: "https://ups.com/track?num=1Z999AA1234567890",
      shopifyStatus: "in_transit",
      events: [],
      fetchedAt: null,
      source: "shopify",
    };

    setupOrchestratorMock("where_is_my_order", [freshTracking]);

    const fakeAdmin = {} as never;
    const r = await refreshStaleAnalysesForShop(TEST_SHOP, fakeAdmin, { maxAgeMs: 0 });

    expect(r.refreshed).toBe(1);
    expect(r.errors).toBe(0);

    const db = await readAnalysis(email.id);

    // Intent override preserved (reclassifyIntent=false for non-unknown intent)
    expect(db.intent).toBe("refund_request");
    // Tracking was refreshed (always pulled from the fresh analysis)
    expect(db.trackings).toHaveLength(1);
    expect(db.trackings[0].trackingNumber).toBe("1Z999AA1234567890");
    // manualOverrides preserved
    expect(db.manualOverrides?.intents?.editedAt).toBeDefined();
  });
});
