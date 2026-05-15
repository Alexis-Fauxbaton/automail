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

  it("renders a TRACKING section with carrier, status, last event and ETA", () => {
    const a = baseAnalysis();
    a.trackings = [
      {
        fulfillmentIndex: 0,
        lineItems: [],
        source: "seventeen_track",
        carrier: "La Poste",
        trackingNumber: "LP123456789FR",
        trackingUrl: "https://laposte.fr/x",
        status: "in_transit",
        inferred: false,
        lastEvent: "Out for delivery",
        lastLocation: "Paris",
        lastEventDate: "2026-05-13T08:00:00Z",
        agentStatus: {
          lastEvent: "Out for delivery",
          lastLocation: "Paris",
          estimatedDelivery: "2026-05-14",
          delivered: false,
        },
        last17trackAttempt: "ok",
        last17trackAttemptAt: "2026-05-13T08:01:00Z",
      },
    ];
    const out = buildRefineContext(a) ?? "";
    expect(out).toContain("=== TRACKING ===");
    expect(out).toContain("LP123456789FR (La Poste)");
    expect(out).toContain("Status: in_transit");
    expect(out).toContain("Last event: 2026-05-13 — Out for delivery (Paris)");
    expect(out).toContain("ETA: 2026-05-14");
  });

  it("emits one TRACKING block per fulfillment, separated by blank lines", () => {
    const a = baseAnalysis();
    a.trackings = [
      {
        fulfillmentIndex: 0, lineItems: [],
        source: "shopify_url", trackingNumber: "AAA", carrier: null,
        trackingUrl: null, status: null, inferred: false,
      },
      {
        fulfillmentIndex: 1, lineItems: [],
        source: "shopify_url", trackingNumber: "BBB", carrier: null,
        trackingUrl: null, status: null, inferred: false,
      },
    ];
    const out = buildRefineContext(a) ?? "";
    expect(out.match(/=== TRACKING ===/g)).toHaveLength(2);
    expect(out).toContain("AAA");
    expect(out).toContain("BBB");
  });

  it("omits TRACKING section entirely when no useful tracking number", () => {
    const a = baseAnalysis();
    a.trackings = [
      {
        fulfillmentIndex: 0, lineItems: [],
        source: "none", trackingNumber: null, carrier: null,
        trackingUrl: null, status: null, inferred: false,
      },
    ];
    expect(buildRefineContext(a)).toBeNull();
  });

  it("renders WARNINGS only for codes that affect what to say to the customer", () => {
    const a = baseAnalysis();
    a.order = {
      id: "gid://1", name: "#1", createdAt: "2026-01-01T00:00:00Z",
      displayFinancialStatus: null, displayFulfillmentStatus: null,
      customerName: null, customerEmail: null, lineItems: [], fulfillments: [],
    };
    a.warnings = [
      { code: "ambiguous_match", message: "2 orders match" },
      { code: "no_order_match", message: "No order found" },
      { code: "inferred_carrier", message: "Carrier guessed" },
      { code: "llm_fallback", message: "LLM unavailable" },        // filtered
      { code: "crawl_partial_failure", message: "Carrier site slow" }, // filtered
    ];
    const out = buildRefineContext(a) ?? "";
    expect(out).toContain("=== WARNINGS ===");
    expect(out).toContain("ambiguous_match");
    expect(out).toContain("no_order_match");
    expect(out).toContain("inferred_carrier");
    expect(out).not.toContain("llm_fallback");
    expect(out).not.toContain("crawl_partial_failure");
  });

  it("omits WARNINGS section when none pass the allowlist", () => {
    const a = baseAnalysis();
    a.order = {
      id: "gid://1", name: "#1", createdAt: "2026-01-01T00:00:00Z",
      displayFinancialStatus: null, displayFulfillmentStatus: null,
      customerName: null, customerEmail: null, lineItems: [], fulfillments: [],
    };
    a.warnings = [{ code: "llm_fallback", message: "x" }];
    const out = buildRefineContext(a) ?? "";
    expect(out).not.toContain("=== WARNINGS ===");
  });
});
