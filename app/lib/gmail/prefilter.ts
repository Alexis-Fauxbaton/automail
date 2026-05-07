import type { MailMessage } from "../mail/types";
import {
  BLACKLISTED_DOMAINS,
  NOREPLY_PATTERNS,
  AUTOMATED_SUBJECT_PATTERNS,
} from "./blacklist";

export type PrefilterResult =
  | { passed: true }
  | { passed: false; reason: string };

const EXCLUDED_LABELS = new Set([
  "SPAM",
  "TRASH",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
  // Outlook-specific: inferenceClassification=other and promotional categories
  "OUTLOOK_OTHER",
  "OUTLOOK_CATEGORY_Promotions",
  "OUTLOOK_CATEGORY_Newsletters",
  "OUTLOOK_CATEGORY_Social updates",
]);

/** Domains owned by the store — notifications from these are not customer support. */
const SAFE_DOMAIN_RE = /^[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?)+$/;

let _storeDomains: Set<string> | null = null;
function getStoreDomains(): Set<string> {
  if (_storeDomains) return _storeDomains;
  const raw = process.env.STORE_EMAIL_DOMAINS ?? "";
  const domains = new Set<string>();
  for (const d of raw.split(",")) {
    const trimmed = d.trim().toLowerCase();
    if (trimmed && SAFE_DOMAIN_RE.test(trimmed)) domains.add(trimmed);
  }
  _storeDomains = domains;
  return domains;
}

export function prefilterEmail(
  msg: MailMessage,
  knownCustomerEmails?: Set<string>,
): PrefilterResult {
  // Known Shopify customer → always pass (highest priority)
  if (knownCustomerEmails?.has(msg.from.toLowerCase())) {
    return { passed: true };
  }

  // Store's own domain → internal notification, not customer support
  const senderDomain = msg.from.split("@")[1]?.toLowerCase();
  const senderDomainParts = senderDomain?.split(".");
  const senderParentDomain =
    senderDomainParts && senderDomainParts.length > 2
      ? senderDomainParts.slice(-2).join(".")
      : undefined;
  const storeDomains = getStoreDomains();
  if (senderDomain && storeDomains.size > 0) {
    if (storeDomains.has(senderDomain)) {
      return { passed: false, reason: `own_store_domain:${senderDomain}` };
    }
    if (senderParentDomain && storeDomains.has(senderParentDomain)) {
      return { passed: false, reason: `own_store_domain:${senderParentDomain}` };
    }
  }

  // Label check
  for (const label of msg.labelIds) {
    if (EXCLUDED_LABELS.has(label)) {
      return { passed: false, reason: `label:${label}` };
    }
  }

  // Noreply sender
  for (const pattern of NOREPLY_PATTERNS) {
    if (pattern.test(msg.from)) {
      return { passed: false, reason: `noreply:${msg.from}` };
    }
  }

  // Blacklisted domain (check exact domain + parent domain)
  if (senderDomain) {
    if (BLACKLISTED_DOMAINS.has(senderDomain)) {
      return { passed: false, reason: `blacklisted_domain:${senderDomain}` };
    }
    if (senderParentDomain && BLACKLISTED_DOMAINS.has(senderParentDomain)) {
      return { passed: false, reason: `blacklisted_domain:${senderParentDomain}` };
    }
  }

  // Unsubscribe header → likely newsletter
  if (msg.headers["list-unsubscribe"]) {
    return { passed: false, reason: "has_unsubscribe_header" };
  }

  // Automated subject patterns
  for (const pattern of AUTOMATED_SUBJECT_PATTERNS) {
    if (pattern.test(msg.subject)) {
      return { passed: false, reason: `automated_subject:${msg.subject.slice(0, 60)}` };
    }
  }

  return { passed: true };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _storeDomains = null;
  });
}
