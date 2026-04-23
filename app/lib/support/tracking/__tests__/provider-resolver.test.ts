import { describe, it, expect } from "vitest";
import { resolveTrackingForFulfillment, resolveTracking } from "../provider-resolver";
import type { OrderFulfillmentFacts } from "../../types";

function makeFulfillment(
  overrides: Partial<OrderFulfillmentFacts> = {},
): OrderFulfillmentFacts {
  return {
    status: "SUCCESS",
    trackingNumbers: [],
    trackingUrls: [],
    carrier: null,
    lineItems: [],
    ...overrides,
  };
}

describe("resolveTrackingForFulfillment", () => {
  it("returns shopify_url when Shopify tracking URL is present", () => {
    const result = resolveTrackingForFulfillment(
      makeFulfillment({
        trackingNumbers: ["6123456789012"],
        trackingUrls: ["https://suivi.laposte.fr/6123456789012"],
        carrier: "La Poste",
      }),
    );
    expect(result.source).toBe("shopify_url");
    expect(result.inferred).toBe(false);
    expect(result.trackingUrl).toBe("https://suivi.laposte.fr/6123456789012");
    expect(result.carrier).toBe("La Poste");
  });

  it("returns shopify_carrier when carrier + tracking present but no URL", () => {
    const result = resolveTrackingForFulfillment(
      makeFulfillment({
        trackingNumbers: ["6123456789012"],
        carrier: "La Poste",
      }),
    );
    expect(result.source).toBe("shopify_carrier");
    expect(result.inferred).toBe(false);
    expect(result.trackingUrl).toBeNull();
  });

  it("infers UPS from tracking number pattern", () => {
    const result = resolveTrackingForFulfillment(
      makeFulfillment({ trackingNumbers: ["1Z999AA10123456784"] }),
    );
    expect(result.source).toBe("pattern_guess");
    expect(result.inferred).toBe(true);
    expect(result.carrier).toBe("UPS");
    expect(result.trackingUrl).toContain("ups.com");
  });

  it("infers La Poste / Colissimo from 13-digit tracking", () => {
    const result = resolveTrackingForFulfillment(
      makeFulfillment({ trackingNumbers: ["6123456789012"] }),
    );
    expect(result.source).toBe("pattern_guess");
    expect(result.inferred).toBe(true);
    expect(result.carrier).toBe("La Poste / Colissimo");
    expect(result.trackingUrl).toContain("laposte.fr");
  });

  it("infers La Poste (international) from 2-letter + 9-digit + 2-letter pattern", () => {
    const result = resolveTrackingForFulfillment(
      makeFulfillment({ trackingNumbers: ["AB123456789FR"] }),
    );
    expect(result.source).toBe("pattern_guess");
    expect(result.inferred).toBe(true);
    expect(result.carrier).toBe("La Poste (international)");
  });

  it("returns pattern_guess with null carrier when pattern is unknown", () => {
    const result = resolveTrackingForFulfillment(
      makeFulfillment({ trackingNumbers: ["UNKNOWNCARRIER123"] }),
    );
    expect(result.source).toBe("pattern_guess");
    expect(result.inferred).toBe(true);
    expect(result.carrier).toBeNull();
  });

  it("returns none when no tracking info available", () => {
    const result = resolveTrackingForFulfillment(makeFulfillment());
    expect(result.source).toBe("none");
    expect(result.inferred).toBe(false);
  });

  it("prefers Shopify URL over carrier pattern", () => {
    // Has both a URL and a matching pattern — URL wins
    const result = resolveTrackingForFulfillment(
      makeFulfillment({
        trackingNumbers: ["6123456789012"],
        trackingUrls: ["https://suivi.laposte.fr/6123456789012"],
      }),
    );
    expect(result.source).toBe("shopify_url");
  });

  it("propagates fulfillment status to tracking facts", () => {
    const result = resolveTrackingForFulfillment(
      makeFulfillment({
        status: "IN_TRANSIT",
        trackingNumbers: ["6123456789012"],
        trackingUrls: ["https://suivi.laposte.fr/6123456789012"],
      }),
    );
    expect(result.status).toBe("IN_TRANSIT");
  });
});

describe("resolveTracking (deprecated wrapper)", () => {
  it("returns null when order is null", () => {
    expect(resolveTracking(null)).toBeNull();
  });

  it("returns null when order has no fulfillments", () => {
    expect(
      resolveTracking({
        id: "gid://shopify/Order/1",
        name: "#1234",
        createdAt: "2024-01-01T00:00:00Z",
        lineItems: [],
        fulfillments: [],
      }),
    ).toBeNull();
  });

  it("resolves first fulfillment of the order", () => {
    const result = resolveTracking({
      id: "gid://shopify/Order/1",
      name: "#1234",
      createdAt: "2024-01-01T00:00:00Z",
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
    });
    expect(result?.source).toBe("shopify_url");
  });
});
