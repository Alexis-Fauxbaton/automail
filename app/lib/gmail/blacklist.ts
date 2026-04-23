/** Domains known to send automated / marketing emails. */
export const BLACKLISTED_DOMAINS = new Set([
  // Email marketing platforms
  "mailchimp.com",
  "sendgrid.net",
  "mandrillapp.com",
  "mailgun.org",
  "amazonses.com",
  "postmarkapp.com",
  "klaviyo.com",
  "hubspot.com",
  "salesforce.com",
  "marketo.com",
  "constantcontact.com",
  "sendinblue.com",
  "brevo.com",
  "mailjet.com",
  "getresponse.com",
  "activecampaign.com",
  "drip.com",
  "convertkit.com",
  "omnisend.com",
  "privy.com",
  // Review platforms
  "judge.me",
  "loox.io",
  "yotpo.com",
  "stamped.io",
  "trustpilot.com",
  // Social media
  "facebookmail.com",
  "linkedin.com",
  "pinterest.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "mail.instagram.com",
  // Google automated
  "noreply.google.com",
  "accounts.google.com",
  "calendar-notification.google.com",
  // Marketplaces / promo
  "selections.aliexpress.com",
  "deals.aliexpress.com",
  "mail.aliexpress.com",
  "aliexpress.com",
  "shop.tiktok.com",
  // Shopify automated
  "shops.shopify.com",
]);

/** Sender patterns that indicate automated / no-reply addresses. */
export const NOREPLY_PATTERNS: RegExp[] = [
  /^no[-_.]?reply/i,
  /^noreply/i,
  /^do[-_.]?not[-_.]?reply@/i,
  /^mailer[-_.]?daemon@/i,
  /^postmaster@/i,
  /^bounce[s]?@/i,
  /^notification[s]?@/i,
  /^alert[s]?@/i,
  /^system@/i,
  /^auto@/i,
  /^news@/i,
  /^newsletter@/i,
  /^info@.*\.shopify\.com$/i,
  // Automated billing / payment senders (e.g. invoice+statements+…@stripe.com)
  /^invoice[+\-_.]/i,
  /^billing[+\-_.]/i,
  /^receipts?@/i,
  /^payments?@/i,
  /^statements?@/i,
];

/** Subject patterns that indicate automated / non-support emails. */
export const AUTOMATED_SUBJECT_PATTERNS: RegExp[] = [
  /^(re:\s*)?your.*receipt/i,
  /^(re:\s*)?payment\s+(confirmation|received)/i,
  /^(re:\s*)?invoice\s+#/i,
  /^(re:\s*)?order\s+confirmation/i,
  /^(re:\s*)?shipping\s+confirmation/i,
  /^(re:\s*)?delivery\s+notification/i,
  /newsletter/i,
  /unsubscribe/i,
  /\bpromo(tion)?\b/i,
  /\bdeal(s)?\s+of\s+the\s+(day|week)\b/i,
  /\bflash\s+sale\b/i,
  /\bwebinar\b/i,
  /\bdemo\s+request\b/i,
  /\bpartnership\b/i,
  /\bsponsorship\b/i,
  /\bcollaboration\s+opportunity\b/i,
];
