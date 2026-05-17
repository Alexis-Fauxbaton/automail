import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";

const { refreshSpy, refineDraftSpy } = vi.hoisted(() => ({
  refreshSpy: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  refineDraftSpy: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "<p>refined</p>"),
}));
vi.mock("../../support/refresh-thread-analysis", () => ({
  refreshThreadAnalysis: refreshSpy,
}));
vi.mock("../../gmail/refine-draft", () => ({
  refineDraft: refineDraftSpy,
}));
vi.mock("../../billing/entitlements", () => ({
  resolveEntitlements: async () => ({
    canGenerateDraft: true,
    quotaStatus: { used: 0, limit: 999 },
    state: "active",
    isSyncSuspended: false,
  }),
  __resetCacheForTests: () => undefined,
}));
// Import AFTER vi.mock so the mocks are in place.
import { handleEditThreadIdentifiers, handleRefine } from "../../support/inbox-actions";

const fakeAdmin = { graphql: async () => ({ json: async () => ({}) }) } as any;

beforeEach(async () => {
  await cleanTestShop();
  refreshSpy.mockClear();
  refineDraftSpy.mockClear();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function seedAnalyzedAnchor(canonicalThreadId: string) {
  return testDb.incomingEmail.create({
    data: {
      shop: TEST_SHOP,
      externalMessageId: `ext-${canonicalThreadId}`,
      threadId: "tid",
      canonicalThreadId,
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
        order: {
          id: "gid://Order/1", name: "#42", createdAt: "2026-01-01T00:00:00Z",
          displayFinancialStatus: null, displayFulfillmentStatus: null,
          customerName: null, customerEmail: null, lineItems: [], fulfillments: [],
        },
        orderCandidates: [], trackings: [], warnings: [], confidence: "high",
      }),
    },
    select: { id: true },
  });
}

describe("handleEditThreadIdentifiers — refresh decisions", () => {
  it("calls refreshThreadAnalysis with reSearchOrder=true and refreshTracking=true when order changes", async () => {
    const thread = await createTestThread({});
    await seedAnalyzedAnchor(thread.id);
    await testDb.thread.update({
      where: { id: thread.id },
      data: { resolvedOrderNumber: "1000" },
    });

    const res = await handleEditThreadIdentifiers({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      canonicalThreadId: thread.id,
      resolvedOrderNumber: "2000",
      resolvedTrackingNumber: null,
      resolvedEmail: null,
      resolvedCustomerName: null,
    });

    expect((res as { refreshed?: string }).refreshed).toBe("ok");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    const call = refreshSpy.mock.calls[0];
    expect(call[3]).toMatchObject({
      reclassifyIntent: false,
      reSearchOrder: true,
      refreshTracking: true,
    });
  });

  it("calls refreshThreadAnalysis with reSearchOrder=false and refreshTracking=false when only customer name changed", async () => {
    const thread = await createTestThread({});
    await seedAnalyzedAnchor(thread.id);

    const res = await handleEditThreadIdentifiers({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      canonicalThreadId: thread.id,
      resolvedOrderNumber: null,
      resolvedTrackingNumber: null,
      resolvedEmail: null,
      resolvedCustomerName: "Alice",
    });

    expect((res as { refreshed?: string }).refreshed).toBe("ok");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.calls[0][3]).toMatchObject({
      reclassifyIntent: false,
      reSearchOrder: false,
      refreshTracking: false,
    });
  });

  it("returns skipped_noop and never calls refreshThreadAnalysis when nothing changed", async () => {
    const thread = await createTestThread({});
    await seedAnalyzedAnchor(thread.id);
    await testDb.thread.update({
      where: { id: thread.id },
      data: { resolvedOrderNumber: "5", resolvedCustomerName: "Bob" },
    });

    const res = await handleEditThreadIdentifiers({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      canonicalThreadId: thread.id,
      resolvedOrderNumber: "5",
      resolvedTrackingNumber: null,
      resolvedEmail: null,
      resolvedCustomerName: "Bob",
    });

    expect((res as { refreshed?: string }).refreshed).toBe("skipped_noop");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("returns no_anchor when thread has no analyzed email", async () => {
    const thread = await createTestThread({});

    const res = await handleEditThreadIdentifiers({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      canonicalThreadId: thread.id,
      resolvedOrderNumber: "1",
      resolvedTrackingNumber: null,
      resolvedEmail: null,
      resolvedCustomerName: null,
    });

    expect((res as { refreshed?: string }).refreshed).toBe("no_anchor");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("persists the edit even when refreshThreadAnalysis throws", async () => {
    const thread = await createTestThread({});
    await seedAnalyzedAnchor(thread.id);
    refreshSpy.mockRejectedValueOnce(new Error("shopify down"));

    const res = await handleEditThreadIdentifiers({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      canonicalThreadId: thread.id,
      resolvedOrderNumber: "9",
      resolvedTrackingNumber: null,
      resolvedEmail: null,
      resolvedCustomerName: null,
    });

    expect((res as { refreshed?: string }).refreshed).toBe("error");
    const row = await testDb.thread.findUnique({ where: { id: thread.id } });
    expect(row?.resolvedOrderNumber).toBe("9");
  });
});

describe("handleRefine — context wiring", () => {
  it("passes a contextSummary derived from analysisResult", async () => {
    const thread = await createTestThread({});
    const anchor = await seedAnalyzedAnchor(thread.id);

    await handleRefine({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      emailId: anchor.id,
      instructions: "Add the order number.",
      currentDraft: "<p>hi</p>",
    });

    expect(refineDraftSpy).toHaveBeenCalledTimes(1);
    const passedContext = refineDraftSpy.mock.calls[0][2] as {
      contextSummary?: string;
    };
    expect(passedContext.contextSummary).toBeDefined();
    expect(passedContext.contextSummary).toContain("Order: #42");
  });

  it("passes contextSummary=undefined when analysisResult is null", async () => {
    const thread = await createTestThread({});
    const anchor = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: "no-analysis",
        threadId: "tid",
        canonicalThreadId: thread.id,
        fromAddress: "c@x.com",
        subject: "S",
        bodyText: "B",
        receivedAt: new Date(),
        processingStatus: "analyzed",
        lastAnalyzedAt: new Date(),
        analysisResult: null,
      },
      select: { id: true },
    });

    await handleRefine({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      emailId: anchor.id,
      instructions: "Fix typo.",
      currentDraft: "<p>hi</p>",
    });

    expect(refineDraftSpy).toHaveBeenCalledTimes(1);
    const passedContext = refineDraftSpy.mock.calls[0][2] as {
      contextSummary?: string;
    };
    expect(passedContext.contextSummary).toBeUndefined();
  });
});
