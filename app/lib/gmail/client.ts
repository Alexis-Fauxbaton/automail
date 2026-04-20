import { google, type gmail_v1 } from "googleapis";
import { getAuthenticatedClient } from "./auth";
import type { MailMessage } from "../mail/types";

export type GmailMessage = MailMessage;

export async function getGmailService(shop: string) {
  const auth = await getAuthenticatedClient(shop);
  return google.gmail({ version: "v1", auth });
}

/** Helper: page through Gmail messages.list for a single query string. */
async function fetchMessageIds(
  gmail: gmail_v1.Gmail,
  query: string,
  maxResults: number,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(maxResults - ids.length, 100),
      pageToken,
    });
    for (const msg of res.data.messages ?? []) {
      if (msg.id) ids.push(msg.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < maxResults);
  return ids;
}

export async function listRecentMessages(
  gmail: gmail_v1.Gmail,
  opts: { afterDate?: Date; maxResults?: number },
): Promise<string[]> {
  const datePart = opts.afterDate
    ? ` after:${Math.floor(opts.afterDate.getTime() / 1000)}`
    : "";
  const maxResults = opts.maxResults ?? 100;

  // Two separate queries — avoids any ambiguity with the OR operator in the
  // Gmail search API and ensures we reliably get both inbox and sent messages.
  const [inboxIds, sentIds] = await Promise.all([
    fetchMessageIds(gmail, `in:inbox${datePart}`, maxResults),
    fetchMessageIds(gmail, `in:sent${datePart}`, maxResults),
  ]);

  // Deduplicate (a message can have both INBOX and SENT labels in rare cases)
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of [...inboxIds, ...sentIds]) {
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

export async function getMessage(
  gmail: gmail_v1.Gmail,
  messageId: string,
): Promise<GmailMessage> {
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  return parseGmailMessage(res.data);
}

/** Parse a raw Gmail message payload into our MailMessage shape. */
function parseGmailMessage(data: gmail_v1.Schema$Message): GmailMessage {
  const headers: Record<string, string> = {};
  for (const h of data.payload?.headers ?? []) {
    if (h.name && h.value) headers[h.name.toLowerCase()] = h.value;
  }

  const from = headers["from"] ?? "";
  const fromName = extractName(from);
  const subject = headers["subject"] ?? "(no subject)";

  const bodyText = extractPlainBody(data.payload);

  return {
    id: data.id!,
    threadId: data.threadId ?? "",
    from: extractEmail(from),
    fromName,
    subject,
    bodyText,
    snippet: data.snippet ?? "",
    receivedAt: new Date(parseInt(data.internalDate ?? "0", 10)),
    labelIds: data.labelIds ?? [],
    headers,
  };
}

/**
 * Fetch ALL messages in a Gmail thread (inbox + sent + any label),
 * ordered chronologically.
 */
export async function getThreadMessages(
  gmail: gmail_v1.Gmail,
  threadId: string,
): Promise<GmailMessage[]> {
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });
  const messages = (res.data.messages ?? []).map(parseGmailMessage);
  // Sort chronologically (oldest first)
  messages.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  return messages;
}

export async function listHistoryChanges(
  gmail: gmail_v1.Gmail,
  startHistoryId: string,
): Promise<{ messageIds: string[]; latestHistoryId?: string }> {
  const ids = new Set<string>();
  let latestHistoryId: string | undefined;

  // Fetch history for both INBOX and SENT so sent replies are captured.
  for (const labelId of ["INBOX", "SENT"] as const) {
    let pageToken: string | undefined;
    try {
      do {
        const res = await gmail.users.history.list({
          userId: "me",
          startHistoryId,
          historyTypes: ["messageAdded"],
          labelId,
          pageToken,
        });
        // Keep the highest historyId across both calls
        const hid = res.data.historyId ?? undefined;
        if (hid && (!latestHistoryId || hid > latestHistoryId)) {
          latestHistoryId = hid;
        }
        for (const h of res.data.history ?? []) {
          for (const ma of h.messagesAdded ?? []) {
            if (ma.message?.id) ids.add(ma.message.id);
          }
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (err: unknown) {
      // 404 means historyId is too old — need full re-fetch
      if (isGmailError(err, 404)) {
        return { messageIds: [], latestHistoryId: undefined };
      }
      throw err;
    }
  }

  return { messageIds: Array.from(ids), latestHistoryId };
}

export async function getProfile(gmail: gmail_v1.Gmail) {
  const res = await gmail.users.getProfile({ userId: "me" });
  return { historyId: res.data.historyId ?? undefined };
}

// --- Helpers ---

function extractEmail(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase();
  // Bare email
  if (fromHeader.includes("@")) return fromHeader.trim().toLowerCase();
  return fromHeader;
}

function extractName(fromHeader: string): string {
  const match = fromHeader.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  return "";
}

function extractPlainBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  // Simple text/plain at top level
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Walk multipart
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return decodeBase64Url(part.body.data);
    }
    // Nested multipart
    if (part.parts) {
      const nested = extractPlainBody(part);
      if (nested) return nested;
    }
  }

  // Fallback: try text/html and strip tags
  const htmlBody = findHtmlBody(payload);
  if (htmlBody) {
    return cleanHtml(htmlBody);
  }

  return "";
}

/** Strip style/script blocks, HTML tags, and clean up whitespace. */
export function cleanHtml(html: string): string {
  return html
    // Remove <style> blocks and their content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    // Remove <script> blocks and their content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Replace <br>, <p>, <div>, <tr>, <li> with newlines for readability
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6])[^>]*>/gi, "\n")
    // Remove all remaining HTML tags
    .replace(/<[^>]+>/g, " ")
    // Decode common HTML entities
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&euro;/gi, "€")
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findHtmlBody(payload: gmail_v1.Schema$MessagePart): string | null {
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    const found = findHtmlBody(part);
    if (found) return found;
  }
  return null;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function isGmailError(err: unknown, statusCode: number): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: number }).code === statusCode
  );
}
