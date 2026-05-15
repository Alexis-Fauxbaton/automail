import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";
import { markThreadAnalyzedIfFirst, getUsage } from "../../billing/usage";

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing thread counter — integration", () => {
  it("counts +1 the first time and +0 on resync", async () => {
    const thread = await createTestThread({});
    const r1 = await markThreadAnalyzedIfFirst(thread.id, TEST_SHOP);
    expect(r1.counted).toBe(true);
    expect(r1.alreadyAnalyzed).toBe(false);
    const usage1 = await getUsage(TEST_SHOP);
    expect(usage1.count).toBe(1);

    // Simulate a resync: call mark again on the same thread.
    const r2 = await markThreadAnalyzedIfFirst(thread.id, TEST_SHOP);
    expect(r2.counted).toBe(false);
    expect(r2.alreadyAnalyzed).toBe(true);
    const usage2 = await getUsage(TEST_SHOP);
    expect(usage2.count).toBe(1);
  });

  it("counts +1 for each of N distinct threads", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await createTestThread({});
      ids.push(t.id);
    }
    for (const id of ids) {
      const r = await markThreadAnalyzedIfFirst(id, TEST_SHOP);
      expect(r.counted).toBe(true);
    }
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(5);
  });

  it("long conversation invariant — 5 successive Tier 3 calls on same thread = 1 unit", async () => {
    const thread = await createTestThread({});
    for (let i = 0; i < 5; i++) {
      await markThreadAnalyzedIfFirst(thread.id, TEST_SHOP);
    }
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(1);

    // Verify analyzedAt was set exactly once and never overwritten.
    const row = await testDb.thread.findUnique({ where: { id: thread.id }, select: { analyzedAt: true } });
    expect(row?.analyzedAt).toBeInstanceOf(Date);
  });

  it("sets analyzedAt to the timestamp of the first call (not a later one)", async () => {
    const thread = await createTestThread({});
    await markThreadAnalyzedIfFirst(thread.id, TEST_SHOP);
    const firstRow = await testDb.thread.findUnique({ where: { id: thread.id }, select: { analyzedAt: true } });
    const firstAt = firstRow?.analyzedAt;
    expect(firstAt).toBeInstanceOf(Date);

    // Sleep a bit so the timestamp diff would be visible if overwritten.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await markThreadAnalyzedIfFirst(thread.id, TEST_SHOP);

    const secondRow = await testDb.thread.findUnique({ where: { id: thread.id }, select: { analyzedAt: true } });
    expect(secondRow?.analyzedAt?.getTime()).toBe(firstAt?.getTime());
  });
});
