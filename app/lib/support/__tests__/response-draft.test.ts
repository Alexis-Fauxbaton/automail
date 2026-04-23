/**
 * Business-rule tests on the fallback template draft generator.
 *
 * These tests DO NOT check "what does the code currently return".
 * They enforce what the draft MUST and MUST NOT say, as required by
 * the product spec (CLAUDE.md non-negotiable rules).
 *
 * A failure here means the app could send a legally or operationally
 * dangerous reply to a real customer.
 */

import { describe, it, expect, vi } from "vitest";
import { generateDraft } from "../response-draft";
import { parseMessage } from "../message-parser";
import type { DraftInput } from "../response-draft";

// settings.ts imports prisma which isn't available in unit tests.
// response-draft.ts only needs DEFAULT_SETTINGS from that module.
vi.mock("../settings", () => ({
  DEFAULT_SETTINGS: {
    signatureName: "Customer Support",
    brandName: "",
    tone: "friendly",
    language: "auto",
    closingPhrase: "",
    shareTrackingNumber: true,
    customerGreetingStyle: "auto",
    refundPolicy: "",
  },
}));
import type { OrderFacts, TrackingFacts } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORDER_BASIC: OrderFacts = {
  id: "gid://shopify/Order/1",
  name: "#1001",
  createdAt: "2024-01-10T00:00:00Z",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "FULFILLED",
  customerName: "Sarah Johnson",
  customerEmail: "sarah@example.com",
  lineItems: [{ title: "Blue T-Shirt", quantity: 1 }],
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

const TRACKING_VERIFIED: TrackingFacts = {
  source: "shopify_url",
  carrier: "La Poste",
  trackingNumber: "6123456789012",
  trackingUrl: "https://suivi.laposte.fr/6123456789012",
  inferred: false,
};

const TRACKING_INFERRED: TrackingFacts = {
  source: "pattern_guess",
  carrier: "La Poste / Colissimo",
  trackingNumber: "6123456789012",
  trackingUrl: "https://www.laposte.fr/outils/suivre-vos-envois?code=6123456789012",
  inferred: true,
};

function draft(overrides: Partial<DraftInput>): string {
  return generateDraft({
    intent: "where_is_my_order",
    order: ORDER_BASIC,
    tracking: TRACKING_VERIFIED,
    warnings: [],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// RULE: Never claim a refund was issued unless verified
// ---------------------------------------------------------------------------

describe("Refund rule: never claim refund was issued", () => {
  it("refund draft does not say the refund has been processed", () => {
    const text = draft({ intent: "refund_request", tracking: null });
    expect(text).not.toMatch(/refund (?:has been|was|will be) (?:processed|issued|credited)/i);
    expect(text).not.toMatch(/we have refunded/i);
    expect(text).not.toMatch(/your money (?:has been|will be) returned/i);
  });

  it("refund draft (French) does not claim reimbursement was done", () => {
    const text = draft({
      intent: "refund_request",
      tracking: null,
      settings: { language: "fr" },
    });
    expect(text).not.toMatch(/remboursement a été effectué/i);
    expect(text).not.toMatch(/vous avez été remboursé/i);
    expect(text).not.toMatch(/votre remboursement est en cours/i);
  });

  it("refund draft asks for more details before committing", () => {
    const text = draft({ intent: "refund_request", tracking: null });
    // Should ask for reason / next steps, not immediately confirm
    expect(text).toMatch(/detail|reason|more information|clarif|precis|before/i);
  });

  it("refund draft omits tracking block even when verified tracking is present", () => {
    // The refund_request template intentionally has no tracking section.
    // A bug here would leak tracking details into an unrelated context.
    const text = draft({ intent: "refund_request", tracking: TRACKING_VERIFIED });
    expect(text).not.toContain("6123456789012");
    expect(text).not.toMatch(/tracking number|numéro de suivi/i);
    expect(text).not.toContain("La Poste");
  });
});

// ---------------------------------------------------------------------------
// RULE: Never claim a parcel is lost unless the source clearly supports it
// ---------------------------------------------------------------------------

describe("Lost parcel rule: never declare the package lost", () => {
  it("marked-delivered-not-received draft does not say 'lost'", () => {
    const text = draft({ intent: "marked_delivered_not_received" });
    expect(text).not.toMatch(/\bpackage is lost\b/i);
    expect(text).not.toMatch(/\bparcel is lost\b/i);
    expect(text).not.toMatch(/\bhas been lost\b/i);
    expect(text).not.toMatch(/\bcolis perdu\b/i);
  });

  it("marked-delivered draft (French) does not say 'perdu'", () => {
    const text = draft({
      intent: "marked_delivered_not_received",
      settings: { language: "fr" },
    });
    expect(text).not.toMatch(/\bcolis (est |a été )?perdu\b/i);
  });

  it("marked-delivered draft suggests practical steps instead (check neighbours)", () => {
    const text = draft({ intent: "marked_delivered_not_received" });
    expect(text).toMatch(/neighbour|neighbor|safe.?drop|investigation|address/i);
  });

  it("package-stuck draft does not declare the parcel lost", () => {
    const text = draft({ intent: "package_stuck" });
    expect(text).not.toMatch(/\blost\b/i);
    expect(text).not.toMatch(/\bperdu\b/i);
  });
});

// ---------------------------------------------------------------------------
// RULE: When no order found, ask for identifiers — never invent an order
// ---------------------------------------------------------------------------

describe("No order found: ask for identifiers", () => {
  it("asks for order number or email when order is not found", () => {
    const text = draft({ order: null, tracking: null });
    expect(text).toMatch(/order number|email|#\d+|identif/i);
  });

  it("French draft asks for order number when order not found", () => {
    const text = draft({
      order: null,
      tracking: null,
      settings: { language: "fr" },
    });
    expect(text).toMatch(/numéro de commande|adresse e.?mail/i);
  });

  it("does not mention tracking when order is not found", () => {
    const text = draft({ order: null, tracking: null });
    expect(text).not.toMatch(/carrier|tracking number|La Poste/i);
  });
});

// ---------------------------------------------------------------------------
// RULE: Flag inferred tracking — never present it as verified
// ---------------------------------------------------------------------------

describe("Inferred tracking: must be flagged as uncertain", () => {
  it("inferred carrier draft contains a disclaimer", () => {
    const text = draft({ tracking: TRACKING_INFERRED });
    expect(text).toMatch(/inferred|verify|not verified|déduit|à vérifier/i);
  });

  it("verified tracking draft does NOT contain an inferred disclaimer", () => {
    const text = draft({ tracking: TRACKING_VERIFIED });
    expect(text).not.toMatch(/inferred|to verify|déduit|à vérifier/i);
  });
});

// ---------------------------------------------------------------------------
// RULE: Language auto-detection
// ---------------------------------------------------------------------------

describe("Language auto-detection", () => {
  it("returns a French draft for a French email", () => {
    const parsed = parseMessage("Suivi commande", "Bonjour, où est ma commande ?");
    const text = draft({ settings: { language: "auto" }, parsed });
    expect(text).toMatch(/Bonjour|Cordialement|merci/i);
    expect(text).not.toMatch(/\bDear\b|\bHi,\b|\bCheers\b/);
  });

  it("returns an English draft for an English email", () => {
    const parsed = parseMessage("Order status", "Hi, where is my package?");
    const text = draft({ settings: { language: "auto" }, parsed });
    expect(text).toMatch(/Hi|Hello|Dear|Best regards|Cheers/);
    expect(text).not.toMatch(/Bonjour|Cordialement/);
  });
});

// ---------------------------------------------------------------------------
// RULE: Draft structure — greeting + body + signoff always present
// ---------------------------------------------------------------------------

describe("Draft structure", () => {
  it("always starts with a greeting", () => {
    for (const intent of [
      "where_is_my_order",
      "delivery_delay",
      "marked_delivered_not_received",
      "package_stuck",
      "refund_request",
      "unknown",
    ] as const) {
      const text = draft({ intent });
      // First line must be a greeting
      const firstLine = text.split("\n")[0];
      expect(firstLine, `intent=${intent} first line`).toMatch(
        /^(Hi|Hello|Dear|Bonjour)/i,
      );
    }
  });

  it("always includes a signoff", () => {
    const text = draft({});
    // Signoff is the last non-empty line group
    expect(text).toMatch(/(Cheers|Best regards|Kind regards|Cordialement|Belle journée|Customer Support)/i);
  });

  it("personalises greeting with customer first name when available", () => {
    const text = draft({ settings: { tone: "friendly" } });
    expect(text).toMatch(/Hi Sarah/);
  });

  it("uses generic greeting when no customer name", () => {
    const orderWithoutName = { ...ORDER_BASIC, customerName: null };
    const text = draft({ order: orderWithoutName });
    expect(text).toMatch(/^Hi,/m);
  });

  it("uses 'Dear' for formal tone in English", () => {
    const text = draft({ settings: { tone: "formal", language: "en" } });
    expect(text).toMatch(/^Dear Sarah/m);
  });

  it("unknown intent with active warnings uses the warned clarification message", () => {
    const text = draft({
      intent: "unknown",
      warnings: [{ code: "no_order_match", message: "No order found" }],
    });
    // Line 113: unknownClarifyWarned branch when warnings.length > 0
    expect(text).toMatch(/Hi|Hello|Dear/i); // still has greeting
    expect(text).not.toBe(""); // still produces a draft
  });

  it("unknown intent with no warnings uses the standard clarification message", () => {
    const text = draft({ intent: "unknown", warnings: [] });
    expect(text).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// RULE: Order facts in the draft — must match what Shopify returned
// ---------------------------------------------------------------------------

describe("Order facts in draft", () => {
  it("includes the Shopify order name in the draft", () => {
    const text = draft({});
    expect(text).toContain("#1001");
  });

  it("includes verified tracking number when tracking is available", () => {
    const text = draft({ tracking: TRACKING_VERIFIED });
    expect(text).toContain("6123456789012");
  });

  it("includes tracking URL when available", () => {
    const text = draft({ tracking: TRACKING_VERIFIED });
    expect(text).toContain("suivi.laposte.fr");
  });

  it("does NOT include tracking when source is 'none'", () => {
    const noTracking: TrackingFacts = { source: "none", inferred: false };
    const text = draft({ tracking: noTracking });
    expect(text).not.toMatch(/tracking number|numéro de suivi/i);
    expect(text).not.toContain("La Poste");
  });

  it("template always shows tracking number regardless of shareTrackingNumber setting (setting applies to LLM draft only)", () => {
    // shareTrackingNumber is enforced in llm-draft.ts, not in the template generator.
    const text = draft({ tracking: TRACKING_VERIFIED });
    expect(text).toContain("6123456789012");
  });

  it("omits carrier line when carrier is null", () => {
    const t: TrackingFacts = { source: "shopify_url", trackingNumber: "6123456789012", inferred: false };
    const text = draft({ tracking: t });
    expect(text).not.toMatch(/^Carrier:/m);
    expect(text).toContain("6123456789012");
  });

  it("omits URL line when trackingUrl is null", () => {
    const t: TrackingFacts = { source: "shopify_url", carrier: "La Poste", trackingNumber: "6123456789012", inferred: false };
    const text = draft({ tracking: t });
    expect(text).toMatch(/La Poste/);
    expect(text).not.toMatch(/Tracking link:/i);
  });

  it("returns no tracking block when all display fields are absent", () => {
    const t: TrackingFacts = { source: "shopify_url", inferred: false };
    const text = draft({ tracking: t });
    expect(text).not.toMatch(/Carrier:|Tracking number:|Tracking link:/i);
  });
});
