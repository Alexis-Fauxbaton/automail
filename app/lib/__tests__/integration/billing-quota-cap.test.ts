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
});
