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

describe("billing — concurrent racing (Class 2)", () => {
  it("10 parallel calls on the same thread yield exactly 1 increment", async () => {
    const thread = await createTestThread({});
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        markThreadAnalyzedIfFirst(thread.id, TEST_SHOP),
      ),
    );
    const counted = results.filter((r) => r.counted).length;
    expect(counted).toBe(1);
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(1);
  });

  it("50 parallel calls split across 5 threads yield exactly 5 increments", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await createTestThread({});
      ids.push(t.id);
    }
    const calls: Promise<unknown>[] = [];
    for (const id of ids) {
      for (let j = 0; j < 10; j++) {
        calls.push(markThreadAnalyzedIfFirst(id, TEST_SHOP));
      }
    }
    await Promise.all(calls);
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(5);
  });

  it("20 parallel calls on the same thread from different async contexts yield exactly 1", async () => {
    const thread = await createTestThread({});
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      tasks.push(
        (async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          return markThreadAnalyzedIfFirst(thread.id, TEST_SHOP);
        })(),
      );
    }
    const results = (await Promise.all(tasks)) as Array<{ counted: boolean }>;
    expect(results.filter((r) => r.counted).length).toBe(1);
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(1);
  });
});
