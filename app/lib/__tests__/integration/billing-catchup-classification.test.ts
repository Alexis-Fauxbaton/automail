import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";

// We mock the heavy auto-sync side and the LLM-bearing pipeline calls.
const { enqueueSpy } = vi.hoisted(() => ({
  enqueueSpy: vi.fn(async () => "stub-job-id"),
}));
vi.mock("../../mail/job-queue", async () => {
  const actual = await vi.importActual<typeof import("../../mail/job-queue")>("../../mail/job-queue");
  return {
    ...actual,
    enqueueJob: enqueueSpy,
  };
});

import { handleMoveThread } from "../../support/inbox-actions";

const fakeAdmin = { graphql: async () => ({ json: async () => ({}) }) } as any;

beforeEach(async () => {
  await cleanTestShop();
  enqueueSpy.mockClear();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — catch-up on classification change (Class 8)", () => {
  it("enqueues analyze_thread when moving non_support → waiting_merchant", async () => {
    const t = await createTestThread({
      supportNature: "non_support",
      operationalState: "no_reply_needed",
    });

    await handleMoveThread({
      shop: TEST_SHOP,
      canonicalThreadId: t.id,
      target: "waiting_merchant",
      admin: fakeAdmin,
    });

    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        shop: TEST_SHOP,
        kind: "analyze_thread",
        params: expect.objectContaining({ threadId: t.id }),
      }),
    );
  });

  it("does NOT enqueue when thread is already analyzed", async () => {
    const t = await createTestThread({ supportNature: "non_support" });
    await testDb.thread.update({
      where: { id: t.id },
      data: { analyzedAt: new Date() },
    });

    await handleMoveThread({
      shop: TEST_SHOP,
      canonicalThreadId: t.id,
      target: "waiting_merchant",
      admin: fakeAdmin,
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does NOT enqueue when move is a no-op (already in confirmed_support)", async () => {
    const t = await createTestThread({
      supportNature: "confirmed_support",
      operationalState: "waiting_merchant",
    });

    await handleMoveThread({
      shop: TEST_SHOP,
      canonicalThreadId: t.id,
      target: "waiting_merchant",
      admin: fakeAdmin,
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
