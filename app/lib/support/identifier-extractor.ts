import type { ExtractedIdentifiers, ParsedEmail } from "./types";

// --- Regex building blocks -------------------------------------------------

// Order number: "#1234", "commande 1234", "order #1234", "n°1234", "order number 1234"
const ORDER_WITH_HASH = /#\s?(\d{3,10})\b/i;
const ORDER_WITH_KEYWORD =
  /\b(?:order|commande|cmd|n[°o]\.?|numero|num[eé]ro)\s*[:#]?\s*(\d{3,10})\b/i;

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

// Tracking: loose match. Carriers vary wildly; we keep a permissive regex and
// a few tight ones to avoid collapsing with an order number.
const TRACKING_KEYWORD_RE =
  /\b(?:tracking|suivi|colis|parcel|n[°o]\.?\s*de\s*suivi)\s*[:#]?\s*([A-Z0-9]{8,30})\b/i;

// Carrier-shaped hints (used without keyword).
// - UPS: 1Z + 16 chars
// - Chronopost / Colissimo: 13 digits
// - DHL: 10-11 digits
// - FedEx: 12-15 digits
// - La Poste tracking: 13 alphanumerics often ending with "FR"
const CARRIER_PATTERNS: RegExp[] = [
  /\b1Z[0-9A-Z]{16}\b/,
  /\b\d{13}\b/,
  /\b[A-Z]{2}\d{9}[A-Z]{2}\b/,
];

// "I am John Doe" / "Je m'appelle Jean Dupont" / "from John Doe"
const NAME_RE =
  /\b(?:my name is|i am|i'm|je m'appelle|je suis|from)\s+([A-ZÀ-ÖØ-Þ][\p{L}'’-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}'’-]+){0,2})/u;

// --- Extractor -------------------------------------------------------------

export function extractIdentifiers(parsed: ParsedEmail): ExtractedIdentifiers {
  const source = `${parsed.subject}\n${parsed.body}`;
  const result: ExtractedIdentifiers = {};

  const orderHash = source.match(ORDER_WITH_HASH);
  const orderKeyword = !orderHash ? source.match(ORDER_WITH_KEYWORD) : null;
  if (orderHash) {
    result.orderNumber = orderHash[1];
  } else if (orderKeyword) {
    result.orderNumber = orderKeyword[1];
  }

  const email = source.match(EMAIL_RE);
  if (email) result.email = email[0].toLowerCase();

  const trackingKeyword = source.match(TRACKING_KEYWORD_RE);
  if (trackingKeyword) {
    result.trackingNumber = trackingKeyword[1];
  } else {
    for (const re of CARRIER_PATTERNS) {
      const m = source.match(re);
      if (m && m[0] !== result.orderNumber) {
        result.trackingNumber = m[0];
        break;
      }
    }
  }

  const name = source.match(NAME_RE);
  if (name) result.customerName = name[1].trim();

  return result;
}
