import { describe, it, expect, beforeEach, vi } from "vitest";

const { dbState } = vi.hoisted(() => ({
  dbState: {
    threads: new Map<string, { id: string; shop: string; analyzedAt: Date | null }>(),
    usage: [] as Array<{ shop: string; periodStart: Date; count: number }>,
  },
}));

vi.mock("../../../db.server", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockClient: any = {
    // The unit-under-test wraps reads + writes in $transaction. Our mock
    // forwards the callback with `this` so calls to mockClient.thread.*
    // still hit the same in-memory state.
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockClient)),
    thread: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; shop: string; analyzedAt: null };
          data: { analyzedAt: Date };
        }) => {
          const row = dbState.threads.get(where.id);
          if (!row || row.shop !== where.shop || row.analyzedAt !== null) {
            return { count: 0 };
          }
          row.analyzedAt = data.analyzedAt;
          return { count: 1 };
        },
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => {
          return dbState.threads.get(where.id) ?? null;
        },
      ),
    },
    billingUsage: {
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { shop_periodStart: { shop: string; periodStart: Date } };
          create: { shop: string; periodStart: Date; analyzedThreadsCount: number };
          update: { analyzedThreadsCount: { increment: number } };
        }) => {
          const existing = dbState.usage.find(
            (u) =>
              u.shop === where.shop_periodStart.shop &&
              u.periodStart.getTime() === where.shop_periodStart.periodStart.getTime(),
          );
          if (existing) {
            existing.count += update.analyzedThreadsCount.increment;
          } else {
            dbState.usage.push({
              shop: create.shop,
              periodStart: create.periodStart,
              count: create.analyzedThreadsCount,
            });
          }
        },
      ),
    },
  };
  return { default: mockClient };
});

import { markThreadAnalyzedIfFirst } from "../usage";

beforeEach(() => {
  dbState.threads.clear();
  dbState.usage.length = 0;
});

describe("markThreadAnalyzedIfFirst — unit", () => {
  it("first call counts; second call no-ops", async () => {
    dbState.threads.set("t1", { id: "t1", shop: "shop-a.myshopify.com", analyzedAt: null });
    const r1 = await markThreadAnalyzedIfFirst("t1", "shop-a.myshopify.com");
    expect(r1).toEqual({ counted: true, alreadyAnalyzed: false });

    const r2 = await markThreadAnalyzedIfFirst("t1", "shop-a.myshopify.com");
    expect(r2).toEqual({ counted: false, alreadyAnalyzed: true });
  });

  it("shop mismatch returns counted: false without mutating", async () => {
    dbState.threads.set("t1", { id: "t1", shop: "shop-a.myshopify.com", analyzedAt: null });
    const r = await markThreadAnalyzedIfFirst("t1", "shop-b.myshopify.com");
    expect(r).toEqual({ counted: false, alreadyAnalyzed: false });
    expect(dbState.threads.get("t1")?.analyzedAt).toBeNull();
  });

  it("empty threadId returns counted: false", async () => {
    const r = await markThreadAnalyzedIfFirst("", "shop-a.myshopify.com");
    expect(r).toEqual({ counted: false, alreadyAnalyzed: false });
  });

  it("empty shop returns counted: false", async () => {
    dbState.threads.set("t1", { id: "t1", shop: "shop-a.myshopify.com", analyzedAt: null });
    const r = await markThreadAnalyzedIfFirst("t1", "");
    expect(r).toEqual({ counted: false, alreadyAnalyzed: false });
    expect(dbState.threads.get("t1")?.analyzedAt).toBeNull();
  });

  it("non-existent thread returns counted: false", async () => {
    const r = await markThreadAnalyzedIfFirst("ghost", "shop-a.myshopify.com");
    expect(r).toEqual({ counted: false, alreadyAnalyzed: false });
  });

  it("100 sequential calls on the same thread yield exactly one count", async () => {
    dbState.threads.set("t1", { id: "t1", shop: "shop-a.myshopify.com", analyzedAt: null });
    let counted = 0;
    for (let i = 0; i < 100; i++) {
      const r = await markThreadAnalyzedIfFirst("t1", "shop-a.myshopify.com");
      if (r.counted) counted++;
    }
    expect(counted).toBe(1);
    // And usage incremented exactly once.
    const usage = dbState.usage.find((u) => u.shop === "shop-a.myshopify.com");
    expect(usage?.count).toBe(1);
  });
});
