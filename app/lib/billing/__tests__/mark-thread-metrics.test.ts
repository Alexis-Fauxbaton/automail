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
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockClient)),
    thread: {
      updateMany: async ({
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
      findUnique: async ({ where }: { where: { id: string } }) =>
        dbState.threads.get(where.id) ?? null,
    },
    billingUsage: {
      upsert: async ({
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
    },
  };
  return { default: mockClient };
});

import { metrics } from "../../metrics/registry";
import {
  billingAnalyzedThreadCountedTotal,
  billingAnalyzedThreadSkippedTotal,
} from "../../metrics/definitions";
import { markThreadAnalyzedIfFirst } from "../usage";

/**
 * NOTE: we don't call `__resetMetricsForTest()` because it wipes the
 * registry's internal map, but the counter API closures captured at
 * `definitions.ts` module-load time still reference the original metric
 * objects — so .inc() writes to an orphan and snapshot() returns empty.
 * Instead, we use distinct shop labels per test and assert against
 * baseline-aware reads via collect().
 */

function getCounterValue(
  counter: typeof billingAnalyzedThreadCountedTotal | typeof billingAnalyzedThreadSkippedTotal,
  match: (labels: Record<string, string>) => boolean,
): number {
  const s = counter.collect().find((x) => match(x.labels));
  return s?.value ?? 0;
}

beforeEach(() => {
  dbState.threads.clear();
  dbState.usage.length = 0;
});

describe("markThreadAnalyzedIfFirst — metrics (Class 11)", () => {
  it("emits billing_analyzed_thread_counted_total on success", async () => {
    const shop = "shop-metrics-1.myshopify.com";
    const before = getCounterValue(billingAnalyzedThreadCountedTotal, (l) => l.shop === shop);
    dbState.threads.set("t1", { id: "t1", shop, analyzedAt: null });
    await markThreadAnalyzedIfFirst("t1", shop);

    const snap = metrics.snapshot();
    const counted = snap.counters.find((c) => c.name === "billing_analyzed_thread_counted_total");
    expect(counted).toBeDefined();
    expect(getCounterValue(billingAnalyzedThreadCountedTotal, (l) => l.shop === shop)).toBe(
      before + 1,
    );
  });

  it("emits skipped_total with reason=already_analyzed on second call", async () => {
    const shop = "shop-metrics-2.myshopify.com";
    const before = getCounterValue(
      billingAnalyzedThreadSkippedTotal,
      (l) => l.shop === shop && l.reason === "already_analyzed",
    );
    dbState.threads.set("t1", { id: "t1", shop, analyzedAt: null });
    await markThreadAnalyzedIfFirst("t1", shop);
    await markThreadAnalyzedIfFirst("t1", shop);

    const snap = metrics.snapshot();
    const skipped = snap.counters.find((c) => c.name === "billing_analyzed_thread_skipped_total");
    expect(skipped).toBeDefined();
    expect(
      getCounterValue(
        billingAnalyzedThreadSkippedTotal,
        (l) => l.shop === shop && l.reason === "already_analyzed",
      ),
    ).toBe(before + 1);
  });

  it("emits skipped_total with reason=invalid_input on empty threadId", async () => {
    const shop = "shop-metrics-3.myshopify.com";
    // The implementation labels invalid_input with shop="" when shop is provided
    // but threadId is empty. Match on reason regardless of shop.
    const before = getCounterValue(
      billingAnalyzedThreadSkippedTotal,
      (l) => l.reason === "invalid_input",
    );
    await markThreadAnalyzedIfFirst("", shop);
    expect(
      getCounterValue(billingAnalyzedThreadSkippedTotal, (l) => l.reason === "invalid_input"),
    ).toBe(before + 1);
  });

  it("emits skipped_total with reason=not_found on shop mismatch", async () => {
    const shopA = "shop-metrics-4a.myshopify.com";
    const shopB = "shop-metrics-4b.myshopify.com";
    const before = getCounterValue(
      billingAnalyzedThreadSkippedTotal,
      (l) => l.shop === shopB && l.reason === "not_found",
    );
    dbState.threads.set("t1", { id: "t1", shop: shopA, analyzedAt: null });
    await markThreadAnalyzedIfFirst("t1", shopB);
    expect(
      getCounterValue(
        billingAnalyzedThreadSkippedTotal,
        (l) => l.shop === shopB && l.reason === "not_found",
      ),
    ).toBe(before + 1);
  });

  it("counted total stays in sync with DB increments", async () => {
    const shop = "shop-metrics-5.myshopify.com";
    const before = getCounterValue(billingAnalyzedThreadCountedTotal, (l) => l.shop === shop);
    for (let i = 0; i < 5; i++) {
      const id = `t${i}`;
      dbState.threads.set(id, { id, shop, analyzedAt: null });
      await markThreadAnalyzedIfFirst(id, shop);
    }
    expect(getCounterValue(billingAnalyzedThreadCountedTotal, (l) => l.shop === shop)).toBe(
      before + 5,
    );
    // DB usage matches: 5 increments in this test.
    const usageRow = dbState.usage.find((u) => u.shop === shop);
    expect(usageRow?.count).toBe(5);
  });
});
