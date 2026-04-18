import type { ParsedEmail } from "./types";

/**
 * Light normalization of a raw email. We do NOT strip signatures or quoted
 * replies aggressively — the extractor still wants to see order numbers and
 * tracking numbers from quoted content.
 */
export function parseMessage(subject: string, body: string): ParsedEmail {
  const cleanSubject = (subject ?? "").trim();
  const cleanBody = (body ?? "").replace(/\r\n/g, "\n").trim();

  const normalized = `${cleanSubject}\n${cleanBody}`.toLowerCase();

  return {
    subject: cleanSubject,
    body: cleanBody,
    normalized,
  };
}
