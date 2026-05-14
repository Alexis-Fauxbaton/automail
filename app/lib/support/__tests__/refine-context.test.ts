import { describe, it, expect } from "vitest";
import type { SupportAnalysis } from "../types";
import { buildRefineContext } from "../refine-context";

function baseAnalysis(): SupportAnalysis {
  return {
    intent: "unknown",
    intents: ["unknown"],
    identifiers: {},
    order: null,
    orderCandidates: [],
    trackings: [],
    warnings: [],
    confidence: "low",
    draftReply: "",
    conversation: {
      messageCount: 0,
      incomingCount: 0,
      outgoingCount: 0,
      lastMessageDirection: "incoming",
      noReplyNeeded: false,
    },
  };
}

describe("buildRefineContext", () => {
  it("returns null when nothing useful to summarise", () => {
    expect(buildRefineContext(baseAnalysis())).toBeNull();
  });

  it("renders an ORDER section when analysis.order is present", () => {
    const a = baseAnalysis();
    a.order = {
      id: "gid://shopify/Order/1",
      name: "#1234",
      createdAt: "2026-03-14T10:00:00Z",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "FULFILLED",
      customerName: "John Doe",
      customerEmail: "john@example.com",
      lineItems: [
        { title: "Blue T-Shirt L", quantity: 2 },
        { title: "Sneakers 42", quantity: 1 },
      ],
      fulfillments: [],
    };
    const out = buildRefineContext(a);
    expect(out).not.toBeNull();
    expect(out).toContain("=== ORDER ===");
    expect(out).toContain("Order: #1234");
    expect(out).toContain("2× Blue T-Shirt L");
    expect(out).toContain("1× Sneakers 42");
    expect(out).toContain("Status: FULFILLED (PAID)");
    expect(out).toContain("Customer: John Doe <john@example.com>");
  });

  it("caps line items at 5 with a trailing summary line", () => {
    const a = baseAnalysis();
    a.order = {
      id: "gid://1", name: "#1", createdAt: "2026-01-01T00:00:00Z",
      displayFinancialStatus: null, displayFulfillmentStatus: null,
      customerName: null, customerEmail: null,
      lineItems: Array.from({ length: 8 }, (_, i) => ({
        title: `Item ${i + 1}`,
        quantity: 1,
      })),
      fulfillments: [],
    };
    const out = buildRefineContext(a) ?? "";
    expect(out).toContain("Item 1");
    expect(out).toContain("Item 5");
    expect(out).not.toContain("Item 6");
    expect(out).toContain("+ 3 more");
  });
});
