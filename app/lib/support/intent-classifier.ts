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
    intent: "package_stuck",
    keywords: [
      /stuck/i,
      /not moving/i,
      /no update/i,
      /hasn'?t moved/i,
      /bloqu[ée]/i,
      /n'avance plus/i,
      /pas de mise [àa] jour/i,
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
    intent: "delivery_delay",
    keywords: [
      /late/i,
      /delay/i,
      /still waiting/i,
      /taking too long/i,
      /en retard/i,
      /retard/i,
      /toujours pas/i,
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
    ],
  },
];

export function classifyIntent(parsed: ParsedEmail): SupportIntent {
  for (const rule of RULES) {
    if (rule.keywords.some((re) => re.test(parsed.normalized))) {
      return rule.intent;
    }
  }
  return "unknown";
}
