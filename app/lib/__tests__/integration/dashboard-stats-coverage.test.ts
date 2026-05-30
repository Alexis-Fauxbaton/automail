// Comprehensive coverage for dashboard-stats helpers.
// Each suite contains regression tests for bugs found during the
// pixel-perfect audit + invariants we never want to break.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  testDb,
  cleanTestShop,
  createTestThread,
  disconnectTestDb,
  TEST_SHOP,
  seedIncomingEmail,
} from "./helpers/db";
import {
  getPeriodBounds,
  getDashboardKpis,
  getInboxBucketCounts,
  getTopIntentsWithPerf,
  getResponseTimeDailyBreakdown,
  getReopenedThreads,
  getHeatmap,
  getAlerts,
} from "../../dashboard-stats";

const NOW = new Date("2026-04-26T12:00:00Z");

beforeEach(async () => {
  await cleanTestShop();
});
afterAll(async () => {
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createIncoming(overrides: {
  threadId: string;
  externalId: string;
  receivedAt: Date;
  processingStatus?: string;
  tier2Result?: string | null;
  detectedIntent?: string | null;
  fromAddress?: string;
}) {
  // Resolve mailConnectionId from the parent thread (required FK since multi-mailbox).
  const thread = await testDb.thread.findUniqueOrThrow({ where: { id: overrides.threadId }, select: { mailConnectionId: true } });
  return testDb.incomingEmail.create({
    data: {
      shop: TEST_SHOP,
      mailConnectionId: thread.mailConnectionId,
      externalMessageId: overrides.externalId,
      canonicalThreadId: overrides.threadId,
      fromAddress: overrides.fromAddress ?? "customer@example.com",
      subject: "Subject",
      bodyText: "Body",
      receivedAt: overrides.receivedAt,
      processingStatus: overrides.processingStatus ?? "analyzed",
      tier2Result: overrides.tier2Result ?? null,
      detectedIntent: overrides.detectedIntent ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// REGRESSION: bug #1 — non_support threads must never appear in actionable buckets
// (Now enforced through getInboxBucketCounts → getThreadOpsBucket, which sends
// supportNature='non_support' straight to the 'other' bucket.)
// ---------------------------------------------------------------------------

describe("getInboxBucketCounts — non_support exclusion", () => {
  it("REG-1: non_support threads atterrissent dans 'other', pas dans les actionables", async () => {
    // 2 confirmed_support + 3 non_support + 1 unknown. seedIncomingEmail is
    // required because getInboxBucketCounts excludes phantom threads (no messages).
    const threads = await Promise.all([
      createTestThread({ supportNature: "confirmed_support", operationalState: "open" }),
      createTestThread({ supportNature: "confirmed_support", operationalState: "open" }),
      createTestThread({ supportNature: "non_support", operationalState: "open" }),
      createTestThread({ supportNature: "non_support", operationalState: "open" }),
      createTestThread({ supportNature: "non_support", operationalState: "open" }),
      createTestThread({ supportNature: "unknown", operationalState: "open" }),
    ]);
    await Promise.all(threads.map((t) => seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: t.mailConnectionId, canonicalThreadId: t.id })));
    const counts = await getInboxBucketCounts(TEST_SHOP);
    // confirmed_support with no analyzedAt + no dismissedFromAnalyzeAt → 'to_analyze'.
    expect(counts.to_analyze).toBe(2);
    // 3 non_support + 1 unknown (op=open, no support stance) → 'other'.
    expect(counts.other).toBe(4);
  });

  it("REG-1bis: 'resolved' n'inclut pas les non_support", async () => {
    const threads = await Promise.all([
      createTestThread({ supportNature: "non_support", operationalState: "no_reply_needed" }),
      createTestThread({ supportNature: "non_support", operationalState: "no_reply_needed" }),
      createTestThread({ supportNature: "confirmed_support", operationalState: "no_reply_needed", analyzedAt: NOW }),
    ]);
    await Promise.all(threads.map((t) => seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: t.mailConnectionId, canonicalThreadId: t.id })));
    const counts = await getInboxBucketCounts(TEST_SHOP);
    expect(counts.resolved).toBe(1);
  });

  it("retourne des zéros pour une boutique vide", async () => {
    const counts = await getInboxBucketCounts(TEST_SHOP);
    expect(counts).toEqual({
      to_process: 0,
      to_analyze: 0,
      waiting_customer: 0,
      waiting_merchant: 0,
      resolved: 0,
      other: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: bug #2 — getTopIntentsWithPerf used thread.firstMessageAt
// (excluded re-opened threads with fresh activity in period)
// ---------------------------------------------------------------------------

describe("getTopIntentsWithPerf — active threads, not just newly created", () => {
  it("REG-2: thread créé avant la période avec activité dans la période est compté", async () => {
    const { start, end } = getPeriodBounds("7d", undefined, undefined, NOW);

    // Thread created BEFORE the period (firstMessageAt = D-30)
    const oldThread = await createTestThread({
      supportNature: "confirmed_support",
      firstMessageAt: new Date(start.getTime() - 23 * 24 * 60 * 60 * 1000),
    });

    // Email IN the period — this is what should bring the thread back into top motifs
    await createIncoming({
      threadId: oldThread.id,
      externalId: "active-1",
      receivedAt: new Date(start.getTime() + 1 * 24 * 60 * 60 * 1000),
      detectedIntent: "marked_delivered_not_received",
    });

    const intents = await getTopIntentsWithPerf(TEST_SHOP, start, end, 5);
    expect(intents).toHaveLength(1);
    expect(intents[0].intent).toBe("marked_delivered_not_received");
    expect(intents[0].count).toBe(1);
  });

  it("REG-2bis: ne compte pas les threads non_support même s'ils ont detectedIntent", async () => {
    const { start, end } = getPeriodBounds("7d", undefined, undefined, NOW);
    const t1 = await createTestThread({
      supportNature: "non_support",
      firstMessageAt: new Date(start.getTime() + 1 * 24 * 60 * 60 * 1000),
    });
    await createIncoming({
      threadId: t1.id,
      externalId: "non-support-leak",
      receivedAt: new Date(start.getTime() + 1 * 24 * 60 * 60 * 1000),
      detectedIntent: "refund_request",
    });
    const intents = await getTopIntentsWithPerf(TEST_SHOP, start, end, 5);
    expect(intents).toHaveLength(0);
  });

  it("trie par count desc, applique le limit", async () => {
    const { start, end } = getPeriodBounds("7d", undefined, undefined, NOW);
    const inPeriodAt = (i: number) => new Date(start.getTime() + (i + 1) * 60 * 60 * 1000);

    // 3 threads with refund_request, 1 with delivery_delay
    for (let i = 0; i < 3; i++) {
      const t = await createTestThread({ supportNature: "confirmed_support", firstMessageAt: inPeriodAt(i) });
      await createIncoming({ threadId: t.id, externalId: `r-${i}`, receivedAt: inPeriodAt(i), detectedIntent: "refund_request" });
    }
    const td = await createTestThread({ supportNature: "confirmed_support", firstMessageAt: inPeriodAt(10) });
    await createIncoming({ threadId: td.id, externalId: "d-1", receivedAt: inPeriodAt(10), detectedIntent: "delivery_delay" });

    const intents = await getTopIntentsWithPerf(TEST_SHOP, start, end, 5);
    expect(intents.map(i => [i.intent, i.count])).toEqual([
      ["refund_request", 3],
      ["delivery_delay", 1],
    ]);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: bug #3 — daily breakdown 'support' field returned thread count
// instead of email count, breaking consistency with the Volume KPI.
// ---------------------------------------------------------------------------

describe("getResponseTimeDailyBreakdown — chart consistency with Volume KPI", () => {
  it("REG-3: la somme du chart 'support' égale le KPI Volume", async () => {
    const { start, end, prevStart, prevEnd } = getPeriodBounds("7d", undefined, undefined, NOW);

    // 1 thread with 3 emails in the same day → KPI counts 3 emails, chart should too
    const t = await createTestThread({
      supportNature: "confirmed_support",
      firstMessageAt: new Date(start.getTime() + 1 * 24 * 60 * 60 * 1000),
    });
    for (let i = 0; i < 3; i++) {
      await createIncoming({
        threadId: t.id,
        externalId: `e-${i}`,
        receivedAt: new Date(start.getTime() + 1 * 24 * 60 * 60 * 1000 + i * 60 * 60 * 1000),
        tier2Result: "support_client",
      });
    }

    const [kpis, chart] = await Promise.all([
      getDashboardKpis(TEST_SHOP, start, end, prevStart, prevEnd),
      getResponseTimeDailyBreakdown(TEST_SHOP, start, end),
    ]);

    const chartSum = chart.reduce((s, p) => s + p.support, 0);
    expect(kpis.volume.count).toBe(3);
    expect(chartSum).toBe(kpis.volume.count); // ← the invariant
  });

  it("medianMs reste calculé sur les threads créés ce jour-là", async () => {
    const { start, end } = getPeriodBounds("7d", undefined, undefined, NOW);
    const day = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000);

    const t = await createTestThread({
      supportNature: "confirmed_support",
      firstMessageAt: day,
    });
    await createIncoming({ threadId: t.id, externalId: "m-in", receivedAt: day, tier2Result: "support_client" });
    await createIncoming({
      threadId: t.id, externalId: "m-out",
      receivedAt: new Date(day.getTime() + 4 * 60 * 60 * 1000), // +4h
      processingStatus: "outgoing",
    });

    const chart = await getResponseTimeDailyBreakdown(TEST_SHOP, start, end);
    const dayPoint = chart.find(p => p.medianMs !== null);
    expect(dayPoint?.medianMs).toBe(4 * 60 * 60 * 1000);
  });

  it("retourne tous les jours de la période avec 0 pour les jours sans données", async () => {
    const { start, end } = getPeriodBounds("7d", undefined, undefined, NOW);
    const chart = await getResponseTimeDailyBreakdown(TEST_SHOP, start, end);
    expect(chart.length).toBeGreaterThanOrEqual(7);
    expect(chart.every(p => p.support === 0 && p.medianMs === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INVARIANTS: cross-helper consistency
// ---------------------------------------------------------------------------

describe("Invariants — cross-helper consistency", () => {
  it("Volume KPI == sum(heatmap) == sum(daily chart support)", async () => {
    const { start, end, prevStart, prevEnd } = getPeriodBounds("7d", undefined, undefined, NOW);

    const t = await createTestThread({
      supportNature: "confirmed_support",
      firstMessageAt: new Date(start.getTime() + 1 * 24 * 60 * 60 * 1000),
    });
    // 5 support emails, varied days/hours
    for (let i = 0; i < 5; i++) {
      await createIncoming({
        threadId: t.id,
        externalId: `inv-${i}`,
        receivedAt: new Date(start.getTime() + (i + 1) * 12 * 60 * 60 * 1000),
        tier2Result: "support_client",
      });
    }

    const [kpis, heat, chart] = await Promise.all([
      getDashboardKpis(TEST_SHOP, start, end, prevStart, prevEnd),
      getHeatmap(TEST_SHOP, start, end),
      getResponseTimeDailyBreakdown(TEST_SHOP, start, end),
    ]);

    expect(kpis.volume.count).toBe(5);
    expect(heat.reduce((s, c) => s + c.count, 0)).toBe(5);
    expect(chart.reduce((s, p) => s + p.support, 0)).toBe(5);
  });

  it("Reopened list count <= Reopened KPI count (KPI counts events, list groups by thread)", async () => {
    const { start, end, prevStart, prevEnd } = getPeriodBounds("7d", undefined, undefined, NOW);
    const t = await createTestThread({ supportNature: "confirmed_support" });

    // 3 reopen events on same thread (KPI=3, list=1 thread)
    for (let i = 0; i < 3; i++) {
      await testDb.threadStateHistory.create({
        data: {
          shop: TEST_SHOP,
          threadId: t.id,
          fromState: "resolved",
          toState: "open",
          changedAt: new Date(start.getTime() + (i + 1) * 60 * 60 * 1000),
        },
      });
    }
    const [kpis, list] = await Promise.all([
      getDashboardKpis(TEST_SHOP, start, end, prevStart, prevEnd),
      getReopenedThreads(TEST_SHOP, start, end, 10),
    ]);
    expect(kpis.reopened.count).toBe(3);
    expect(list.length).toBe(1);
    expect(list[0].reopenCount).toBe(3);
    expect(list.length).toBeLessThanOrEqual(kpis.reopened.count);
  });

});

// ---------------------------------------------------------------------------
// REGRESSION: bug #4 — alerts use email count (not thread count) for volume_surge
// ---------------------------------------------------------------------------

describe("getAlerts — volume_surge uses email count consistently with KPI", () => {
  it("REG-4: volume_surge baseline counts emails (consistent with Volume KPI)", async () => {
    // Build: current period 30+ emails, baseline window has 1 email → ratio >> 2× threshold met.
    // Need >= 20 absolute volume.
    const { start, end } = getPeriodBounds("7d", undefined, undefined, NOW);
    const baselineDay = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);

    const tCur = await createTestThread({
      supportNature: "confirmed_support",
      firstMessageAt: new Date(start.getTime() + 60_000),
    });
    for (let i = 0; i < 25; i++) {
      await createIncoming({
        threadId: tCur.id,
        externalId: `vol-cur-${i}`,
        receivedAt: new Date(start.getTime() + (i + 1) * 60 * 1000),
        tier2Result: "support_client",
      });
    }
    const tBase = await createTestThread({
      supportNature: "confirmed_support",
      firstMessageAt: baselineDay,
    });
    await createIncoming({
      threadId: tBase.id, externalId: "vol-base-1",
      receivedAt: baselineDay, tier2Result: "support_client",
    });

    const intents = await getTopIntentsWithPerf(TEST_SHOP, start, end, 5);
    const alerts = await getAlerts(TEST_SHOP, "7d", start, end, intents);
    const volAlert = alerts.find(a => a.type === "volume_surge");
    expect(volAlert).toBeDefined();
    expect(volAlert!.current).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: bug #5 — delay_degraded was declared but never generated
// ---------------------------------------------------------------------------

describe("getAlerts — delay_degraded fires when median degrades", () => {
  it("REG-5: déclenche delay_degraded quand current median >= 2× baseline et >= 8h", async () => {
    const { start, end } = getPeriodBounds("7d", undefined, undefined, NOW);

    // Current period: 1 thread responded after 20h
    const tCur = await createTestThread({
      supportNature: "confirmed_support",
      firstMessageAt: new Date(start.getTime() + 60_000),
    });
    await createIncoming({ threadId: tCur.id, externalId: "delay-in-cur", receivedAt: new Date(start.getTime() + 60_000) });
    await createIncoming({
      threadId: tCur.id, externalId: "delay-out-cur",
      receivedAt: new Date(start.getTime() + 60_000 + 20 * 60 * 60 * 1000),
      processingStatus: "outgoing",
    });

    // Baseline windows (4 prior 7d windows for "7d" range): 1 thread each, 1h response
    for (let w = 1; w <= 4; w++) {
      const wStart = new Date(start.getTime() - w * 7 * 24 * 60 * 60 * 1000);
      const tBase = await createTestThread({
        supportNature: "confirmed_support",
        firstMessageAt: new Date(wStart.getTime() + 60_000),
      });
      await createIncoming({ threadId: tBase.id, externalId: `delay-in-w${w}`, receivedAt: new Date(wStart.getTime() + 60_000) });
      await createIncoming({
        threadId: tBase.id, externalId: `delay-out-w${w}`,
        receivedAt: new Date(wStart.getTime() + 60_000 + 1 * 60 * 60 * 1000),
        processingStatus: "outgoing",
      });
    }

    const intents = await getTopIntentsWithPerf(TEST_SHOP, start, end, 5);
    const alerts = await getAlerts(TEST_SHOP, "7d", start, end, intents);

    const delayAlert = alerts.find(a => a.type === "delay_degraded");
    expect(delayAlert).toBeDefined();
    expect(delayAlert!.current).toBe(20 * 60 * 60 * 1000);
    expect(delayAlert!.baseline).toBe(1 * 60 * 60 * 1000);
    expect(delayAlert!.magnitude).toBe(20);
  });

  it("ne déclenche pas delay_degraded si le median current < 8h", async () => {
    const { start, end } = getPeriodBounds("7d", undefined, undefined, NOW);
    const tCur = await createTestThread({
      supportNature: "confirmed_support",
      firstMessageAt: new Date(start.getTime() + 60_000),
    });
    await createIncoming({ threadId: tCur.id, externalId: "fast-in", receivedAt: new Date(start.getTime() + 60_000) });
    await createIncoming({
      threadId: tCur.id, externalId: "fast-out",
      receivedAt: new Date(start.getTime() + 60_000 + 5 * 60 * 60 * 1000), // 5h
      processingStatus: "outgoing",
    });
    // No baseline → still no alert (under 8h floor)
    const alerts = await getAlerts(TEST_SHOP, "7d", start, end, []);
    expect(alerts.find(a => a.type === "delay_degraded")).toBeUndefined();
  });

  it("retourne [] pour range=90d (alerts disabled)", async () => {
    const { start, end } = getPeriodBounds("90d", undefined, undefined, NOW);
    const alerts = await getAlerts(TEST_SHOP, "90d", start, end, []);
    expect(alerts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: bug #6 — intent_surge baseline didn't filter on supportNature
// ---------------------------------------------------------------------------

describe("getAlerts — intent_surge baseline filters on supportNature", () => {
  it("REG-6: intent_surge ne compte pas les non_support dans le baseline", async () => {
    const { start, end } = getPeriodBounds("7d", undefined, undefined, NOW);

    // Current: 6 support threads with refund_request (>= 5 threshold)
    for (let i = 0; i < 6; i++) {
      const t = await createTestThread({
        supportNature: "confirmed_support",
        firstMessageAt: new Date(start.getTime() + (i + 1) * 60 * 1000),
      });
      await createIncoming({
        threadId: t.id, externalId: `cur-${i}`,
        receivedAt: new Date(start.getTime() + (i + 1) * 60 * 1000),
        detectedIntent: "refund_request",
      });
    }

    // Baseline: many non_support with refund_request (should NOT count)
    // + 1 support refund per baseline window (true baseline = 1)
    for (let w = 1; w <= 4; w++) {
      const wStart = new Date(start.getTime() - w * 7 * 24 * 60 * 60 * 1000);
      // pollute with non_support
      for (let n = 0; n < 10; n++) {
        const t = await createTestThread({
          supportNature: "non_support",
          firstMessageAt: new Date(wStart.getTime() + n * 60 * 1000),
        });
        await createIncoming({
          threadId: t.id, externalId: `non-w${w}-${n}`,
          receivedAt: new Date(wStart.getTime() + n * 60 * 1000),
          detectedIntent: "refund_request",
        });
      }
      // real support baseline
      const tSup = await createTestThread({
        supportNature: "confirmed_support",
        firstMessageAt: new Date(wStart.getTime() + 11 * 60 * 1000),
      });
      await createIncoming({
        threadId: tSup.id, externalId: `sup-w${w}`,
        receivedAt: new Date(wStart.getTime() + 11 * 60 * 1000),
        detectedIntent: "refund_request",
      });
    }

    const intents = await getTopIntentsWithPerf(TEST_SHOP, start, end, 5);
    expect(intents.find(i => i.intent === "refund_request")?.count).toBe(6);

    const alerts = await getAlerts(TEST_SHOP, "7d", start, end, intents);
    const surge = alerts.find(a => a.type === "intent_surge" && a.label.includes("refund_request"));
    // Baseline (after fix): 1 per window → average 1. Current 6. Ratio 6× → fires.
    expect(surge).toBeDefined();
    expect(surge!.current).toBe(6);
    expect(surge!.baseline).toBe(1);
  });
});
