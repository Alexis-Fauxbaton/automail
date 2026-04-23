import { describe, it, expect } from "vitest";
import { classifyIntent } from "../intent-classifier";
import { parseMessage } from "../message-parser";

function classify(subject: string, body: string) {
  return classifyIntent(parseMessage(subject, body));
}

describe("classifyIntent", () => {
  // --- where_is_my_order ---
  it('detects "where is my order"', () => {
    expect(classify("", "where is my order")).toBe("where_is_my_order");
  });

  it("detects suivi (French)", () => {
    expect(classify("", "je voudrais le suivi de ma commande")).toBe("where_is_my_order");
  });

  it("detects status of my order", () => {
    expect(classify("Status of my order #1234", "")).toBe("where_is_my_order");
  });

  // --- delivery_delay ---
  it("detects delivery delay via 'late'", () => {
    expect(classify("", "my order is late, please help")).toBe("delivery_delay");
  });

  it("detects delivery delay via 'retard' (French)", () => {
    expect(classify("", "ma commande est en retard")).toBe("delivery_delay");
  });

  it("detects 'still waiting'", () => {
    expect(classify("", "I am still waiting for my package")).toBe("delivery_delay");
  });

  // --- marked_delivered_not_received ---
  it("detects marked as delivered but not received", () => {
    expect(classify("", "it shows delivered but I never received it")).toBe(
      "marked_delivered_not_received",
    );
  });

  it("detects 'not received' alone", () => {
    expect(classify("", "I have not received my order yet")).toBe(
      "marked_delivered_not_received",
    );
  });

  it("detects French 'jamais reçu'", () => {
    expect(classify("", "je n'ai jamais reçu mon colis")).toBe(
      "marked_delivered_not_received",
    );
  });

  // --- package_stuck ---
  it("detects package stuck", () => {
    expect(classify("", "my package seems stuck and not moving")).toBe("package_stuck");
  });

  it("detects 'bloqué' (French)", () => {
    expect(classify("", "mon colis est bloqué depuis 5 jours")).toBe("package_stuck");
  });

  // --- refund_request ---
  it("detects refund request", () => {
    expect(classify("", "I would like a refund please")).toBe("refund_request");
  });

  it("detects 'remboursement' (French)", () => {
    expect(classify("", "je demande un remboursement")).toBe("refund_request");
  });

  it("detects 'money back'", () => {
    expect(classify("", "I want my money back")).toBe("refund_request");
  });

  // --- unknown ---
  it("returns unknown when no keywords match", () => {
    expect(classify("Hello", "How are you?")).toBe("unknown");
  });

  it("returns unknown for empty text", () => {
    expect(classify("", "")).toBe("unknown");
  });

  // --- priority: more specific intent wins ---
  it("prefers marked_delivered_not_received over delivery_delay", () => {
    // 'late' + 'not received' → marked_delivered_not_received checked first
    expect(classify("", "package is late and I have not received it")).toBe(
      "marked_delivered_not_received",
    );
  });

  it("prefers marked_delivered_not_received over refund", () => {
    expect(classify("", "marked as delivered but not received, I want a refund")).toBe(
      "marked_delivered_not_received",
    );
  });
});
