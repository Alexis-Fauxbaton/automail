/**
 * Realistic customer support email scenarios.
 *
 * Written spec-first: each scenario describes what a REAL customer would write
 * and what the app MUST produce — before looking at any implementation detail.
 *
 * Used by:
 *  - scenarios.test.ts    (parsing + extraction, no mocking)
 *  - pipeline.test.ts     (full orchestrator, mocked externals)
 */

import type { ExtractedIdentifiers, SupportIntent } from "../../types";

export interface EmailScenario {
  id: string;
  description: string;
  subject: string;
  body: string;
  expectedIntent: SupportIntent;
  /** Fields that MUST be present in the extracted identifiers. */
  mustExtract: Partial<ExtractedIdentifiers>;
  /** Fields that must NOT be set (to avoid false positives). */
  mustNotExtract?: (keyof ExtractedIdentifiers)[];
}

export const EMAIL_SCENARIOS: EmailScenario[] = [
  // --- S1: Where is my order — EN — order number in subject ---
  {
    id: "S1",
    description: "WIMO – English – order number in subject with hash",
    subject: "Order #1001 — where is my package?",
    body: "Hi,\n\nI placed this order 5 days ago and I haven't received any shipping update.\nCould you let me know where it is?\n\nThanks,\nSarah",
    expectedIntent: "where_is_my_order",
    mustExtract: { orderNumber: "1001" },
  },

  // --- S2: Where is my order — FR — order number in body ---
  {
    id: "S2",
    description: "WIMO – French – order number in body, no hash",
    subject: "Suivi de ma commande",
    body: "Bonjour,\n\nJe souhaite avoir des nouvelles de ma commande 2002.\nCela fait maintenant une semaine et je n'ai reçu aucune confirmation d'expédition.\n\nCordialement,\nMarie Dupont",
    expectedIntent: "where_is_my_order",
    mustExtract: { orderNumber: "2002" },
  },

  // --- S3: Delivery delay — EN — with customer email ---
  {
    id: "S3",
    description: "Delivery delay – English – order number + customer email",
    subject: "My order is taking too long",
    body: "Hello,\n\nI ordered item #3003 two weeks ago and it still hasn't arrived.\nThis is way too long. My email is john.doe@gmail.com.\n\nJohn",
    expectedIntent: "delivery_delay",
    mustExtract: { orderNumber: "3003", email: "john.doe@gmail.com" },
  },

  // --- S4: Delivery delay — FR ---
  {
    id: "S4",
    description: "Delivery delay – French – accents in keywords",
    subject: "Commande en retard",
    body: "Bonjour,\n\nMa commande numéro 4004 est toujours en retard.\nJe l'attendais pour la semaine dernière.\n\nMerci,\nPierre Martin",
    expectedIntent: "delivery_delay",
    mustExtract: { orderNumber: "4004" },
  },

  // --- S5: Marked delivered, not received — EN ---
  {
    id: "S5",
    description: "Marked delivered not received – English – tracking shows delivered",
    subject: "Order #5005 shows delivered but I got nothing",
    body: "Hi,\n\nThe tracking says my order was delivered yesterday but I have not received anything.\nI checked with my neighbours and nothing was left at my door either.\n\nPlease help,\nAnna",
    expectedIntent: "marked_delivered_not_received",
    mustExtract: { orderNumber: "5005" },
  },

  // --- S6: Package stuck — FR — tracking number in email ---
  {
    id: "S6",
    description: "Package stuck – French – tracking number provided by customer",
    subject: "Colis bloqué depuis 5 jours",
    body: "Bonjour,\n\nMon colis est bloqué depuis plusieurs jours, il n'avance plus.\nLe numéro de suivi est le 6123456789012.\nCommande n°6006.\n\nMerci d'avance.",
    expectedIntent: "package_stuck",
    mustExtract: { orderNumber: "6006", trackingNumber: "6123456789012" },
  },

  // --- S7: Refund request — EN ---
  {
    id: "S7",
    description: "Refund request – English – explicit refund ask",
    subject: "Refund request for order #7007",
    body: "Hello,\n\nI would like to request a full refund for order #7007.\nThe product arrived damaged and is not usable.\n\nPlease process this as soon as possible.\n\nBest,\nMike",
    expectedIntent: "refund_request",
    mustExtract: { orderNumber: "7007" },
  },

  // --- S8: Unknown — no identifiers ---
  {
    id: "S8",
    description: "Unknown intent – no identifiers – vague request",
    subject: "Hello I need help",
    body: "Hi,\n\nI need help with something.\nCan someone contact me?\n\nThanks",
    expectedIntent: "unknown",
    mustExtract: {},
    mustNotExtract: ["orderNumber", "email", "trackingNumber"],
  },
];

/**
 * Subset used for pipeline tests (scenarios with expected Shopify results).
 */
export const PIPELINE_SCENARIOS = {
  wimoOrderFound: EMAIL_SCENARIOS[0],   // S1
  wimoFrench: EMAIL_SCENARIOS[1],       // S2
  deliveryDelay: EMAIL_SCENARIOS[2],    // S3
  markedDelivered: EMAIL_SCENARIOS[4],  // S5
  packageStuck: EMAIL_SCENARIOS[5],     // S6
  refundRequest: EMAIL_SCENARIOS[6],    // S7
  noIdentifiers: EMAIL_SCENARIOS[7],    // S8
};
