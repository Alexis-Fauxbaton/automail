import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTrackingFacts } from "../tracking-service";
import * as adapter from "../adapters/seventeen-track";
import type { OrderFacts } from "../../types";

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
      state: "ok", carrierName: "La Poste", status: "InTransit",
      lastEvent: "Sorted", lastLocation: "Paris", lastEventDate: "2026-05-14T08:00:00Z",
      delivered: false, events: [],
    });
    const [t] = await getTrackingFacts(makeOrder());
    expect(t.last17trackAttempt).toBe("ok");
    expect(t.last17trackAttemptAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(t.source).toBe("seventeen_track");
  });

  it("stamps 'pending' when 17track is pending", async () => {
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "pending", carrierName: null, status: null, lastEvent: null,
      lastLocation: null, lastEventDate: null, delivered: false, events: [],
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
});
