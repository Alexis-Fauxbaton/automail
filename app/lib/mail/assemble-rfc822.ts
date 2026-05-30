import type { SendPayload } from "./types";

export function buildSubjectWithRePrefix(subject: string): string {
  if (/^re:\s/i.test(subject)) return subject;
  return `Re: ${subject}`;
}

/** HTML-escape user-supplied content before embedding it inside our HTML body. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the original customer message as an HTML <blockquote>. Normalizes
 * CRLF to LF, HTML-escapes the content (defends against the original mail
 * containing literal `<script>` etc.), then converts newlines to <br>.
 */
export function quoteOriginalHtml(body: string): string {
  if (!body) return "";
  const escaped = escapeHtml(body.replace(/\r\n/g, "\n"));
  return `<blockquote style="margin:0 0 0 8px;border-left:2px solid #ccc;padding-left:8px;">${escaped.replace(/\n/g, "<br>")}</blockquote>`;
}

export function generateMessageId(shop: string): string {
  // RFC 5322 Message-ID format: <unique@domain>. We use the shop as
  // domain (e.g. mystore.myshopify.com) since it's guaranteed unique
  // per merchant. We don't wrap in <> here — that's the caller's job.
  const rand = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${rand}@${shop}`;
}

export interface AssembleInput {
  shop: string;
  mailbox: { email: string; fromName?: string };
  customer: { email: string; name?: string };
  originalIncoming: {
    rfcMessageId: string;
    /** Provider-internal ID of the message we're replying to. Used by Outlook
     *  to call /me/messages/{id}/createReply for native conversation threading. */
    externalMessageId?: string;
    receivedAt: Date;
    subject: string;
    bodyText: string;
  };
  thread: { references: string };
  /**
   * Draft body as authored. The LLM generates HTML (e.g. `<p>...</p>`), and
   * the inbox preview renders it as HTML — we pass it through unchanged.
   * If a future caller wants to send a plain-text-only draft, escape it
   * upstream before calling assembleRfc822.
   */
  draftBody: string;
}

export function assembleRfc822(input: AssembleInput): SendPayload {
  const { shop, mailbox, customer, originalIncoming, thread, draftBody } = input;
  const dateStr = originalIncoming.receivedAt.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Paris",
  });
  const customerLabel = customer.name
    ? `${customer.name} <${customer.email}>`
    : customer.email;
  // Build an HTML body: draft (already HTML) + spacer + quote header + blockquote.
  // The quote header is HTML-escaped because customerLabel can contain `<email>`.
  const quoteHeader = `Le ${dateStr}, ${escapeHtml(customerLabel)} a écrit :`;
  const quoted = quoteOriginalHtml(originalIncoming.bodyText);
  const bodyHtml = `${draftBody}<br><br><p>${quoteHeader}</p>${quoted}`;
  return {
    rfcMessageId: generateMessageId(shop),
    inReplyToRfcId: originalIncoming.rfcMessageId,
    inReplyToExternalMessageId: originalIncoming.externalMessageId,
    references: thread.references,
    fromEmail: mailbox.email,
    fromName: mailbox.fromName,
    toEmails: [customer.email],
    subject: buildSubjectWithRePrefix(originalIncoming.subject),
    bodyText: bodyHtml,
  };
}

/**
 * Render a SendPayload to a full RFC822 string suitable for raw transport
 * (Gmail's gmail.users.messages.send takes base64url(RFC822)). Outlook and
 * Zoho use structured JSON and don't need this.
 *
 * Body is always HTML — see assembleRfc822 for the composition.
 */
export function renderRfc822(payload: SendPayload): string {
  const lines: string[] = [];
  if (payload.fromName) {
    lines.push(`From: "${payload.fromName}" <${payload.fromEmail}>`);
  } else {
    lines.push(`From: <${payload.fromEmail}>`);
  }
  lines.push(`To: ${payload.toEmails.join(", ")}`);
  if (payload.ccEmails?.length) lines.push(`Cc: ${payload.ccEmails.join(", ")}`);
  lines.push(`Subject: ${payload.subject}`);
  lines.push(`Message-ID: <${payload.rfcMessageId}>`);
  if (payload.inReplyToRfcId) lines.push(`In-Reply-To: <${payload.inReplyToRfcId}>`);
  if (payload.references) lines.push(`References: ${payload.references}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Content-Type: text/html; charset=utf-8`);
  lines.push(`Content-Transfer-Encoding: 8bit`);
  lines.push("");
  lines.push(payload.bodyText);
  return lines.join("\r\n");
}
