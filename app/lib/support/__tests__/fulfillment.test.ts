import { describe, it, expect } from "vitest";
import { computeUnfulfilledItems } from "../fulfillment";
import type { OrderFacts } from "../types";

function order(partial: Partial<OrderFacts>): OrderFacts {
  return {
    id: "gid://shopify/Order/1",
    name: "#1",
    createdAt: "2026-01-01T00:00:00Z",
    lineItems: [],
    fulfillments: [],
    ...partial,
  };
}

describe("computeUnfulfilledItems", () => {
  it("returns [] for a null order", () => {
    expect(computeUnfulfilledItems(null)).toEqual([]);
  });

  it("returns [] when Shopify reports the order fully fulfilled", () => {
    const o = order({
      displayFulfillmentStatus: "FULFILLED",
      lineItems: [{ title: "Lamp", quantity: 1 }],
      fulfillments: [],
    });
    expect(computeUnfulfilledItems(o)).toEqual([]);
  });

  it("returns every item when nothing has shipped", () => {
    const o = order({
      displayFulfillmentStatus: "UNFULFILLED",
      lineItems: [
        { title: "Lamp", quantity: 1 },
        { title: "Shade", quantity: 2 },
      ],
      fulfillments: [],
    });
    expect(computeUnfulfilledItems(o)).toEqual([
      { title: "Lamp", quantity: 1 },
      { title: "Shade", quantity: 2 },
    ]);
  });

  it("returns only the unshipped item on partial fulfillment", () => {
    const o = order({
      displayFulfillmentStatus: "PARTIALLY_FULFILLED",
      lineItems: [
        { title: "Lamp", quantity: 1 },
        { title: "Suspension", quantity: 1 },
      ],
      fulfillments: [
        { status: "SUCCESS", trackingNumbers: ["CK1"], trackingUrls: [], lineItems: [{ title: "Suspension", quantity: 1 }] },
      ],
    });
    expect(computeUnfulfilledItems(o)).toEqual([{ title: "Lamp", quantity: 1 }]);
  });

  it("reports the remaining quantity when a line is only partly shipped", () => {
    const o = order({
      displayFulfillmentStatus: "PARTIALLY_FULFILLED",
      lineItems: [{ title: "Lamp", quantity: 3 }],
      fulfillments: [
        { status: "SUCCESS", trackingNumbers: ["CK1"], trackingUrls: [], lineItems: [{ title: "Lamp", quantity: 1 }] },
      ],
    });
    expect(computeUnfulfilledItems(o)).toEqual([{ title: "Lamp", quantity: 2 }]);
  });
});
