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

  it("non_support sets supportNature without touching operationalState or history", async () => {
    const a = await createTestThread({ supportNature: "confirmed_support", operationalState: "waiting_merchant" });

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id],
      action: "non_support",
    });

    expect(res).toEqual({ updated: 1, skipped: 0 });
    const row = await testDb.thread.findUnique({ where: { id: a.id } });
    expect(row?.supportNature).toBe("non_support");
    expect(row?.operationalState).toBe("waiting_merchant");
    const history = await testDb.threadStateHistory.count({ where: { shop: TEST_SHOP } });
    expect(history).toBe(0);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("waiting_* flips support and enqueues analyze_thread for never-analyzed threads", async () => {
    const a = await createTestThread({ supportNature: "probable_support", operationalState: "open" });

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id],
      action: "waiting_merchant",
    });

    expect(res).toEqual({ updated: 1, skipped: 0 });
    const row = await testDb.thread.findUnique({ where: { id: a.id } });
    expect(row?.operationalState).toBe("waiting_merchant");
    expect(row?.supportNature).toBe("confirmed_support");
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ shop: TEST_SHOP, kind: "analyze_thread", params: { threadId: a.id } }),
    );
  });

  it("waiting_* does NOT enqueue when already analyzed", async () => {
    const a = await createTestThread({ supportNature: "probable_support" });
    await testDb.thread.update({ where: { id: a.id }, data: { analyzedAt: new Date() } });

    await handleBulkThreadAction({ shop: TEST_SHOP, threadIds: [a.id], action: "waiting_merchant" });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("rejects unknown actions and empty input", async () => {
    const a = await createTestThread();
    expect(await handleBulkThreadAction({ shop: TEST_SHOP, threadIds: [a.id], action: "delete" })).toEqual({ updated: 0, skipped: 0 });
    expect(await handleBulkThreadAction({ shop: TEST_SHOP, threadIds: [], action: "resolved" })).toEqual({ updated: 0, skipped: 0 });
  });
});
