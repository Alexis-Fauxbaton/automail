/**
 * Integration tests for analyzeThread — the unified analysis entry point.
 *
 * External services (OpenAI, Shopify, 17track) are mocked at the module level.
 * All tests use the real Postgres test DB via the shared prisma instance.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";

// ── Hoisted spies (must be declared before vi.mock calls) ─────────────────
const { classifyEmailSpy, analyzeSupportEmailSpy } = vi.hoisted(() => ({
  classifyEmailSpy: vi.fn<(...args: unknown[]) => Promise<string>>(
    async () => "support_client",
  ),
  analyzeSupportEmailSpy: vi.fn<(...args: unknown[]) => Promise<object>>(
    async () => ({
      intent: "where_is_my_order",
      intents: ["where_is_my_order"],
      identifiers: {},
      order: null,
      orderCandidates: [],
      trackings: [],
      warnings: [],
      confidence: "high",
      draftReply: "<p>Your order is on the way.</p>",
      conversation: {
        messageCount: 1,
        incomingCount: 1,
        outgoingCount: 0,
        lastMessageDirection: "incoming",
        noReplyNeeded: false,
      },
      crawledContexts: [],
    }),
  ),
}));

vi.mock("../../gmail/classifier", () => ({
  classifyEmail: classifyEmailSpy,
}));
vi.mock("../../support/orchestrator", () => ({
  analyzeSupportEmail: analyzeSupportEmailSpy,
}));
// Stub entitlements — quota not suspended by default.
vi.mock("../../billing/entitlements", () => ({
  resolveEntitlements: async () => ({
    canGenerateDraft: true,
    quotaStatus: { used: 0, limit: 50 },
    state: "paid_active",
    isSyncSuspended: false,
  }),
  __resetCacheForTests: () => undefined,
}));
// Stub thread-identifier helpers (no-op for these tests).
vi.mock("../../support/thread-identifiers", () => ({
  extractAndCache: async () => undefined,
  mergeThreadIdentifiers: async () => undefined,
  getThreadResolution: async () => null,
}));
// Stub buildThreadContext so we don't need a real mail provider.
vi.mock("../../gmail/pipeline", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../gmail/pipeline")>();
  return {
    ...original,
    buildThreadContext: async () => ({
      body: "Hello, where is my order?",
      messages: [],
    }),
  };
});

import { analyzeThread } from "../../support/analyze-thread";
import { getUsage } from "../../billing/usage";

const fakeAdmin = { graphql: async () => ({ json: async () => ({}) }) } as any;

// ── Helpers ───────────────────────────────────────────────────────────────

async function createAnchor(
  threadId: string,
  mailConnectionId: string,
  overrides: Record<string, unknown> = {},
) {
  return testDb.incomingEmail.create({
    data: {
      shop: TEST_SHOP,
      mailConnectionId,
      externalMessageId: `ext-${Math.random().toString(36).slice(2)}`,
      threadId: "provider-thread-1",
      canonicalThreadId: threadId,
      fromAddress: "customer@example.com",
      subject: "Where is my order?",
      bodyText: "Hello, where is my order?",
      receivedAt: new Date(),
      processingStatus: "ingested",
      tier1Result: "passed",
      ...overrides,
    },
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await cleanTestShop();
  classifyEmailSpy.mockClear();
  analyzeSupportEmailSpy.mockClear();
  // Reset to default: support_client + full analysis result.
  classifyEmailSpy.mockResolvedValue("support_client");
  analyzeSupportEmailSpy.mockResolvedValue({
    intent: "where_is_my_order",
    intents: ["where_is_my_order"],
    identifiers: {},
    order: null,
    orderCandidates: [],
    trackings: [],
    warnings: [],
    confidence: "high",
    draftReply: "<p>Your order is on the way.</p>",
    conversation: {
      messageCount: 1,
      incomingCount: 1,
      outgoingCount: 0,
      lastMessageDirection: "incoming",
      noReplyNeeded: false,
    },
    crawledContexts: [],
  });
});

afterAll(async () => {
  await disconnectTestDb();
});

// ── Use case A: Sync Pass 2 — support_client (runTier2 + full Tier 3) ────

describe("use case A — sync Pass 2 (runTier2=true, support_client)", () => {
  it("runs Tier 2 and Tier 3, persists analysis, bills the thread", async () => {
    const t = await createTestThread({});
    await createAnchor(t.id, t.mailConnectionId);

    const result = await analyzeThread(
      t.id,
      { shop: TEST_SHOP, admin: fakeAdmin },
      { runTier2: true, runDraft: false, enforceQuota: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.classification).toBe("support_client");
    expect(result.analysis?.intent).toBe("where_is_my_order");

    // Tier 2 classifier was called exactly once.
    expect(classifyEmailSpy).toHaveBeenCalledTimes(1);
    // Orchestrator was called exactly once.
    expect(analyzeSupportEmailSpy).toHaveBeenCalledTimes(1);
    // orchestrator called without skipDraft (runDraft=false means skipDraft=true)
    expect(analyzeSupportEmailSpy.mock.calls[0][0]).toMatchObject({ skipDraft: true });

    // DB: anchor promoted to "analyzed".
    const anchor = await testDb.incomingEmail.findFirst({
      where: { shop: TEST_SHOP, canonicalThreadId: t.id },
    });
    expect(anchor?.processingStatus).toBe("analyzed");
    expect(anchor?.tier2Result).toBe("support_client");
    expect(anchor?.detectedIntent).toBe("where_is_my_order");

    // Billing: thread counted once.
    const thread = await testDb.thread.findUnique({ where: { id: t.id } });
    expect(thread?.analyzedAt).not.toBeNull();
    expect((await getUsage(TEST_SHOP)).count).toBe(1);
  });
});

// ── Use case A bis: Sync Pass 2 — non-support (no Tier 3) ────────────────

describe("use case A bis — sync Pass 2 (runTier2=true, probable_non_client)", () => {
  it("runs Tier 2 only, marks classified, does NOT call orchestrator", async () => {
    classifyEmailSpy.mockResolvedValue("probable_non_client");
    const t = await createTestThread({});
    await createAnchor(t.id, t.mailConnectionId);

    const result = await analyzeThread(
      t.id,
      { shop: TEST_SHOP, admin: fakeAdmin },
      { runTier2: true, runDraft: false, enforceQuota: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.classification).toBe("probable_non_client");
    expect(result.analysis).toBeUndefined();

    expect(classifyEmailSpy).toHaveBeenCalledTimes(1);
    expect(analyzeSupportEmailSpy).not.toHaveBeenCalled();

    const anchor = await testDb.incomingEmail.findFirst({
      where: { shop: TEST_SHOP, canonicalThreadId: t.id },
    });
    expect(anchor?.processingStatus).toBe("classified");
    expect(anchor?.tier2Result).toBe("probable_non_client");

    // No billing increment.
    expect((await getUsage(TEST_SHOP)).count).toBe(0);
  });
});

// ── Use case B: User "Generate Draft" (no Tier 2, full Tier 3 + draft) ──

describe("use case B — user Generate Draft (runTier2=false, runDraft=true)", () => {
  it("runs Tier 3 with draft, persists analysisResult and draft body", async () => {
    const t = await createTestThread({});
    await createAnchor(t.id, t.mailConnectionId);

    const result = await analyzeThread(
      t.id,
      { shop: TEST_SHOP, admin: fakeAdmin },
      {
        runTier2: false,
        runDraft: true,
        enforceQuota: false,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.analysis?.draftReply).toBeTruthy();

    // Tier 2 was NOT called (no runTier2).
    expect(classifyEmailSpy).not.toHaveBeenCalled();
    // orchestrator was called with skipDraft=false.
    expect(analyzeSupportEmailSpy).toHaveBeenCalledTimes(1);
    expect(analyzeSupportEmailSpy.mock.calls[0][0]).toMatchObject({ skipDraft: false });

    const anchor = await testDb.incomingEmail.findFirst({
      where: { shop: TEST_SHOP, canonicalThreadId: t.id },
    });
    expect(anchor?.processingStatus).toBe("analyzed");
    expect(anchor?.tier2Result).toBe("support_client");

    // ReplyDraft was upserted.
    const draft = await testDb.replyDraft.findFirst({
      where: { shop: TEST_SHOP, emailId: anchor!.id },
    });
    expect(draft?.body).toBeTruthy();
  });
});

// ── Use case C: User Refresh (no Tier 2, full Tier 3 without draft) ──────

describe("use case C — user Refresh (runTier2=false, runDraft=false)", () => {
  it("runs Tier 3 without draft, updates lastAnalyzedAt", async () => {
    const t = await createTestThread({});
    await createAnchor(t.id, t.mailConnectionId);

    const result = await analyzeThread(
      t.id,
      { shop: TEST_SHOP, admin: fakeAdmin },
      { runTier2: false, runDraft: false, enforceQuota: false },
    );

    expect(result.ok).toBe(true);
    expect(classifyEmailSpy).not.toHaveBeenCalled();
    expect(analyzeSupportEmailSpy).toHaveBeenCalledTimes(1);
    expect(analyzeSupportEmailSpy.mock.calls[0][0]).toMatchObject({ skipDraft: true });

    const anchor = await testDb.incomingEmail.findFirst({
      where: { shop: TEST_SHOP, canonicalThreadId: t.id },
    });
    expect(anchor?.processingStatus).toBe("analyzed");
    expect(anchor?.lastAnalyzedAt).not.toBeNull();
    // No draft upserted.
    const draft = await testDb.replyDraft.findFirst({
      where: { shop: TEST_SHOP, emailId: anchor!.id },
    });
    expect(draft).toBeNull();
  });
});

// ── Use case D: Cron stale refresh (reuseIntents + Shopify + tracking) ───

describe("use case D — stale refresh (reuseIntents=true, reSearchOrder=false)", () => {
  it("does not call orchestrator intent step when reuseIntents=true with prior analysis", async () => {
    const t = await createTestThread({});
    // Seed anchor with existing analysis + manual intent override.
    await createAnchor(t.id, t.mailConnectionId, {
      processingStatus: "analyzed",
      analysisResult: JSON.stringify({
        intent: "damaged_product",
        intents: ["damaged_product"],
        identifiers: { orderNumber: "#1234" },
        order: null,
        orderCandidates: [],
        trackings: [],
        warnings: [],
        confidence: "medium",
        manualOverrides: { intents: true },
        conversation: { messageCount: 1, incomingCount: 1, outgoingCount: 0, lastMessageDirection: "incoming", noReplyNeeded: false },
        crawledContexts: [],
      }),
    });

    const result = await analyzeThread(
      t.id,
      { shop: TEST_SHOP, admin: fakeAdmin },
      {
        runTier2: false,
        runIntent: false,   // caller wants to skip LLM intent re-run
        runDraft: false,
        reuseIntents: true, // pass through manual override
        reuseOrder: false,
        enforceQuota: false,
      },
    );

    expect(result.ok).toBe(true);
    expect(classifyEmailSpy).not.toHaveBeenCalled();
    // Orchestrator called with reuseIntents forwarding the previous intent.
    expect(analyzeSupportEmailSpy).toHaveBeenCalledTimes(1);
    const orchInput = analyzeSupportEmailSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(orchInput.reuseIntents).toMatchObject({ intent: "damaged_product" });
  });
});

// ── Use case E: Backfill with automatic Tier 2 (the prod bug fix) ─────────

describe("use case E — backfill with runTier2=true (bug fix)", () => {
  it("classifies a backfilled thread that previously sat at tier2Result=null", async () => {
    const t = await createTestThread({});
    // Simulate a backfilled email: processingStatus="classified", tier2Result=null
    const anchor = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        mailConnectionId: t.mailConnectionId,
        externalMessageId: "backfilled-msg-1",
        threadId: "provider-thread-2",
        canonicalThreadId: t.id,
        fromAddress: "customer@example.com",
        subject: "Missing item",
        bodyText: "I received my order but one item is missing.",
        receivedAt: new Date(Date.now() - 7 * 24 * 3600_000), // 7 days ago
        processingStatus: "classified",
        tier1Result: "passed",
        tier2Result: null, // ← the bug: no Tier 2 was run
      },
    });

    const result = await analyzeThread(
      t.id,
      { shop: TEST_SHOP, admin: fakeAdmin },
      {
        runTier2: true,
        runDraft: false,
        bypassCatchupGate: true, // email is old, bypass the 72-h gate
        enforceQuota: false,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.classification).toBe("support_client");

    // Verify the DB row was promoted.
    const updated = await testDb.incomingEmail.findUnique({ where: { id: anchor.id } });
    expect(updated?.tier2Result).toBe("support_client");
    expect(updated?.processingStatus).toBe("analyzed");
    expect(updated?.detectedIntent).toBe("where_is_my_order");

    // Billing was charged.
    expect((await getUsage(TEST_SHOP)).count).toBe(1);
  });
});

// ── Use case F: Catch-up gate ─────────────────────────────────────────────

describe("use case F — catch-up gate (email outside 72-h active zone)", () => {
  it("returns skipped=catchup_zone when bypassCatchupGate=false and email is old", async () => {
    const t = await createTestThread({});
    await createAnchor(t.id, t.mailConnectionId, {
      // 5 days old — outside the 72-h active zone.
      receivedAt: new Date(Date.now() - 5 * 24 * 3600_000),
    });

    const result = await analyzeThread(
      t.id,
      { shop: TEST_SHOP, admin: fakeAdmin },
      {
        runTier2: true,
        runDraft: false,
        bypassCatchupGate: false,
        enforceQuota: false,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.skipped).toBe("catchup_zone");

    // No Tier 2 / Tier 3 ran.
    expect(classifyEmailSpy).not.toHaveBeenCalled();
    expect(analyzeSupportEmailSpy).not.toHaveBeenCalled();

    // Email was set back to "ingested" (not "analyzed").
    const anchor = await testDb.incomingEmail.findFirst({
      where: { shop: TEST_SHOP, canonicalThreadId: t.id },
    });
    expect(anchor?.processingStatus).toBe("ingested");
  });

  it("bypasses the gate when bypassCatchupGate=true", async () => {
    const t = await createTestThread({});
    await createAnchor(t.id, t.mailConnectionId, {
      receivedAt: new Date(Date.now() - 5 * 24 * 3600_000),
    });

    const result = await analyzeThread(
      t.id,
      { shop: TEST_SHOP, admin: fakeAdmin },
      {
        runTier2: true,
        runDraft: false,
        bypassCatchupGate: true,
        enforceQuota: false,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.classification).toBe("support_client");
    expect(analyzeSupportEmailSpy).toHaveBeenCalledTimes(1);
  });
});
