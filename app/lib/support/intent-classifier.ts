import type { ParsedEmail, SupportIntent } from "./types";

// Simple keyword heuristic. Deterministic, cheap, testable.
// Order matters: more specific intents are checked before generic ones.

interface Rule {
  intent: SupportIntent;
  keywords: RegExp[];
}

const RULES: Rule[] = [
  {
    intent: "marked_delivered_not_received",
    keywords: [
      /marked as delivered/i,
      /said delivered/i,
      /shows delivered/i,
      /marqu[ée] (?:comme )?livr[ée]/i,
      /indiqu[ée] livr[ée]/i,
      /never (?:got|received)/i,
      /not received/i,
      /jamais re[cç]u/i,
      /pas re[cç]u/i,
    ],
  },
  {
    intent: "damaged_product",
    keywords: [
      /damaged/i,
      /broken/i,
      /arrived (?:damaged|broken)/i,
      /received (?:a )?(?:damaged|broken) (?:item|product)/i,
      /produit ab[îi]m[ée]/i,
      /article ab[îi]m[ée]/i,
      /colis ab[îi]m[ée]/i,
      /re[cç]u ab[îi]m[ée]/i,
      /est arriv[ée] ab[îi]m[ée]/i,
      /cass[ée]/i,
      /endommag[ée]/i,
    ],
  },
  {
    intent: "order_error",
    keywords: [
      /wrong (?:item|product|order|size|color|colour)/i,
      /missing (?:item|product)/i,
      /(?:item|product) (?:is )?missing/i,
      /not what i ordered/i,
      /mistake (?:in|with) (?:my )?order/i,
      /order (?:is|was) incorrect/i,
      /incorrect (?:item|product|order|size|color|colour)/i,
      /erreur de commande/i,
      /article manquant/i,
      /produit manquant/i,
      /il manque (?:un |une |des )?(?:article|produit|articles|produits)/i,
      /mauvais (?:article|produit|mod[èe]le|coloris|taille)/i,
      /pas le bon (?:article|produit|mod[èe]le|coloris|taille)/i,
      /commande incorrecte/i,
      /je me suis tromp[ée] dans ma commande/i,
      /vous vous [êe]tes tromp[ée]s?/i,
    ],
  },
  {
    intent: "delivery_delay",
    keywords: [
      // Stuck / no movement
      /stuck/i,
      /not moving/i,
      /no update/i,
      /hasn'?t moved/i,
      /bloqu[ée]/i,
      /n'avance plus/i,
      /pas de mise [àa] jour/i,
      /n'a pas bougé/i,
      /pas boug[ée]/i,
      // Late / overdue
      /late/i,
      /delay/i,
      /still waiting/i,
      /taking too long/i,
      /en retard/i,
      /retard/i,
      /toujours pas/i,
      /j'attends/i,
    ],
  },
  {
    intent: "refund_request",
    keywords: [
      /refund/i,
      /reimburs/i,
      /money back/i,
      /remboursement/i,
      /rembours/i,
    ],
  },
  {
    intent: "where_is_my_order",
    keywords: [
      /where is my order/i,
      /where is my (package|parcel|shipment)/i,
      /where'?s my (order|package|parcel)/i,
      /track(?:ing)? (?:my )?order/i,
      /o[uù] est ma commande/i,
      /o[uù] est mon colis/i,
      /suivi/i,
      /status of my order/i,
      /statut de ma commande/i,
      /nouvelles de mon colis/i,
      /avoir des nouvelles/i,
    ],
  },
  {
    intent: "pre_purchase_question",
    keywords: [
      /before (?:i )?(?:buy|order|purchase)/i,
      /pre[- ]?purchase/i,
      /question before buying/i,
      /avant (?:d['’]?)?(?:acheter|commander|passer commande)/i,
      /avant achat/i,
      /question avant achat/i,
      /quelle taille (?:dois-je|choisir|prendre)/i,
      /quelle pointure (?:dois-je|choisir|prendre)/i,
      /est-ce compatible/i,
      /est il compatible/i,
      /est elle compatible/i,
      /is it compatible/i,
      /which size should i choose/i,
      /what size should i choose/i,
    ],
  },
];

export function classifyIntent(parsed: ParsedEmail): SupportIntent {
  return classifyIntents(parsed)[0] ?? "unknown";
}

export function classifyIntents(parsed: ParsedEmail): SupportIntent[] {
  const intents: SupportIntent[] = [];
  for (const rule of RULES) {
    if (rule.keywords.some((re) => re.test(parsed.normalized))) {
      if (!intents.includes(rule.intent)) {
        intents.push(rule.intent);
      }
    }
  }
  return intents.length > 0 ? intents : ["unknown"];
}
