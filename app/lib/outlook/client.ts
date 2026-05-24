import { getAuthenticatedClient, getAuthenticatedClientById } from "./auth";
import { cleanHtml } from "../mail/html-utils";
import type { MailMessage, MailAttachment } from "../mail/types";
import { createSemaphore, type Semaphore } from "../util/semaphore";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// Microsoft Graph's MailboxConcurrency limit caps each mailbox at 4 in-flight
// requests. We stay safely under that with 3 so that an unexpected sibling
// call (e.g. getThreadMessages triggered from the inbox UI while the auto-sync
// pass is running) doesn't tip us over and trigger a 429 cascade.
// https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits
const OUTLOOK_PER_MAILBOX_CONCURRENCY = 3;
const mailboxSemaphores = new Map<string, Semaphore>();
// Keyed by connectionId (after the multi-mailbox migration) or shop (legacy).
function mailboxSemaphore(key: string): Semaphore {
  let s = mailboxSemaphores.get(key);
  if (!s) {
    s = createSemaphore(OUTLOOK_PER_MAILBOX_CONCURRENCY);
    mailboxSemaphores.set(key, s);
  }
  return s;
}

const MAX_RETRY_ATTEMPTS = 4;
const DEFAULT_BACKOFF_MS = 1000;
const MAX_RETRY_WAIT_MS = 60_000;

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  // Graph almost always returns seconds as an integer. Tolerate HTTP-date too
  // for robustness — RFC 7231 §7.1.3 allows both.
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}
const MSG_SELECT =
  "id,conversationId,subject,receivedDateTime,from,body,internetMessageHeaders,internetMessageId,categories,inferenceClassification,hasAttachments";
const INLINE_EMBED_LIMIT = 200 * 1024; // 200 KB

/** Escape a string for safe use in OData filter expressions.
 * OData escapes single quotes by doubling them: ' → ''
 */
function odataEscapeString(value: string): string {
  return value.replace(/'/g, "''");
}

interface GraphEmailAddress {
  name: string;
  address: string;
}

interface GraphMessage {
  id: string;
  conversationId: string;
  subject: string;
  receivedDateTime: string;
  from: { emailAddress: GraphEmailAddress };
  body: { contentType: "html" | "text"; content: string };
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  internetMessageId?: string;
  categories: string[];
  inferenceClassification: "focused" | "other";
  hasAttachments: boolean;
}

interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  contentId?: string;
  isInline: boolean;
  contentBytes?: string;
}

export interface DeltaResult {
  messages: MailMessage[];
  nextDeltaLink: string | null;
  staleDeltaToken: boolean;
}

export function parseGraphMessage(raw: GraphMessage): MailMessage {
  const headers: Record<string, string> = {};
  for (const h of raw.internetMessageHeaders ?? []) {
    headers[h.name.toLowerCase()] = h.value;
  }

  const isHtml = raw.body.contentType === "html";
  const bodyHtml = isHtml ? raw.body.content : undefined;
  const bodyText = isHtml ? cleanHtml(raw.body.content) : raw.body.content;

  const labelIds: string[] = [];
  if (raw.inferenceClassification === "other") labelIds.push("OUTLOOK_OTHER");
  for (const cat of raw.categories) {
    labelIds.push(`OUTLOOK_CATEGORY_${cat}`);
  }

  return {
    id: raw.id,
    threadId: raw.conversationId,
    from: raw.from.emailAddress.address.toLowerCase(),
    fromName: raw.from.emailAddress.name,
    subject: raw.subject ?? "(no subject)",
    bodyText,
    bodyHtml,
    snippet: bodyText.slice(0, 200),
    receivedAt: new Date(raw.receivedDateTime),
    labelIds,
    headers,
    attachments: [],
  };
}

async function graphFetch<T>(
  connectionId: string,
  accessToken: string,
  url: string,
): Promise<{ ok: boolean; status: number; data: T }> {
  const sem = mailboxSemaphore(connectionId);
  const release = await sem.acquire();
  try {
    // Retry loop honours 429 (MailboxConcurrency / ApplicationThrottled) and
    // 503 (transient Graph backend). All Graph calls in this module are GETs
    // so retries are safe. Other 4xx are returned as-is for the caller (e.g.
    // 410 staleDeltaToken handling).
    let attempt = 0;
    while (true) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status !== 429 && res.status !== 503) {
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, data: data as T };
      }

      attempt++;
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        const data = await res.json().catch(() => ({}));
        return { ok: false, status: res.status, data: data as T };
      }

      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const backoff = retryAfter ?? DEFAULT_BACKOFF_MS * Math.pow(2, attempt - 1);
      const wait = Math.min(backoff, MAX_RETRY_WAIT_MS);
      console.warn(
        `[outlook/graph] ${res.status} for connectionId=${connectionId} attempt=${attempt} backoff=${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  } finally {
    release();
  }
}

export async function fetchDeltaMessages(
  connectionId: string,
  deltaLink: string | null,
): Promise<DeltaResult> {
  const { accessToken } = await getAuthenticatedClientById(connectionId);

  let url =
    deltaLink ??
    `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$select=${MSG_SELECT}&$top=50`;

  const messages: MailMessage[] = [];
  let nextDeltaLink: string | null = null;

  while (url) {
    const res = await graphFetch<{
      value?: GraphMessage[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    }>(connectionId, accessToken, url);

    if (!res.ok) {
      if (res.status === 410) {
        return { messages: [], nextDeltaLink: null, staleDeltaToken: true };
      }
      throw new Error(`Graph delta fetch failed (${res.status}): ${JSON.stringify(res.data)}`);
    }

    for (const msg of res.data.value ?? []) {
      messages.push(parseGraphMessage(msg));
    }

    if (res.data["@odata.deltaLink"]) {
      nextDeltaLink = res.data["@odata.deltaLink"];
      break;
    }
    url = res.data["@odata.nextLink"] ?? "";
  }

  return { messages, nextDeltaLink, staleDeltaToken: false };
}

export async function fetchHistoricalMessages(
  connectionId: string,
  afterDate: Date,
): Promise<MailMessage[]> {
  const { accessToken } = await getAuthenticatedClientById(connectionId);
  const isoDate = afterDate.toISOString();
  let url =
    `${GRAPH_BASE}/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${isoDate}` +
    `&$select=${MSG_SELECT}&$top=50&$orderby=receivedDateTime asc`;

  const messages: MailMessage[] = [];

  while (url) {
    const res = await graphFetch<{
      value?: GraphMessage[];
      "@odata.nextLink"?: string;
    }>(connectionId, accessToken, url);

    if (!res.ok) {
      throw new Error(`Graph historical fetch failed (${res.status}): ${JSON.stringify(res.data)}`);
    }

    for (const msg of res.data.value ?? []) {
      messages.push(parseGraphMessage(msg));
    }

    url = res.data["@odata.nextLink"] ?? "";
  }

  return messages;
}

export async function getMessageById(connectionId: string, messageId: string): Promise<MailMessage> {
  const { accessToken } = await getAuthenticatedClientById(connectionId);
  const url = `${GRAPH_BASE}/me/messages/${messageId}?$select=${MSG_SELECT}`;
  const res = await graphFetch<GraphMessage>(connectionId, accessToken, url);

  if (!res.ok) {
    throw new Error(`Graph getMessage failed (${res.status}): ${JSON.stringify(res.data)}`);
  }

  const msg = parseGraphMessage(res.data);

  if (res.data.hasAttachments) {
    msg.attachments = await fetchAttachments(connectionId, accessToken, messageId);
  }

  return msg;
}

async function fetchAttachments(
  connectionId: string,
  accessToken: string,
  messageId: string,
): Promise<MailAttachment[]> {
  const url = `${GRAPH_BASE}/me/messages/${messageId}/attachments?$select=id,name,contentType,size,contentId,isInline,contentBytes`;
  const res = await graphFetch<{ value?: GraphAttachment[] }>(connectionId, accessToken, url);

  if (!res.ok) return [];

  return (res.data.value ?? []).map((att) => ({
    fileName: att.name,
    mimeType: att.contentType,
    sizeBytes: att.size,
    contentId: att.contentId ?? undefined,
    disposition: att.isInline ? "inline" : "attachment",
    inlineData:
      att.contentBytes && att.size <= INLINE_EMBED_LIMIT
        ? att.contentBytes
        : undefined,
    providerAttachId: att.id,
  }));
}

export async function getThreadMessages(
  connectionId: string,
  conversationId: string,
): Promise<MailMessage[]> {
  const { accessToken } = await getAuthenticatedClientById(connectionId);
  const url =
    `${GRAPH_BASE}/me/messages?$filter=conversationId eq '${odataEscapeString(conversationId)}'` +
    `&$select=${MSG_SELECT}&$orderby=receivedDateTime asc&$top=50`;

  const res = await graphFetch<{ value?: GraphMessage[] }>(connectionId, accessToken, url);

  if (!res.ok) {
    throw new Error(`Graph getThreadMessages failed (${res.status}): ${JSON.stringify(res.data)}`);
  }

  return (res.data.value ?? []).map(parseGraphMessage);
}

export async function getCurrentDeltaLink(connectionId: string): Promise<string | null> {
  const result = await fetchDeltaMessages(connectionId, null);
  if (result.staleDeltaToken) return null;
  return result.nextDeltaLink;
}
