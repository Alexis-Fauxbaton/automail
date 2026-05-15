import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";
import { markThreadAnalyzedIfFirst, tryReserveDraft, getUsage } from "../../billing/usage";

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — quota cap (Class 6)", () => {
  it("at 49/50, a single increment succeeds and brings counter to 50", async () => {
    // Seed counter at 49.
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
        analyzedThreadsCount: 49,
      },
    });
    const thread = await createTestThread({});
    const r = await markThreadAnalyzedIfFirst(thread.id, TEST_SHOP);
    expect(r.counted).toBe(true);
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(50);
  });

  it("at 50/50, tryReserveDraft refuses additional unit", async () => {
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
        analyzedThreadsCount: 50,
      },
    });
    const r = await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("quota_exceeded");
  });

  it("Infinity limit (trial) never blocks", async () => {
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
        analyzedThreadsCount: 100_000,
      },
    });
    const r = await tryReserveDraft({ shop: TEST_SHOP, limit: Infinity });
    expect(r.ok).toBe(true);
  });

  it("2 parallel reserves at 49/50 — exactly 1 succeeds", async () => {
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
        analyzedThreadsCount: 49,
      },
    });
    const [a, b] = await Promise.all([
      tryReserveDraft({ shop: TEST_SHOP, limit: 50 }),
      tryReserveDraft({ shop: TEST_SHOP, limit: 50 }),
    ]);
    const successes = [a, b].filter((r) => r.ok).length;
    expect(successes).toBe(1);
  });
});
