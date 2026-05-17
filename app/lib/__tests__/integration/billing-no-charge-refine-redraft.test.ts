import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";

const { refineDraftSpy, generateLLMDraftSpy } = vi.hoisted(() => ({
  refineDraftSpy: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "<p>refined</p>"),
  generateLLMDraftSpy: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "<p>redrafted</p>"),
}));
vi.mock("../../gmail/refine-draft", () => ({ refineDraft: refineDraftSpy }));
vi.mock("../../support/llm-draft", () => ({ generateLLMDraft: generateLLMDraftSpy }));
vi.mock("../../billing/entitlements", () => ({
  resolveEntitlements: async () => ({
    canGenerateDraft: true,
    quotaStatus: { used: 1, limit: 50 },
    state: "paid_active",
    isSyncSuspended: false,
  }),
  __resetCacheForTests: () => undefined,
}));

import { handleRefine, handleRedraft } from "../../support/inbox-actions";
import { getUsage } from "../../billing/usage";

const fakeAdmin = { graphql: async () => ({ json: async () => ({}) }) } as any;

beforeEach(async () => {
  await cleanTestShop();
  refineDraftSpy.mockClear();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — refine/redraft never increment counter (Class 9)", () => {
  it("calling handleRefine 10 times leaves counter unchanged", async () => {
    const t = await createTestThread({});
    // Seed: thread analyzed previously (analyzedAt set) and counter at 1.
    const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await testDb.thread.update({
      where: { id: t.id },
      data: { analyzedAt: new Date() },
    });
    const anchor = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: "anchor",
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
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart, analyzedThreadsCount: 1 },
    });

    for (let i = 0; i < 10; i++) {
      await handleRefine({
        shop: TEST_SHOP,
        admin: fakeAdmin,
        emailId: anchor.id,
        instructions: `try ${i}`,
        currentDraft: "<p>draft</p>",
      });
    }

    expect((await getUsage(TEST_SHOP)).count).toBe(1);
  });

  it("calling handleRedraft 10 times leaves counter unchanged", async () => {
    const t = await createTestThread({});
    const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await testDb.thread.update({
      where: { id: t.id },
      data: { analyzedAt: new Date() },
    });
    const anchor = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: "anchor-rd",
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
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart, analyzedThreadsCount: 1 },
    });

    for (let i = 0; i < 10; i++) {
      await handleRedraft({ shop: TEST_SHOP, admin: fakeAdmin, emailId: anchor.id });
    }

    expect((await getUsage(TEST_SHOP)).count).toBe(1);
  });
});
