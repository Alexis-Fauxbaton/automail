/**
 * Spec-first tests: given a real customer email, does the app extract
 * the right intent and identifiers?
 *
 * These tests use NO mocks. They run the real parsing + extraction +
 * classification pipeline on synthetic but realistic customer emails.
 *
 * A failure here means a real customer would get a wrong or incomplete
 * analysis — the most direct test of correctness.
 */

import { describe, it, expect } from "vitest";
import { parseMessage } from "../message-parser";
import { classifyIntent } from "../intent-classifier";
import { extractIdentifiers } from "../identifier-extractor";
import { EMAIL_SCENARIOS } from "./fixtures/email-scenarios";

describe("Email scenarios — intent classification", () => {
  for (const scenario of EMAIL_SCENARIOS) {
    it(`[${scenario.id}] ${scenario.description}`, () => {
      const parsed = parseMessage(scenario.subject, scenario.body);
      const intent = classifyIntent(parsed);
      expect(intent).toBe(scenario.expectedIntent);
    });
  }
});

describe("Email scenarios — identifier extraction", () => {
  for (const scenario of EMAIL_SCENARIOS) {
    it(`[${scenario.id}] ${scenario.description}`, () => {
      const parsed = parseMessage(scenario.subject, scenario.body);
      const identifiers = extractIdentifiers(parsed);

      // Every field in mustExtract must be present and match
      for (const [key, expectedValue] of Object.entries(scenario.mustExtract)) {
        expect(
          identifiers[key as keyof typeof identifiers],
          `${key} should be extracted`,
        ).toBe(expectedValue);
      }

      // Fields in mustNotExtract must be absent
      for (const key of scenario.mustNotExtract ?? []) {
        expect(
          identifiers[key],
          `${key} should NOT be extracted from this email`,
        ).toBeUndefined();
      }
    });
  }
});

// --- Individual edge-case tests beyond the scenario matrix ---

describe("Identifier extraction — edge cases", () => {
  it("extracts order number written as 'n°1234'", () => {
    const parsed = parseMessage("", "n°1234 commande non reçue");
    expect(extractIdentifiers(parsed).orderNumber).toBe("1234");
  });

  it("extracts order number written as 'numéro 1234'", () => {
    const parsed = parseMessage("", "Bonjour, mon numéro de commande est 1234");
    expect(extractIdentifiers(parsed).orderNumber).toBe("1234");
  });

  it("extracts order number even when written in the subject only", () => {
    const parsed = parseMessage("RE: Order #9999 – delayed", "");
    expect(extractIdentifiers(parsed).orderNumber).toBe("9999");
  });

  it("does not extract a random 4-digit number as an order number", () => {
    // Without a keyword or # prefix, a bare number should NOT be extracted
    const parsed = parseMessage("", "I waited 2023 days and still nothing");
    // "2023" could collide — make sure it's not extracted without context
    const ids = extractIdentifiers(parsed);
    // The number 2023 alone without a keyword should not become an order number
    // (ORDER_WITH_KEYWORD requires a keyword prefix, ORDER_WITH_HASH requires #)
    expect(ids.orderNumber).toBeUndefined();
  });

  it("extracts UPS tracking from body without keyword when no order number present", () => {
    const parsed = parseMessage("", "1Z999AA10123456784 has not moved in days");
    expect(extractIdentifiers(parsed).trackingNumber).toBe("1Z999AA10123456784");
  });

  it("does not extract short sequences as tracking numbers", () => {
    // Tracking keyword regex requires 8-30 chars; carrier patterns are tightly constrained
    const parsed = parseMessage("", "My order is ABC123");
    // "ABC123" is only 6 chars, below the 8-char minimum for keyword match
    expect(extractIdentifiers(parsed).trackingNumber).toBeUndefined();
  });
});

describe("Intent classification — edge cases", () => {
  it("classifies a message with only 'suivi' as where_is_my_order", () => {
    const parsed = parseMessage("Suivi commande", "Bonjour, pouvez-vous me donner le suivi ?");
    expect(classifyIntent(parsed)).toBe("where_is_my_order");
  });

  it("classifies 'jamais reçu' as marked_delivered_not_received, not delivery_delay", () => {
    // 'jamais reçu' is more specific than 'retard'
    const parsed = parseMessage("", "Je n'ai jamais reçu mon colis mais il est marqué livré. Il est aussi en retard.");
    // marked_delivered_not_received is checked first and wins
    expect(classifyIntent(parsed)).toBe("marked_delivered_not_received");
  });

  it("classifies as refund_request when customer explicitly asks for refund, even if also delayed", () => {
    const parsed = parseMessage("", "Colis en retard depuis 3 semaines, je demande un remboursement.");
    // refund_request is checked before delivery_delay in the rule list.
    // When a customer explicitly requests a refund, that intent wins.
    expect(classifyIntent(parsed)).toBe("refund_request");
  });

  it("classifies empty email as unknown", () => {
    const parsed = parseMessage("", "");
    expect(classifyIntent(parsed)).toBe("unknown");
  });

  it("classifies a closing thank-you email as unknown (not a support request)", () => {
    const parsed = parseMessage("Thank you!", "Everything is resolved, thanks!");
    expect(classifyIntent(parsed)).toBe("unknown");
  });
});
