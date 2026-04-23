import { describe, it, expect } from "vitest";
import { normalizeOrder } from "../order-normalizer";
import type { RawOrderNode } from "../order-search";

function makeRaw(overrides: Partial<RawOrderNode> = {}): RawOrderNode {
  return {
    id: "gid://shopify/Order/1",
    name: "#1234",
    createdAt: "2024-01-15T10:00:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    customer: {
      firstName: "Jean",
      lastName: "Dupont",
      email: "jean@example.com",
    },
    lineItems: {
      edges: [{ node: { title: "T-Shirt Blue", quantity: 2 } }],
    },
    fulfillments: [
      {
        status: "SUCCESS",
        updatedAt: "2024-01-16T08:00:00Z",
        estimatedDeliveryAt: "2024-01-20T00:00:00Z",
        trackingInfo: [
          {
            number: "6123456789012",
            url: "https://suivi.laposte.fr/6123456789012",
            company: "La Poste",
          },
        ],
        fulfillmentLineItems: {
          edges: [{ node: { lineItem: { title: "T-Shirt Blue" }, quantity: 2 } }],
        },
      },
    ],
    ...overrides,
  };
}

describe("normalizeOrder", () => {
  it("maps top-level order fields correctly", () => {
    const result = normalizeOrder(makeRaw());
    expect(result.id).toBe("gid://shopify/Order/1");
    expect(result.name).toBe("#1234");
    expect(result.createdAt).toBe("2024-01-15T10:00:00Z");
    expect(result.displayFinancialStatus).toBe("PAID");
    expect(result.displayFulfillmentStatus).toBe("FULFILLED");
  });

  it("combines firstName and lastName into customerName", () => {
    const result = normalizeOrder(makeRaw());
    expect(result.customerName).toBe("Jean Dupont");
  });

  it("uses only firstName when lastName is absent", () => {
    const result = normalizeOrder(makeRaw({ customer: { firstName: "Marie", lastName: null as unknown as string, email: "marie@example.com" } }));
    expect(result.customerName).toBe("Marie");
  });

  it("sets customerName to null when customer is absent", () => {
    const result = normalizeOrder(makeRaw({ customer: null as unknown as RawOrderNode["customer"] }));
    expect(result.customerName).toBeNull();
    expect(result.customerEmail).toBeNull();
  });

  it("maps customer email", () => {
    const result = normalizeOrder(makeRaw());
    expect(result.customerEmail).toBe("jean@example.com");
  });

  it("maps line items", () => {
    const result = normalizeOrder(makeRaw());
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0]).toEqual({ title: "T-Shirt Blue", quantity: 2 });
  });

  it("maps fulfillment tracking info", () => {
    const result = normalizeOrder(makeRaw());
    expect(result.fulfillments).toHaveLength(1);
    const f = result.fulfillments[0];
    expect(f.status).toBe("SUCCESS");
    expect(f.trackingNumbers).toEqual(["6123456789012"]);
    expect(f.trackingUrls).toEqual(["https://suivi.laposte.fr/6123456789012"]);
    expect(f.carrier).toBe("La Poste");
    expect(f.updatedAt).toBe("2024-01-16T08:00:00Z");
    expect(f.estimatedDeliveryAt).toBe("2024-01-20T00:00:00Z");
  });

  it("maps fulfillment line items", () => {
    const result = normalizeOrder(makeRaw());
    expect(result.fulfillments[0].lineItems).toEqual([{ title: "T-Shirt Blue", quantity: 2 }]);
  });

  it("returns empty fulfillments array when none present", () => {
    const result = normalizeOrder(makeRaw({ fulfillments: [] }));
    expect(result.fulfillments).toHaveLength(0);
  });

  it("handles fulfillment with empty trackingInfo", () => {
    const result = normalizeOrder(
      makeRaw({
        fulfillments: [
          {
            status: "PENDING",
            updatedAt: null,
            estimatedDeliveryAt: null,
            trackingInfo: [],
            fulfillmentLineItems: { edges: [] },
          },
        ],
      }),
    );
    const f = result.fulfillments[0];
    expect(f.trackingNumbers).toEqual([]);
    expect(f.trackingUrls).toEqual([]);
    expect(f.carrier).toBeNull();
  });

  it("handles multiple tracking entries — picks first URL and first number", () => {
    const result = normalizeOrder(
      makeRaw({
        fulfillments: [
          {
            status: "SUCCESS",
            updatedAt: null,
            estimatedDeliveryAt: null,
            trackingInfo: [
              { number: "AAA", url: "https://carrier.com/AAA", company: "CarrierA" },
              { number: "BBB", url: "https://carrier.com/BBB", company: "CarrierB" },
            ],
            fulfillmentLineItems: { edges: [] },
          },
        ],
      }),
    );
    const f = result.fulfillments[0];
    expect(f.trackingNumbers).toEqual(["AAA", "BBB"]);
    expect(f.trackingUrls).toEqual(["https://carrier.com/AAA", "https://carrier.com/BBB"]);
    // carrier is from the first entry that has a company
    expect(f.carrier).toBe("CarrierA");
  });

  it("handles null lineItems edges gracefully", () => {
    const result = normalizeOrder(
      makeRaw({ lineItems: { edges: [] } }),
    );
    expect(result.lineItems).toEqual([]);
  });

  it("maps multiple fulfillments", () => {
    const raw = makeRaw();
    raw.fulfillments = [
      { ...raw.fulfillments[0] },
      {
        status: "SUCCESS",
        updatedAt: null,
        estimatedDeliveryAt: null,
        trackingInfo: [{ number: "7777777777777", url: null, company: null }],
        fulfillmentLineItems: { edges: [] },
      },
    ];
    const result = normalizeOrder(raw);
    expect(result.fulfillments).toHaveLength(2);
  });
});
