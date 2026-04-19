import { DEFAULT_SETTINGS, type Language, type SupportSettings, type Tone } from "./settings";
import type {
  OrderFacts,
  ParsedEmail,
  SupportAnalysis,
  SupportIntent,
  TrackingFacts,
  Warning,
} from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DraftInput {
  intent: SupportIntent;
  order: OrderFacts | null;
  tracking: TrackingFacts | null;
  warnings: Warning[];
  /** Optional per-shop configuration. Falls back to sensible defaults. */
  settings?: Partial<SupportSettings>;
  /** Parsed email — used to auto-detect language when settings.language = "auto". */
  parsed?: ParsedEmail | null;
}

export function generateDraft(input: DraftInput): string {
  const cfg = resolveSettings(input.settings);
  const lang = resolveLanguage(cfg.language, input.parsed ?? null);
  const t = T[lang];

  const hi = greeting(input.order, cfg.tone, lang);
  const summary = orderSummary(input.order, lang);
  const track = trackingBlock(input.tracking, lang);
  const sign = signoff(cfg, lang);

  if (!input.order) {
    return joinLines([hi, "", t.noOrderFound, t.askIdentifiers, "", sign]);
  }

  switch (input.intent) {
    case "where_is_my_order":
      return joinLines([
        hi,
        "",
        input.tracking && input.tracking.source !== "none"
          ? t.whereLatestInfo
          : t.whereNoTracking,
        summary,
        track,
        t.whereCloser,
        "",
        sign,
      ]);

    case "delivery_delay":
      return joinLines([
        hi,
        "",
        t.delaySorry,
        summary,
        track,
        t.delayCloser,
        "",
        sign,
      ]);

    case "marked_delivered_not_received":
      return joinLines([
        hi,
        "",
        t.deliveredSorry,
        summary,
        track,
        t.deliveredCloser,
        "",
        sign,
      ]);

    case "package_stuck":
      return joinLines([
        hi,
        "",
        t.stuckIntro,
        summary,
        track,
        t.stuckCloser,
        "",
        sign,
      ]);

    case "refund_request":
      return joinLines([
        hi,
        "",
        t.refundIntro,
        summary,
        "",
        t.refundCloser,
        "",
        sign,
      ]);

    case "unknown":
    default:
      return joinLines([
        hi,
        "",
        t.unknownIntro,
        summary,
        track,
        input.warnings.length > 0 ? t.unknownClarifyWarned : t.unknownClarify,
        "",
        sign,
      ]);
  }
}

export function buildDraft(
  a: Omit<SupportAnalysis, "draftReply"> & {
    settings?: Partial<SupportSettings>;
    parsed?: ParsedEmail | null;
  },
): string {
  return generateDraft({
    intent: a.intent,
    order: a.order,
    tracking: a.tracking,
    warnings: a.warnings,
    settings: a.settings,
    parsed: a.parsed,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSettings(partial?: Partial<SupportSettings>): SupportSettings {
  return {
    shop: partial?.shop ?? "",
    signatureName: partial?.signatureName || DEFAULT_SETTINGS.signatureName,
    brandName: partial?.brandName ?? DEFAULT_SETTINGS.brandName,
    tone: partial?.tone ?? DEFAULT_SETTINGS.tone,
    language: partial?.language ?? DEFAULT_SETTINGS.language,
    closingPhrase: partial?.closingPhrase ?? DEFAULT_SETTINGS.closingPhrase,
    shareTrackingNumber: partial?.shareTrackingNumber ?? DEFAULT_SETTINGS.shareTrackingNumber,
    customerGreetingStyle: partial?.customerGreetingStyle ?? DEFAULT_SETTINGS.customerGreetingStyle,
  };
}

/** If language = auto, guess from the email using a tiny heuristic. */
function resolveLanguage(
  setting: Language,
  parsed: ParsedEmail | null,
): "fr" | "en" {
  if (setting === "fr") return "fr";
  if (setting === "en") return "en";
  if (!parsed) return "en";
  const text = parsed.normalized;
  // French cue words — if any of these appears, pick FR.
  const frCues = /\b(bonjour|commande|livraison|colis|remboursement|merci|cordialement|suivi|adresse)\b/;
  return frCues.test(text) ? "fr" : "en";
}

function joinLines(lines: string[]): string {
  return lines.filter((l) => l !== undefined && l !== null).join("\n");
}

function greeting(
  order: OrderFacts | null,
  tone: Tone,
  lang: "fr" | "en",
): string {
  const first = order?.customerName?.split(" ")[0];
  if (lang === "fr") {
    if (tone === "formal") return first ? `Bonjour ${first},` : "Bonjour,";
    if (tone === "neutral") return first ? `Bonjour ${first},` : "Bonjour,";
    return first ? `Bonjour ${first},` : "Bonjour,";
  }
  // English
  if (tone === "formal") return first ? `Dear ${first},` : "Dear customer,";
  if (tone === "neutral") return first ? `Hello ${first},` : "Hello,";
  return first ? `Hi ${first},` : "Hi,";
}

function signoff(cfg: SupportSettings, lang: "fr" | "en"): string {
  const closing = cfg.closingPhrase
    ? cfg.closingPhrase
    : defaultClosing(cfg.tone, lang);
  const sig = cfg.brandName
    ? `${cfg.signatureName}\n${cfg.brandName}`
    : cfg.signatureName;
  return `${closing}\n${sig}`;
}

function defaultClosing(tone: Tone, lang: "fr" | "en"): string {
  if (lang === "fr") {
    if (tone === "formal") return "Je vous prie d'agréer mes salutations distinguées,";
    if (tone === "neutral") return "Cordialement,";
    return "Belle journée,";
  }
  if (tone === "formal") return "Kind regards,";
  if (tone === "neutral") return "Best regards,";
  return "Cheers,";
}

function orderSummary(order: OrderFacts | null, lang: "fr" | "en"): string {
  if (!order) return "";
  const labels = lang === "fr"
    ? { order: "Commande", fulfillment: "expédition", payment: "paiement" }
    : { order: "Order", fulfillment: "fulfillment", payment: "payment" };
  const parts: string[] = [`${labels.order} ${order.name}`];
  if (order.displayFulfillmentStatus)
    parts.push(`${labels.fulfillment}: ${order.displayFulfillmentStatus}`);
  if (order.displayFinancialStatus)
    parts.push(`${labels.payment}: ${order.displayFinancialStatus}`);
  return parts.join(" — ");
}

function trackingBlock(
  tracking: TrackingFacts | null,
  lang: "fr" | "en",
): string {
  if (!tracking || tracking.source === "none") return "";
  const lines: string[] = [];
  const l = lang === "fr"
    ? { carrier: "Transporteur", number: "Numéro de suivi", url: "Lien de suivi", inferred: "(Note : transporteur/lien déduits du numéro — à vérifier.)" }
    : { carrier: "Carrier", number: "Tracking number", url: "Tracking link", inferred: "(Note: carrier/link inferred from the tracking number — please verify.)" };
  if (tracking.carrier) lines.push(`${l.carrier}: ${tracking.carrier}`);
  if (tracking.trackingNumber) lines.push(`${l.number}: ${tracking.trackingNumber}`);
  if (tracking.trackingUrl) lines.push(`${l.url}: ${tracking.trackingUrl}`);
  if (tracking.inferred) lines.push(l.inferred);
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const T = {
  en: {
    noOrderFound:
      "Thank you for reaching out. I was not able to locate your order from the information in your message.",
    askIdentifiers:
      "Could you please share your order number (for example #1234) or the email address used at checkout?",
    whereLatestInfo: "Thanks for reaching out. Here is the latest information we have on your order:",
    whereNoTracking:
      "Thanks for reaching out. Your order is in our system, but we do not yet have tracking information to share:",
    whereCloser: "Please let me know if anything looks off or if you have further questions.",
    delaySorry: "I'm sorry for the wait. I checked your order and here is what I can confirm:",
    delayCloser:
      "If the situation does not move in the coming days, please reply to this email and we will investigate further with the carrier.",
    deliveredSorry:
      "I'm sorry to hear the parcel has not reached you even though it shows as delivered. Here is what I have on file:",
    deliveredCloser:
      "Could you please check with neighbours and any safe-drop location, and confirm the delivery address on the order is correct? We will open an investigation with the carrier in parallel.",
    stuckIntro: "Thanks for letting us know. I've reviewed the tracking information for your order:",
    stuckCloser:
      "We will contact the carrier to ask for an update. I'll get back to you as soon as I have more information.",
    refundIntro: "Thank you for your message. I have located your order:",
    refundCloser:
      "Before processing anything, could you share a few more details about the reason for the refund request? Once I have that, I'll review the order with our team and come back to you with next steps.",
    unknownIntro: "Thanks for reaching out. I've located the following order on our side:",
    unknownClarify: "Could you tell me a bit more about what you'd like help with?",
    unknownClarifyWarned:
      "Could you please clarify what you need help with so I can assist you better?",
  },
  fr: {
    noOrderFound:
      "Merci pour votre message. Je n'ai pas pu retrouver votre commande avec les informations fournies.",
    askIdentifiers:
      "Pourriez-vous nous communiquer votre numéro de commande (par exemple #1234) ou l'adresse e-mail utilisée lors de l'achat ?",
    whereLatestInfo: "Merci pour votre message. Voici les dernières informations concernant votre commande :",
    whereNoTracking:
      "Merci pour votre message. Votre commande est bien enregistrée, mais nous n'avons pas encore d'informations de suivi à partager :",
    whereCloser: "N'hésitez pas à nous recontacter si vous avez d'autres questions.",
    delaySorry: "Désolé pour l'attente. J'ai vérifié votre commande, voici ce que je peux confirmer :",
    delayCloser:
      "Si la situation ne bouge pas dans les prochains jours, répondez à cet e-mail et nous lancerons une enquête auprès du transporteur.",
    deliveredSorry:
      "Je suis désolé que le colis ne soit pas arrivé alors qu'il est marqué comme livré. Voici les informations que j'ai :",
    deliveredCloser:
      "Pouvez-vous vérifier auprès des voisins et du point de dépôt habituel, et confirmer l'adresse de livraison renseignée sur la commande ? Nous ouvrons une enquête auprès du transporteur en parallèle.",
    stuckIntro: "Merci de nous avoir prévenus. J'ai consulté les informations de suivi de votre commande :",
    stuckCloser:
      "Nous contactons le transporteur pour obtenir une mise à jour. Je reviens vers vous dès que j'ai plus d'informations.",
    refundIntro: "Merci pour votre message. J'ai retrouvé votre commande :",
    refundCloser:
      "Avant de procéder, pourriez-vous nous préciser la raison de votre demande de remboursement ? Dès réception de ces éléments, je reviendrai vers vous avec la suite à donner.",
    unknownIntro: "Merci pour votre message. J'ai retrouvé la commande suivante :",
    unknownClarify: "Pourriez-vous nous en dire un peu plus sur votre demande ?",
    unknownClarifyWarned:
      "Pourriez-vous préciser votre demande afin que je puisse mieux vous aider ?",
  },
} as const;
