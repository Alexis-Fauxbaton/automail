import { describe, it, expect } from "vitest";
import { classifyIntent, classifyIntents } from "../intent-classifier";
import { parseMessage } from "../message-parser";
import { SUPPORT_INTENTS } from "../types";

function classify(subject: string, body: string) {
  return classifyIntent(parseMessage(subject, body));
}

function classifyAll(subject: string, body: string) {
  return classifyIntents(parseMessage(subject, body));
}

describe("classifyIntent", () => {
  it("expose la liste canonique des intentions supportées", () => {
    expect(SUPPORT_INTENTS).toEqual([
      "where_is_my_order",
      "delivery_delay",
      "marked_delivered_not_received",
      "damaged_product",
      "order_error",
      "refund_request",
      "pre_purchase_question",
      "unknown",
    ]);
  });

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

  // --- damaged_product ---
  it("détecte un produit reçu abîmé", () => {
    expect(classify("Produit reçu abîmé", "Le produit est arrivé cassé dans le colis.")).toBe("damaged_product");
  });

  it("detects damaged product in English", () => {
    expect(classify("Damaged item", "The product arrived broken and unusable.")).toBe("damaged_product");
  });

  // --- order_error ---
  it("détecte une erreur de commande", () => {
    expect(classify("Erreur de commande", "J'ai reçu la mauvaise taille, ce n'est pas le bon article.")).toBe("order_error");
  });

  it("detects wrong item in English", () => {
    expect(classify("Wrong item", "I received the wrong color in my order.")).toBe("order_error");
  });

  it("détecte un article manquant", () => {
    expect(classify("Commande incomplète", "Il manque un article dans mon colis.")).toBe("order_error");
  });

  it("detects missing item in English", () => {
    expect(classify("Missing item", "One product is missing from my order.")).toBe("order_error");
  });

  // --- delivery_delay: stuck tracking variants ---
  it("classifies a stuck package as delivery_delay", () => {
    expect(classify("", "my package seems stuck and not moving")).toBe("delivery_delay");
  });

  it("classifies 'bloqué' as delivery_delay (French)", () => {
    expect(classify("", "mon colis est bloqué depuis 5 jours")).toBe("delivery_delay");
  });

  it('classifies "pas de mise à jour" as delivery_delay', () => {
    expect(classify("", "pas de mise à jour depuis 5 jours")).toBe("delivery_delay");
  });

  it("détecte un colis bloqué depuis plusieurs jours", () => {
    const result = classify(
      "Colis",
      "Mon tracking n'a pas bougé depuis 5 jours. Il est toujours au même endroit."
    );
    expect(result).toBe("delivery_delay");
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

  // --- pre_purchase_question ---
  it("détecte une question avant achat", () => {
    expect(classify("Question avant achat", "Avant de commander, quelle taille dois-je choisir ?")).toBe("pre_purchase_question");
  });

  it("detects a pre-purchase question in English", () => {
    expect(classify("Before buying", "Which size should I choose before I order?")).toBe("pre_purchase_question");
  });

  // --- unknown ---
  it("returns unknown when no keywords match", () => {
    expect(classify("Hello", "How are you?")).toBe("unknown");
  });

  it("returns unknown for empty text", () => {
    expect(classify("", "")).toBe("unknown");
  });

  it("retourne unknown pour une question générale sans intent support clair", () => {
    const result = classify("Bonjour", "Merci pour votre aide, bonne journée.");
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

  it("retourne toutes les intentions détectées dans l'ordre de priorité", () => {
    const result = classifyAll(
      "Problème commande #9999",
      "Mon colis est marqué livré mais je ne l'ai jamais reçu. Je veux aussi un remboursement."
    );
    expect(result).toEqual(["marked_delivered_not_received", "refund_request"]);
  });

  it("détecte produit abîmé + remboursement en conservant la cause comme intention principale", () => {
    const result = classifyAll(
      "Produit abîmé",
      "Le produit est arrivé cassé, je voudrais un remboursement."
    );
    expect(result).toEqual(["damaged_product", "refund_request"]);
  });

  it("détecte retard + colis bloqué + remboursement sans doublon", () => {
    const result = classifyAll(
      "Commande en retard",
      "Je suis toujours en attente, le colis n'a pas bougé depuis 8 jours et je veux un remboursement."
    );
    expect(result).toEqual(["delivery_delay", "refund_request"]);
  });

  it("détecte suivi + retard en conservant l'intention principale prioritaire", () => {
    const parsed = parseMessage(
      "Où est ma commande ?",
      "Je voudrais le suivi, elle est en retard et cela prend trop longtemps."
    );
    expect(classifyIntent(parsed)).toBe("delivery_delay");
    expect(classifyIntents(parsed)).toEqual(["delivery_delay", "where_is_my_order"]);
  });

  it("ne retourne unknown que lorsqu'aucune intention support n'est détectée", () => {
    expect(classifyAll("Question produit", "Quelle taille dois-je choisir ?")).toEqual(["pre_purchase_question"]);
    expect(classifyAll("Refund", "I want a refund and I have a product question too.")).toEqual(["refund_request"]);
  });
});
