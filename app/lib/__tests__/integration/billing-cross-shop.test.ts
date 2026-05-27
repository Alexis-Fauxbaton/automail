import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
  seedMailConnection,
} from "./helpers/db";
import { markThreadAnalyzedIfFirst, getUsage } from "../../billing/usage";

const OTHER_SHOP = "cross-shop.myshopify.com";

beforeEach(async () => {
  await cleanTestShop();
  await testDb.thread.deleteMany({ where: { shop: OTHER_SHOP } });
  await testDb.mailConnection.deleteMany({ where: { shop: OTHER_SHOP } });
  await testDb.billingUsage.deleteMany({ where: { shop: OTHER_SHOP } });
});

afterAll(async () => {
  await testDb.thread.deleteMany({ where: { shop: OTHER_SHOP } });
  await testDb.mailConnection.deleteMany({ where: { shop: OTHER_SHOP } });
  await testDb.billingUsage.deleteMany({ where: { shop: OTHER_SHOP } });
  await disconnectTestDb();
});

describe("billing — cross-shop isolation (Class 4)", () => {
  it("shop A analyses do not touch shop B counter", async () => {
    const tA = await createTestThread({});
    const mcB = await seedMailConnection({ shop: OTHER_SHOP });
    const tB = await testDb.thread.create({
      data: {
        shop: OTHER_SHOP,
        mailConnectionId: mcB.id,
        provider: "gmail",
        lastMessageAt: new Date(),
        firstMessageAt: new Date(),
        operationalState: "open",
        supportNature: "unknown",
        historyStatus: "complete",
      },
    });
    await markThreadAnalyzedIfFirst(tA.id, TEST_SHOP);
    await markThreadAnalyzedIfFirst(tB.id, OTHER_SHOP);

    const usageA = await getUsage(TEST_SHOP);
    const usageB = await getUsage(OTHER_SHOP);
    expect(usageA.count).toBe(1);
    expect(usageB.count).toBe(1);
  });

  it("concurrent analyses on two shops do not interfere", async () => {
    const tA = await createTestThread({});
    const mcB = await seedMailConnection({ shop: OTHER_SHOP });
    const tB = await testDb.thread.create({
      data: {
        shop: OTHER_SHOP,
        mailConnectionId: mcB.id,
        provider: "gmail",
        lastMessageAt: new Date(),
        firstMessageAt: new Date(),
        operationalState: "open",
        supportNature: "unknown",
        historyStatus: "complete",
      },
    });
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) calls.push(markThreadAnalyzedIfFirst(tA.id, TEST_SHOP));
    for (let i = 0; i < 5; i++) calls.push(markThreadAnalyzedIfFirst(tB.id, OTHER_SHOP));
    await Promise.all(calls);

    expect((await getUsage(TEST_SHOP)).count).toBe(1);
    expect((await getUsage(OTHER_SHOP)).count).toBe(1);
  });

  it("attempt to mark a thread with the wrong shop is a no-op", async () => {
    const tA = await createTestThread({});
    const r = await markThreadAnalyzedIfFirst(tA.id, OTHER_SHOP);
    expect(r.counted).toBe(false);
    expect((await getUsage(TEST_SHOP)).count).toBe(0);
    expect((await getUsage(OTHER_SHOP)).count).toBe(0);
  });
});
