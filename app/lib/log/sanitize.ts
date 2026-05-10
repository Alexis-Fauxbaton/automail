/**
 * PII sanitizer for log messages and error payloads.
 *
 * Stack traces and error messages routinely embed customer data picked up
 * from upstream APIs (Shopify GraphQL echoing an email, a parser error
 * quoting an order number…). This module scrubs known PII patterns so a
 * grep over the logs cannot leak protected customer data.
 *
 * Conservative on purpose: only patterns that are unambiguously PII are
 * masked. Internal IDs (cuid, correlation_id) are left intact — they are
 * essential for cross-referencing log lines.
 */

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Shopify order number written as `#1234` (3+ digits).
const ORDER_HASH_RE = /#\d{3,}\b/g;
// Tracking-like sequences: 10+ chars, alphanumeric, with at least one digit.
// Conservative bounds to avoid masking words like "INFORMATION".
const TRACKING_RE = /\b(?=[A-Z0-9]*\d)[A-Z0-9]{10,30}\b/g;

const MAX_LEN = 500;

export function sanitizeText(input: string): string {
  let out = input
    .replace(EMAIL_RE, "<email>")
    .replace(ORDER_HASH_RE, "<order>")
    .replace(TRACKING_RE, "<token>");
  if (out.length > MAX_LEN) {
    out = out.slice(0, MAX_LEN) + "…[truncated]";
  }
  return out;
}

export interface SanitizedError {
  name: string;
  message: string;
  stack?: string;
}

/** Convert any thrown value into a sanitized, JSON-serialisable shape. */
export function sanitizeError(err: unknown): SanitizedError {
  if (err instanceof Error) {
    const stack = err.stack
      ? sanitizeText(err.stack.split("\n").slice(0, 6).join("\n"))
      : undefined;
    return {
      name: err.name,
      message: sanitizeText(err.message),
      ...(stack ? { stack } : {}),
    };
  }
  return {
    name: "NonError",
    message: sanitizeText(typeof err === "string" ? err : JSON.stringify(err)),
  };
}
