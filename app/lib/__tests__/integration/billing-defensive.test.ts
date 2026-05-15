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

describe("billing — defensive paths (Class 10)", () => {
  it("empty threadId is a no-op", async () => {
    const r = await markThreadAnalyzedIfFirst("", TEST_SHOP);
    expect(r).toEqual({ counted: false, alreadyAnalyzed: false });
    expect((await getUsage(TEST_SHOP)).count).toBe(0);
  });

  it("empty shop is a no-op", async () => {
    const t = await createTestThread({});
    const r = await markThreadAnalyzedIfFirst(t.id, "");
    expect(r).toEqual({ counted: false, alreadyAnalyzed: false });
    expect((await getUsage(TEST_SHOP)).count).toBe(0);
  });

  it("non-existent threadId is a no-op", async () => {
    const r = await markThreadAnalyzedIfFirst("ghost-id", TEST_SHOP);
    expect(r.counted).toBe(false);
    expect((await getUsage(TEST_SHOP)).count).toBe(0);
  });

  it("calling on a deleted thread returns no-op without error", async () => {
    const t = await createTestThread({});
    await testDb.thread.delete({ where: { id: t.id } });
    const r = await markThreadAnalyzedIfFirst(t.id, TEST_SHOP);
    expect(r.counted).toBe(false);
    expect((await getUsage(TEST_SHOP)).count).toBe(0);
  });
});
