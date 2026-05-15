import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";
import {
  markThreadAnalyzedIfFirst,
  getUsage,
  getCurrentPeriodStart,
} from "../../billing/usage";

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — period boundaries (Class 5)", () => {
  it("getCurrentPeriodStart returns UTC midnight of the 1st", () => {
    const at = new Date(Date.UTC(2026, 2, 31, 23, 59, 59));
    expect(getCurrentPeriodStart(at).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    const next = new Date(Date.UTC(2026, 3, 1, 0, 0, 1));
    expect(getCurrentPeriodStart(next).toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("threads analyzed on Mar 31 23:59 and Apr 1 00:01 increment different periods", async () => {
    const tA = await createTestThread({});
    const tB = await createTestThread({});

    // Force March period row.
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date(Date.UTC(2026, 2, 1)),
        analyzedThreadsCount: 0,
      },
    });
    // Simulate March increment by writing directly (avoids needing to mock Date).
    await testDb.thread.update({
      where: { id: tA.id },
      data: { analyzedAt: new Date(Date.UTC(2026, 2, 31, 23, 59, 0)) },
    });
    await testDb.billingUsage.update({
      where: { shop_periodStart: { shop: TEST_SHOP, periodStart: new Date(Date.UTC(2026, 2, 1)) } },
      data: { analyzedThreadsCount: 1 },
    });

    // April increment via the helper.
    const aprFirst = new Date(Date.UTC(2026, 3, 1, 0, 0, 1));
    vi.setSystemTime(aprFirst);
    try {
      await markThreadAnalyzedIfFirst(tB.id, TEST_SHOP);
    } finally {
      vi.useRealTimers();
    }

    const marchRow = await testDb.billingUsage.findUnique({
      where: { shop_periodStart: { shop: TEST_SHOP, periodStart: new Date(Date.UTC(2026, 2, 1)) } },
    });
    const aprilRow = await testDb.billingUsage.findUnique({
      where: { shop_periodStart: { shop: TEST_SHOP, periodStart: new Date(Date.UTC(2026, 3, 1)) } },
    });

    expect(marchRow?.analyzedThreadsCount).toBe(1);
    expect(aprilRow?.analyzedThreadsCount).toBe(1);
  });

  it("getUsage on a new period returns count=0 even if previous period was capped", async () => {
    // Seed prior period maxed out.
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date(Date.UTC(2026, 2, 1)),
        analyzedThreadsCount: 50,
      },
    });
    // getUsage on April reads fresh.
    const april = new Date(Date.UTC(2026, 3, 1, 10, 0, 0));
    const usage = await getUsage(TEST_SHOP, april);
    expect(usage.count).toBe(0);
  });
});
