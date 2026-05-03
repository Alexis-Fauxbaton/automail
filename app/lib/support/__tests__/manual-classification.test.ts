import { describe, expect, test } from "vitest";
import { validateIntentEdit, findCandidateById } from "../manual-classification";
import type { OrderFacts } from "../types";

describe("validateIntentEdit", () => {
  test("rejects empty array", () => {
    expect(() => validateIntentEdit([])).toThrow(/at least one intent/i);
  });

  test("rejects unknown intent values", () => {
    expect(() => validateIntentEdit(["bogus" as never])).toThrow(/unknown intent/i);
  });

  test("dedups while preserving order", () => {
    const result = validateIntentEdit([
      "where_is_my_order",
      "delivery_delay",
      "where_is_my_order",
    ]);
    expect(result).toEqual(["where_is_my_order", "delivery_delay"]);
  });

  test("accepts a single valid intent", () => {
    expect(validateIntentEdit(["refund_request"])).toEqual(["refund_request"]);
  });
});

const fakeOrder = (id: string, name: string): OrderFacts => ({
  id,
  name,
  createdAt: "2026-04-01T00:00:00Z",
  customerName: "Jane",
  customerEmail: "jane@example.com",
  lineItems: [],
  fulfillments: [],
});

describe("findCandidateById", () => {
  test("returns the matching candidate", () => {
    const candidates = [fakeOrder("gid://Order/1", "#1001"), fakeOrder("gid://Order/2", "#1002")];
    expect(findCandidateById(candidates, "gid://Order/2")?.name).toBe("#1002");
  });

  test("returns null when not found", () => {
    expect(findCandidateById([], "gid://Order/3")).toBeNull();
  });
});

import { searchOrderByExactNumber } from "../manual-classification";
import type { AdminGraphqlClient } from "../shopify/order-search";

function fakeAdmin(orders: Array<{ id: string; name: string }>): AdminGraphqlClient {
  return {
    graphql: async () => ({
      json: async () => ({
        data: {
          orders: {
            edges: orders.map((o) => ({
              node: {
                id: o.id,
                name: o.name,
                createdAt: "2026-04-01T00:00:00Z",
                displayFulfillmentStatus: "UNFULFILLED",
                displayFinancialStatus: "PAID",
                customer: { displayName: "Jane", email: "jane@example.com" },
                lineItems: { edges: [] },
                fulfillments: [],
              },
            })),
          },
        },
      }),
    }),
  } as unknown as AdminGraphqlClient;
}

describe("searchOrderByExactNumber", () => {
  test("returns the single match as OrderFacts", async () => {
    const admin = fakeAdmin([{ id: "gid://Order/1", name: "#1001" }]);
    const result = await searchOrderByExactNumber(admin, "1001");
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.order.name).toBe("#1001");
  });

  test("returns 'not_found' on zero matches", async () => {
    const admin = fakeAdmin([]);
    const result = await searchOrderByExactNumber(admin, "9999");
    expect(result.kind).toBe("not_found");
  });

  test("returns 'ambiguous' on multiple matches", async () => {
    const admin = fakeAdmin([
      { id: "gid://Order/1", name: "#1001" },
      { id: "gid://Order/2", name: "#1001" },
    ]);
    const result = await searchOrderByExactNumber(admin, "1001");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates).toHaveLength(2);
  });

  test("strips leading # from input", async () => {
    const admin = fakeAdmin([{ id: "gid://Order/1", name: "#1001" }]);
    const result = await searchOrderByExactNumber(admin, "#1001");
    expect(result.kind).toBe("found");
  });

  test("rejects empty input", async () => {
    const admin = fakeAdmin([]);
    await expect(searchOrderByExactNumber(admin, "")).rejects.toThrow(/empty/i);
  });
});
