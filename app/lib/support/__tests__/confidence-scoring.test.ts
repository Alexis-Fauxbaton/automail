import { describe, it, expect } from "vitest";
import { scoreConfidence } from "../confidence-scoring";
import type { ScoringInput } from "../confidence-scoring";
import type { OrderFacts, FulfillmentTrackingFacts } from "../types";

const baseOrder: OrderFacts = {
  id: "gid://shopify/Order/1",
  name: "#1234",
  createdAt: "2024-01-01T00:00:00Z",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "FULFILLED",
  customerName: "Jean Dupont",
  customerEmail: "jean@example.com",
  lineItems: [],
  fulfillments: [
    {
      status: "SUCCESS",
      trackingNumbers: ["6123456789012"],
      trackingUrls: ["https://suivi.laposte.fr/6123456789012"],
      carrier: "La Poste",
      lineItems: [],
    },
  ],
};

const verifiedTracking: FulfillmentTrackingFacts = {
  fulfillmentIndex: 0,
  lineItems: [],
  source: "shopify_url",
  carrier: "La Poste",
  trackingNumber: "6123456789012",
  trackingUrl: "https://suivi.laposte.fr/6123456789012",
  inferred: false,
};

const inferredTracking: FulfillmentTrackingFacts = {
  ...verifiedTracking,
  source: "pattern_guess",
  inferred: true,
};

function makeInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    identifiers: { orderNumber: "1234" },
    matchedBy: "orderNumber",
    order: baseOrder,
    candidatesCount: 1,
    trackings: [verifiedTracking],
    ...overrides,
  };
}

describe("scoreConfidence", () => {
  // --- No order scenarios ---
  it("returns low + no_identifiers when no identifiers and no order", () => {
    const result = scoreConfidence(
      makeInput({ identifiers: {}, matchedBy: null, order: null, trackings: [] }),
    );
    expect(result.confidence).toBe("low");
    expect(result.warnings.map((w) => w.code)).toContain("no_identifiers");
  });

  it("returns low + no_order_match when identifiers present but no order found", () => {
    const result = scoreConfidence(
      makeInput({ order: null, trackings: [] }),
    );
    expect(result.confidence).toBe("low");
    expect(result.warnings.map((w) => w.code)).toContain("no_order_match");
  });

  // --- High confidence ---
  it("returns high when matched by order number, single match, verified tracking", () => {
    const result = scoreConfidence(makeInput());
    expect(result.confidence).toBe("high");
    expect(result.warnings).toHaveLength(0);
  });

  it("returns high when matched by email, single match, verified tracking", () => {
    const result = scoreConfidence(makeInput({ matchedBy: "email" }));
    expect(result.confidence).toBe("high");
  });

  // --- Medium confidence ---
  it("returns medium when matched by order number, no tracking", () => {
    const result = scoreConfidence(makeInput({ trackings: [] }));
    expect(result.confidence).toBe("medium");
  });

  it("returns medium when matched by email, no tracking", () => {
    const result = scoreConfidence(makeInput({ matchedBy: "email", trackings: [] }));
    expect(result.confidence).toBe("medium");
  });

  it("returns medium when matched by customer name, single match", () => {
    const result = scoreConfidence(makeInput({ matchedBy: "customerName", trackings: [] }));
    expect(result.confidence).toBe("medium");
  });

  it("returns medium when tracking is inferred (not verified)", () => {
    const result = scoreConfidence(makeInput({ trackings: [inferredTracking] }));
    expect(result.confidence).toBe("medium");
    expect(result.warnings.map((w) => w.code)).toContain("inferred_carrier");
  });

  // --- Low confidence ---
  it("returns low when multiple candidates (ambiguous)", () => {
    const result = scoreConfidence(makeInput({ candidatesCount: 3 }));
    expect(result.confidence).toBe("low");
    expect(result.warnings.map((w) => w.code)).toContain("ambiguous_match");
  });

  // --- Warnings ---
  it("adds ambiguous_match warning when candidatesCount > 1", () => {
    const result = scoreConfidence(makeInput({ candidatesCount: 2 }));
    expect(result.warnings.some((w) => w.code === "ambiguous_match")).toBe(true);
    expect(result.warnings.find((w) => w.code === "ambiguous_match")?.message).toContain("2");
  });

  it("adds inferred_carrier warning for inferred tracking", () => {
    const result = scoreConfidence(makeInput({ trackings: [inferredTracking] }));
    const warning = result.warnings.find((w) => w.code === "inferred_carrier");
    expect(warning).toBeDefined();
  });

  it("adds inferred_carrier warning mentioning count when multiple inferred", () => {
    const result = scoreConfidence(
      makeInput({ trackings: [inferredTracking, inferredTracking] }),
    );
    const warning = result.warnings.find((w) => w.code === "inferred_carrier");
    expect(warning?.message).toContain("2");
  });

  it("adds no_fulfillment warning when order has no fulfillments", () => {
    const orderWithNoFulfillment = { ...baseOrder, fulfillments: [] };
    const result = scoreConfidence(
      makeInput({ order: orderWithNoFulfillment, trackings: [] }),
    );
    expect(result.warnings.map((w) => w.code)).toContain("no_fulfillment");
  });

  it("produces no warnings for perfect match", () => {
    const result = scoreConfidence(makeInput());
    expect(result.warnings).toHaveLength(0);
  });
});
