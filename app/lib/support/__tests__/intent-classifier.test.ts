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

  it("détecte une question de suivi avec formulation neutre", () => {
    const result = classify(
      "Bonjour",
      "Je voulais juste avoir des nouvelles de mon colis. Commande passée il y a 10 jours."
    );
    expect(result).toBe("where_is_my_order");
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

  it("détecte un délai avec formulation indirecte", () => {
    const result = classify(
      "Ma commande",
      "Cela fait maintenant 3 semaines que j'attends, je ne sais pas ce qui se passe."
    );
    expect(result).toBe("delivery_delay");
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

  it('detects "pas de mise à jour" as package_stuck (validates bug fix)', () => {
    expect(classify("", "pas de mise à jour depuis 5 jours")).toBe("package_stuck");
  });

  it("détecte un colis bloqué depuis plusieurs jours", () => {
    const result = classify(
      "Colis",
      "Mon tracking n'a pas bougé depuis 5 jours. Il est toujours au même endroit."
    );
    expect(result).toBe("package_stuck");
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

  it("détecte une demande de remboursement très courte", () => {
    const result = classify("Remboursement", "Je veux être remboursé svp");
    expect(result).toBe("refund_request");
  });

  // --- unknown ---
  it("returns unknown when no keywords match", () => {
    expect(classify("Hello", "How are you?")).toBe("unknown");
  });

  it("returns unknown for empty text", () => {
    expect(classify("", "")).toBe("unknown");
  });

  it("retourne unknown pour une question générale sans intent support clair", () => {
    // "délais" (accented) ne déclenche pas /delay/ (ASCII) — résultat attendu : unknown
    const result = classify(
      "Question",
      "Bonjour, j'ai une question sur vos produits. Quels sont vos délais habituels ?"
    );
    expect(result).toBe("unknown");
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

  // --- multi-intent / edge cases ---
  it("email avec tracking + demande remboursement → intent dominant détecté (pas d'erreur)", () => {
    const result = classify(
      "Problème commande #9999",
      "Mon colis est marqué livré mais je ne l'ai jamais reçu. Je veux aussi un remboursement."
    );
    expect(result).not.toBe(undefined);
    expect(["marked_delivered_not_received", "refund_request"]).toContain(result);
  });
});
