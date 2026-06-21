import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTrackingFacts } from "../tracking-service";
import * as adapter from "../adapters/seventeen-track";
import type { OrderFacts } from "../../types";
import {
  trackingResolutionTotal,
  trackingCorroborationTotal,
  trackingHintTotal,
} from "../../../metrics/definitions";

function makeOrder(): OrderFacts {
  return {
    id: "gid://shopify/Order/1",
    orderNumber: "#1001",
    orderDate: "2026-05-14T10:00:00Z",
    customerName: "C", customerEmail: "c@x.com",
    financialStatus: "PAID", fulfillmentStatus: "FULFILLED",
    status: "open",
    fulfillments: [
      {
        trackingNumbers: ["LV109807596FR"],
        trackingUrls: ["https://laposte.fr/x"],
        carrier: "La Poste",
        lineItems: [],
      },
    ],
    lineItems: [],
  } as unknown as OrderFacts;
}

describe("getTrackingFacts — last17trackAttempt stamping", () => {
  const KEY = process.env.SEVENTEEN_TRACK_API_KEY;
  beforeEach(() => { process.env.SEVENTEEN_TRACK_API_KEY = "test-key"; });
  afterEach(() => { process.env.SEVENTEEN_TRACK_API_KEY = KEY; vi.restoreAllMocks(); });

  it("stamps 'ok' when 17track returns ok", async () => {
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "ok", carrierName: "La Poste", carrierCode: 6051, status: "InTransit",
      lastEvent: "Sorted", lastLocation: "Paris", lastEventDate: "2026-05-14T08:00:00Z",
      delivered: false, events: [], recipientCountry: null,
    });
    const [t] = await getTrackingFacts(makeOrder());
    expect(t.last17trackAttempt).toBe("ok");
    expect(t.last17trackAttemptAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(t.source).toBe("seventeen_track");
  });

  it("stamps 'pending' when 17track is pending", async () => {
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "pending", carrierName: null, carrierCode: null, status: null, lastEvent: null,
      lastLocation: null, lastEventDate: null, delivered: false, events: [], recipientCountry: null,
    });
    const [t] = await getTrackingFacts(makeOrder());
    expect(t.last17trackAttempt).toBe("pending");
  });

  it("stamps 'error' when 17track returns null (breaker open / HTTP fail)", async () => {
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue(null);
    const [t] = await getTrackingFacts(makeOrder());
    expect(t.last17trackAttempt).toBe("error");
    expect(t.source).not.toBe("seventeen_track");
  });

  it("stamps 'error' when 17track throws", async () => {
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockRejectedValue(new Error("boom"));
    const [t] = await getTrackingFacts(makeOrder());
    expect(t.last17trackAttempt).toBe("error");
  });

  it("keeps each parcel's own tracking number in the Shopify fallback (multi-parcel fulfillment)", async () => {
    // Regression: when 17track returns null for a fulfillment carrying several
    // tracking numbers, every entry must keep its OWN number/URL — not collapse
    // to the first parcel (the "ça prend only le premier" bug).
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue(null);
    const order = makeOrder();
    order.fulfillments[0].trackingNumbers = ["CNFR1", "AP2", "AP3"];
    order.fulfillments[0].trackingUrls = [
      "https://global.cainiao.com/x?n=CNFR1",
      "https://global.cainiao.com/x?n=AP2",
      "https://global.cainiao.com/x?n=AP3",
    ];
    const facts = await getTrackingFacts(order);
    expect(facts.map((f) => f.trackingNumber)).toEqual(["CNFR1", "AP2", "AP3"]);
    expect(facts.map((f) => f.trackingUrl)).toEqual([
      "https://global.cainiao.com/x?n=CNFR1",
      "https://global.cainiao.com/x?n=AP2",
      "https://global.cainiao.com/x?n=AP3",
    ]);
  });

  it("stamps 'skipped' when no tracking number is present", async () => {
    const order = makeOrder();
    order.fulfillments[0].trackingNumbers = [];
    const [t] = await getTrackingFacts(order);
    expect(t.last17trackAttempt).toBe("skipped");
  });

  it("stamps 'skipped' (not 'error') when the breaker is open", async () => {
    const { recordFailure, __resetForTest } = await import("../seventeen-track-breaker");
    __resetForTest();
    for (let i = 0; i < 5; i++) recordFailure(); // open the breaker
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue(null);
    const [t] = await getTrackingFacts(makeOrder());
    expect(t.last17trackAttempt).toBe("skipped");
    __resetForTest(); // restore for subsequent tests
  });

  it("passes orderCountry and tracking URL to the adapter", async () => {
    const spy = vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "ok", carrierName: "Cainiao", carrierCode: 190271, status: "Delivered",
      recipientCountry: "FR", lastEvent: null, lastLocation: null, lastEventDate: null,
      delivered: true, events: [],
    } as unknown as Awaited<ReturnType<typeof adapter.fetchTrackingFrom17track>>);
    const order = makeOrder();
    (order as unknown as { destinationCountry: string }).destinationCountry = "FR";
    order.fulfillments[0].trackingUrls = ["https://global.cainiao.com/x"];
    await getTrackingFacts(order);
    expect(spy).toHaveBeenCalledWith("LV109807596FR", expect.objectContaining({ orderCountry: "FR", trackingUrl: "https://global.cainiao.com/x" }));
  });

  it("marks the fact unverified when the adapter returns corroboration_mismatch", async () => {
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "corroboration_mismatch", carrierName: null, carrierCode: null, status: null,
      recipientCountry: null, lastEvent: null, lastLocation: null, lastEventDate: null,
      delivered: false, events: [],
    } as unknown as Awaited<ReturnType<typeof adapter.fetchTrackingFrom17track>>);
    const [t] = await getTrackingFacts(makeOrder());
    expect(t.source).not.toBe("seventeen_track");
    expect(t.inferred).toBe(true);
    expect(t.last17trackAttempt).toBe("ok");
  });
});

// Helper: find the value for a specific label set in a counter's series.
function findCounterValue(
  series: Array<{ labels: Record<string, string>; value: number }>,
  labels: Record<string, string>,
): number {
  const match = series.find((s) =>
    Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  );
  return match?.value ?? 0;
}

describe("getTrackingFacts — production metrics", () => {
  // The metrics registry is a singleton whose counter series survive between
  // tests (the exported counter objects close over the internal series Map, so
  // __resetMetricsForTest only disconnects them from the registry index — it
  // does NOT zero the series). We therefore use a before/after delta pattern:
  // capture the value BEFORE the call under test and assert it increased by 1.
  const KEY = process.env.SEVENTEEN_TRACK_API_KEY;
  beforeEach(() => {
    process.env.SEVENTEEN_TRACK_API_KEY = "test-key";
  });
  afterEach(() => { process.env.SEVENTEEN_TRACK_API_KEY = KEY; vi.restoreAllMocks(); });

  it("increments tracking_resolution_total{outcome=ok_auto} on a plain ok result (no inferred carrier)", async () => {
    const before = findCounterValue(trackingResolutionTotal.collect(), { outcome: "ok_auto" });
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "ok", carrierName: "Cainiao", carrierCode: 190271, status: "Delivered",
      recipientCountry: "FR", lastEvent: null, lastLocation: null, lastEventDate: null,
      delivered: true, events: [], inferredCarrier: false,
    } as unknown as Awaited<ReturnType<typeof adapter.fetchTrackingFrom17track>>);
    await getTrackingFacts(makeOrder());
    expect(findCounterValue(trackingResolutionTotal.collect(), { outcome: "ok_auto" })).toBe(before + 1);
  });

  it("increments tracking_resolution_total{outcome=ok_hint_recovered} + trackingHintTotal{source=reactive,result=recovered} when recoveredViaHint is true", async () => {
    const beforeRes = findCounterValue(trackingResolutionTotal.collect(), { outcome: "ok_hint_recovered" });
    const beforeHint = findCounterValue(trackingHintTotal.collect(), { source: "reactive", result: "recovered" });
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "ok", carrierName: "Cainiao", carrierCode: 190271, status: "InTransit",
      recipientCountry: null, lastEvent: null, lastLocation: null, lastEventDate: null,
      delivered: false, events: [], recoveredViaHint: true,
    } as unknown as Awaited<ReturnType<typeof adapter.fetchTrackingFrom17track>>);
    await getTrackingFacts(makeOrder());
    expect(findCounterValue(trackingResolutionTotal.collect(), { outcome: "ok_hint_recovered" })).toBe(beforeRes + 1);
    expect(findCounterValue(trackingHintTotal.collect(), { source: "reactive", result: "recovered" })).toBe(beforeHint + 1);
  });

  it("increments tracking_resolution_total{outcome=pending} on pending state", async () => {
    const before = findCounterValue(trackingResolutionTotal.collect(), { outcome: "pending" });
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "pending", carrierName: null, carrierCode: null, status: null, lastEvent: null,
      lastLocation: null, lastEventDate: null, delivered: false, events: [], recipientCountry: null,
    });
    await getTrackingFacts(makeOrder());
    expect(findCounterValue(trackingResolutionTotal.collect(), { outcome: "pending" })).toBe(before + 1);
  });

  it("increments tracking_resolution_total{outcome=notfound} + corroboration{result=mismatch_rejected} on corroboration_mismatch", async () => {
    const beforeRes = findCounterValue(trackingResolutionTotal.collect(), { outcome: "notfound" });
    const beforeCorr = findCounterValue(trackingCorroborationTotal.collect(), { result: "mismatch_rejected" });
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "corroboration_mismatch", carrierName: null, carrierCode: null, status: null,
      recipientCountry: null, lastEvent: null, lastLocation: null, lastEventDate: null,
      delivered: false, events: [],
    } as unknown as Awaited<ReturnType<typeof adapter.fetchTrackingFrom17track>>);
    await getTrackingFacts(makeOrder());
    expect(findCounterValue(trackingResolutionTotal.collect(), { outcome: "notfound" })).toBe(beforeRes + 1);
    expect(findCounterValue(trackingCorroborationTotal.collect(), { result: "mismatch_rejected" })).toBe(beforeCorr + 1);
  });

  it("increments tracking_resolution_total{outcome=error} when adapter throws", async () => {
    const before = findCounterValue(trackingResolutionTotal.collect(), { outcome: "error" });
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockRejectedValue(new Error("boom"));
    await getTrackingFacts(makeOrder());
    expect(findCounterValue(trackingResolutionTotal.collect(), { outcome: "error" })).toBe(before + 1);
  });

  it("increments tracking_resolution_total{outcome=error} when adapter returns null (real transient failure)", async () => {
    const before = findCounterValue(trackingResolutionTotal.collect(), { outcome: "error" });
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue(null);
    await getTrackingFacts(makeOrder());
    expect(findCounterValue(trackingResolutionTotal.collect(), { outcome: "error" })).toBe(before + 1);
  });

  it("increments corroboration{result=match} when recipientCountry is set and carrier is confirmed", async () => {
    const before = findCounterValue(trackingCorroborationTotal.collect(), { result: "match" });
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "ok", carrierName: "La Poste", carrierCode: 6051, status: "InTransit",
      recipientCountry: "FR", lastEvent: null, lastLocation: null, lastEventDate: null,
      delivered: false, events: [], inferredCarrier: false,
    } as unknown as Awaited<ReturnType<typeof adapter.fetchTrackingFrom17track>>);
    await getTrackingFacts(makeOrder());
    expect(findCounterValue(trackingCorroborationTotal.collect(), { result: "match" })).toBe(before + 1);
  });

  it("increments corroboration{result=absent_unverified} when recipientCountry is null and recoveredViaHint is false (no gap case)", async () => {
    const before = findCounterValue(trackingCorroborationTotal.collect(), { result: "absent_unverified" });
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "ok", carrierName: "Cainiao", carrierCode: 190271, status: "InTransit",
      recipientCountry: null, lastEvent: null, lastLocation: null, lastEventDate: null,
      delivered: false, events: [], recoveredViaHint: false,
    } as unknown as Awaited<ReturnType<typeof adapter.fetchTrackingFrom17track>>);
    await getTrackingFacts(makeOrder());
    expect(findCounterValue(trackingCorroborationTotal.collect(), { result: "absent_unverified" })).toBe(before + 1);
  });

  it("ok_auto + corroboration{match} when recipientCountry is set and recoveredViaHint is absent/false", async () => {
    const beforeRes = findCounterValue(trackingResolutionTotal.collect(), { outcome: "ok_auto" });
    const beforeCorr = findCounterValue(trackingCorroborationTotal.collect(), { result: "match" });
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "ok", carrierName: "La Poste", carrierCode: 6051, status: "InTransit",
      recipientCountry: "FR", lastEvent: null, lastLocation: null, lastEventDate: null,
      delivered: false, events: [],
    } as unknown as Awaited<ReturnType<typeof adapter.fetchTrackingFrom17track>>);
    await getTrackingFacts(makeOrder());
    expect(findCounterValue(trackingResolutionTotal.collect(), { outcome: "ok_auto" })).toBe(beforeRes + 1);
    expect(findCounterValue(trackingCorroborationTotal.collect(), { result: "match" })).toBe(beforeCorr + 1);
  });
});
