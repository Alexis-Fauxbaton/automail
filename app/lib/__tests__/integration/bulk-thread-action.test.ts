import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  createTestThread,
  TEST_SHOP,
} from "./helpers/db";

// Mock the job queue so we can assert analyze_thread enqueues without a worker.
const { enqueueSpy } = vi.hoisted(() => ({
  enqueueSpy: vi.fn(async () => "stub-job-id"),
}));
vi.mock("../../mail/job-queue", async () => {
  const actual = await vi.importActual<typeof import("../../mail/job-queue")>("../../mail/job-queue");
  return { ...actual, enqueueJob: enqueueSpy };
});

import { handleBulkThreadAction } from "../../support/inbox-actions";

const OTHER_SHOP = "other-shop.myshopify.com";

beforeEach(async () => {
  await cleanTestShop();
  await cleanTestShop(OTHER_SHOP);
  enqueueSpy.mockClear();
});

afterAll(async () => {
  await cleanTestShop(OTHER_SHOP);
  await disconnectTestDb();
});

describe("handleBulkThreadAction", () => {
  it("marks several threads resolved and records history", async () => {
    const a = await createTestThread({ operationalState: "waiting_merchant" });
    const b = await createTestThread({ operationalState: "waiting_customer" });

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id, b.id],
      action: "resolved",
    });

    expect(res).toEqual({ updated: 2, skipped: 0 });
    const rows = await testDb.thread.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.every((t) => t.operationalState === "resolved")).toBe(true);
    expect(rows.find((t) => t.id === a.id)?.previousOperationalState).toBe("waiting_merchant");
    const history = await testDb.threadStateHistory.count({
      where: { shop: TEST_SHOP, toState: "resolved", reason: "bulk_action" },
    });
    expect(history).toBe(2);
  });

  it("skips already-resolved threads (idempotent)", async () => {
    const a = await createTestThread({ operationalState: "resolved" });
    const b = await createTestThread({ operationalState: "waiting_merchant" });

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id, b.id],
      action: "resolved",
    });

    expect(res).toEqual({ updated: 1, skipped: 1 });
    const history = await testDb.threadStateHistory.count({ where: { shop: TEST_SHOP } });
    expect(history).toBe(1);
  });

  it("ignores thread ids belonging to another shop", async () => {
    const mine = await createTestThread({ operationalState: "open" });
    const other = await testDb.thread.create({
      data: {
        shop: OTHER_SHOP,
        provider: "gmail",
        mailConnectionId: (
          await testDb.mailConnection.create({
            data: {
              shop: OTHER_SHOP,
              email: "x@other.com",
              provider: "gmail",
              accessToken: "a",
              refreshToken: "r",
              tokenExpiry: new Date(Date.now() + 3600_000),
            },
          })
        ).id,
        lastMessageAt: new Date(),
        firstMessageAt: new Date(),
        operationalState: "open",
        supportNature: "unknown",
        historyStatus: "complete",
      },
    });

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [mine.id, other.id],
      action: "resolved",
    });

    expect(res).toEqual({ updated: 1, skipped: 0 });
    const otherRow = await testDb.thread.findUnique({ where: { id: other.id } });
    expect(otherRow?.operationalState).toBe("open"); // untouched
  });

  it("reopen restores previousOperationalState (fallback waiting_merchant)", async () => {
    const a = await createTestThread({
      operationalState: "resolved",
      previousOperationalState: "waiting_customer",
    });
    const b = await createTestThread({ operationalState: "resolved" }); // no previous

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id, b.id],
      action: "reopen",
    });

    expect(res).toEqual({ updated: 2, skipped: 0 });
    const rowA = await testDb.thread.findUnique({ where: { id: a.id } });
    const rowB = await testDb.thread.findUnique({ where: { id: b.id } });
    expect(rowA?.operationalState).toBe("waiting_customer");
    expect(rowB?.operationalState).toBe("waiting_merchant");
  });

  it("reopen skips threads that are not resolved", async () => {
    const a = await createTestThread({ operationalState: "waiting_merchant" });

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id],
      action: "reopen",
    });

    expect(res).toEqual({ updated: 0, skipped: 1 });
    const row = await testDb.thread.findUnique({ where: { id: a.id } });
    expect(row?.operationalState).toBe("waiting_merchant"); // untouched
    const history = await testDb.threadStateHistory.count({ where: { shop: TEST_SHOP } });
    expect(history).toBe(0);
  });

  it("generate_drafts enqueues a draft job per support thread, skipping non_support", async () => {
    const a = await createTestThread({ supportNature: "confirmed_support" });
    const b = await createTestThread({ supportNature: "non_support" });

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id, b.id],
      action: "generate_drafts",
    });

    expect(res).toEqual({ updated: 1, skipped: 1 });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        shop: TEST_SHOP,
        kind: "analyze_thread",
        params: { threadId: a.id, generateDraft: true },
      }),
    );
  });

  it("generate_drafts touches no thread state or history", async () => {
    const a = await createTestThread({ supportNature: "confirmed_support", operationalState: "waiting_merchant" });

    await handleBulkThreadAction({ shop: TEST_SHOP, threadIds: [a.id], action: "generate_drafts" });

    const row = await testDb.thread.findUnique({ where: { id: a.id } });
    expect(row?.operationalState).toBe("waiting_merchant");
    expect(row?.supportNature).toBe("confirmed_support");
    const history = await testDb.threadStateHistory.count({ where: { shop: TEST_SHOP } });
    expect(history).toBe(0);
  });

  it("mark_support flips non_support to confirmed_support and clears analyze-dismissal", async () => {
    const a = await createTestThread({ supportNature: "non_support" });
    await testDb.thread.update({ where: { id: a.id }, data: { dismissedFromAnalyzeAt: new Date() } });
    const b = await createTestThread({ supportNature: "confirmed_support" }); // already support → skipped

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id, b.id],
      action: "mark_support",
    });

    expect(res).toEqual({ updated: 1, skipped: 1 });
    const rowA = await testDb.thread.findUnique({ where: { id: a.id } });
    expect(rowA?.supportNature).toBe("confirmed_support");
    expect(rowA?.dismissedFromAnalyzeAt).toBeNull();
    expect(enqueueSpy).not.toHaveBeenCalled(); // reclassify only — no analysis/quota
  });

  it("mark_non_support flips support threads to non_support, skipping already non_support", async () => {
    const a = await createTestThread({ supportNature: "confirmed_support" });
    const b = await createTestThread({ supportNature: "non_support" });

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id, b.id],
      action: "mark_non_support",
    });

    expect(res).toEqual({ updated: 1, skipped: 1 });
    expect((await testDb.thread.findUnique({ where: { id: a.id } }))?.supportNature).toBe("non_support");
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("resolve and reopen skip non_support threads", async () => {
    const toResolve = await createTestThread({ supportNature: "non_support", operationalState: "waiting_merchant" });
    const r1 = await handleBulkThreadAction({ shop: TEST_SHOP, threadIds: [toResolve.id], action: "resolved" });
    expect(r1).toEqual({ updated: 0, skipped: 1 });
    expect((await testDb.thread.findUnique({ where: { id: toResolve.id } }))?.operationalState).toBe("waiting_merchant");

    const toReopen = await createTestThread({ supportNature: "non_support", operationalState: "resolved" });
    const r2 = await handleBulkThreadAction({ shop: TEST_SHOP, threadIds: [toReopen.id], action: "reopen" });
    expect(r2).toEqual({ updated: 0, skipped: 1 });
    expect((await testDb.thread.findUnique({ where: { id: toReopen.id } }))?.operationalState).toBe("resolved");
  });

  it("rejects unknown actions and empty input", async () => {
    const a = await createTestThread();
    expect(await handleBulkThreadAction({ shop: TEST_SHOP, threadIds: [a.id], action: "delete" })).toEqual({ updated: 0, skipped: 0 });
    expect(await handleBulkThreadAction({ shop: TEST_SHOP, threadIds: [], action: "resolved" })).toEqual({ updated: 0, skipped: 0 });
  });
});
