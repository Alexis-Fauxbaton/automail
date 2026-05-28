import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";

// Stub the orchestrator and classifier so refreshThreadAnalysis runs end-to-end
// without hitting external services. We only care that no billing increment fires.
vi.mock("../../support/orchestrator", () => ({
  analyzeSupportEmail: async () => ({
    intent: "where_is_my_order",
    intents: ["where_is_my_order"],
    identifiers: {},
    order: null,
    orderCandidates: [],
    trackings: [],
    warnings: [],
    confidence: "high",
    conversation: { messageCount: 1, incomingCount: 1, outgoingCount: 0, lastMessageDirection: "incoming", noReplyNeeded: false },
    crawledContexts: [],
  }),
}));
vi.mock("../../gmail/classifier", () => ({
  classifyEmail: async () => "support_client",
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
    buildThreadContext: async () => ({ body: "Hello", messages: [] }),
  };
});

import { refreshThreadAnalysis } from "../../support/refresh-thread-analysis";
import { getUsage } from "../../billing/usage";

const fakeAdmin = { graphql: async () => ({ json: async () => ({}) }) } as any;

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — light refresh paths don't charge (Class 3)", () => {
  it("refreshThreadAnalysis({reclassifyIntent: false}) on an unanalyzed thread does not increment", async () => {
    const t = await createTestThread({});
    const anchor = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        mailConnectionId: t.mailConnectionId,
        externalMessageId: "x",
        threadId: "tid",
        canonicalThreadId: t.id,
        fromAddress: "c@x.com",
        subject: "S",
        bodyText: "B",
        receivedAt: new Date(),
        processingStatus: "analyzed",
        lastAnalyzedAt: new Date(),
        analysisResult: JSON.stringify({
          intent: "where_is_my_order",
          intents: ["where_is_my_order"],
          identifiers: {},
          order: null,
          orderCandidates: [],
          trackings: [],
          warnings: [],
          confidence: "high",
        }),
      },
      select: { id: true },
    });

    await refreshThreadAnalysis(anchor.id, fakeAdmin, TEST_SHOP, {
      reclassifyIntent: false,
      reSearchOrder: true,
      refreshTracking: true,
    });

    // Even though analyzedAt is null (we never ran full Tier 3 in this test),
    // a light refresh must not consume a unit.
    expect((await getUsage(TEST_SHOP)).count).toBe(0);
  });

  it("refreshThreadAnalysis on an already-analyzed thread does not increment", async () => {
    const t = await createTestThread({});
    await testDb.thread.update({ where: { id: t.id }, data: { analyzedAt: new Date() } });
    // Seed an analyzed anchor and a counter at 1 (already paid).
    const anchor = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        mailConnectionId: t.mailConnectionId,
        externalMessageId: "y",
        threadId: "tid",
        canonicalThreadId: t.id,
        fromAddress: "c@x.com",
        subject: "S",
        bodyText: "B",
        receivedAt: new Date(),
        processingStatus: "analyzed",
        lastAnalyzedAt: new Date(),
        analysisResult: JSON.stringify({
          intent: "where_is_my_order",
          intents: ["where_is_my_order"],
          identifiers: {},
          order: null,
          orderCandidates: [],
          trackings: [],
          warnings: [],
          confidence: "high",
        }),
      },
      select: { id: true },
    });
    const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart, analyzedThreadsCount: 1 },
    });

    await refreshThreadAnalysis(anchor.id, fakeAdmin, TEST_SHOP, {
      reclassifyIntent: false,
      reSearchOrder: true,
      refreshTracking: true,
    });

    expect((await getUsage(TEST_SHOP)).count).toBe(1);
  });
});
