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
