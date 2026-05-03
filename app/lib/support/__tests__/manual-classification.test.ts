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

import { applyClassificationEditToAnalysis } from "../manual-classification";
import type { SupportAnalysis } from "../types";

const baseAnalysis = (overrides: Partial<SupportAnalysis> = {}): SupportAnalysis => ({
  intent: "where_is_my_order",
  intents: ["where_is_my_order"],
  identifiers: {},
  order: null,
  orderCandidates: [],
  trackings: [],
  confidence: "low",
  warnings: [],
  draftReply: "",
  conversation: {
    messageCount: 1,
    incomingCount: 1,
    outgoingCount: 0,
    lastMessageDirection: "incoming",
    noReplyNeeded: false,
  },
  ...overrides,
});

describe("applyClassificationEditToAnalysis", () => {
  test("setting intents updates intent + intents and adds override marker", () => {
    const a = baseAnalysis();
    const out = applyClassificationEditToAnalysis(a, {
      intents: ["refund_request", "damaged_product"],
      now: new Date("2026-05-03T10:00:00Z"),
    });
    expect(out.intent).toBe("refund_request");
    expect(out.intents).toEqual(["refund_request", "damaged_product"]);
    expect(out.manualOverrides?.intents?.editedAt).toBe("2026-05-03T10:00:00.000Z");
  });

  test("resetting intents clears value AND override", () => {
    const a = baseAnalysis({
      intent: "refund_request",
      intents: ["refund_request"],
      manualOverrides: { intents: { editedAt: "2026-05-02T00:00:00.000Z" } },
    });
    const out = applyClassificationEditToAnalysis(a, { resetIntents: true, now: new Date() });
    expect(out.intent).toBe("unknown");
    expect(out.intents).toEqual([]);
    expect(out.manualOverrides?.intents).toBeUndefined();
  });

  test("setting order to a new value adds override marker", () => {
    const a = baseAnalysis();
    const newOrder: SupportAnalysis["order"] = {
      id: "gid://Order/1",
      name: "#1001",
      createdAt: "2026-04-01T00:00:00Z",
      customerName: "Jane",
      customerEmail: "jane@example.com",
      lineItems: [],
      fulfillments: [],
    };
    const out = applyClassificationEditToAnalysis(a, {
      order: newOrder,
      now: new Date("2026-05-03T10:00:00Z"),
    });
    expect(out.order).toEqual(newOrder);
    expect(out.manualOverrides?.order?.editedAt).toBe("2026-05-03T10:00:00.000Z");
  });

  test("detaching order sets it to null and adds override marker", () => {
    const a = baseAnalysis({
      order: {
        id: "gid://Order/1",
        name: "#1001",
        createdAt: "2026-04-01T00:00:00Z",
        customerName: "Jane",
        customerEmail: null,
        lineItems: [],
        fulfillments: [],
      },
    });
    const out = applyClassificationEditToAnalysis(a, { detachOrder: true, now: new Date() });
    expect(out.order).toBeNull();
    expect(out.manualOverrides?.order?.editedAt).toBeDefined();
  });

  test("resetting order clears value AND override", () => {
    const a = baseAnalysis({
      manualOverrides: { order: { editedAt: "2026-05-02T00:00:00.000Z" } },
    });
    const out = applyClassificationEditToAnalysis(a, { resetOrder: true, now: new Date() });
    expect(out.order).toBeNull();
    expect(out.manualOverrides?.order).toBeUndefined();
  });

  test("preserves unrelated fields (tracking, draft, candidates)", () => {
    const a = baseAnalysis({
      draftReply: "Hello",
      orderCandidates: [
        {
          id: "gid://Order/9",
          name: "#9",
          createdAt: "2026-04-01T00:00:00Z",
          customerName: null,
          customerEmail: null,
          lineItems: [],
          fulfillments: [],
        },
      ],
    });
    const out = applyClassificationEditToAnalysis(a, {
      intents: ["damaged_product"],
      now: new Date(),
    });
    expect(out.draftReply).toBe("Hello");
    expect(out.orderCandidates).toHaveLength(1);
  });
});
