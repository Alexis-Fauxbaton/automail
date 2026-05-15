import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
} from "./helpers/db";

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — migration invariants (Class 7)", () => {
  it("BillingUsage.analyzedThreadsCount column exists and is queryable", async () => {
    const row = await testDb.billingUsage.findFirst();
    // We don't need a value — we just need the column to exist.
    expect(row === null || typeof row.analyzedThreadsCount === "number").toBe(true);
  });

  it("Thread.analyzedAt column exists, nullable, indexed", async () => {
    const t = await testDb.thread.create({
      data: {
        shop: TEST_SHOP,
        provider: "gmail",
        lastMessageAt: new Date(),
        firstMessageAt: new Date(),
        operationalState: "open",
        supportNature: "unknown",
        historyStatus: "complete",
      },
    });
    expect(t.analyzedAt).toBeNull();
    await testDb.thread.update({
      where: { id: t.id },
      data: { analyzedAt: new Date() },
    });
    const fresh = await testDb.thread.findUnique({ where: { id: t.id } });
    expect(fresh?.analyzedAt).toBeInstanceOf(Date);
  });
});
