import { getAuthenticatedClient } from "./auth";
import { cleanHtml } from "../gmail/client";
import type { MailMessage, MailAttachment } from "../mail/types";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const MSG_SELECT =
  "id,conversationId,subject,receivedDateTime,from,body,internetMessageHeaders,internetMessageId,categories,inferenceClassification,hasAttachments";
const INLINE_EMBED_LIMIT = 200 * 1024; // 200 KB

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
  accessToken: string,
  url: string,
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: data as T };
}

export async function fetchDeltaMessages(
  shop: string,
  deltaLink: string | null,
): Promise<DeltaResult> {
  const { accessToken } = await getAuthenticatedClient(shop);

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
    }>(accessToken, url);

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
  shop: string,
  afterDate: Date,
): Promise<MailMessage[]> {
  const { accessToken } = await getAuthenticatedClient(shop);
  const isoDate = afterDate.toISOString();
  let url =
    `${GRAPH_BASE}/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${isoDate}` +
    `&$select=${MSG_SELECT}&$top=50&$orderby=receivedDateTime asc`;

  const messages: MailMessage[] = [];

  while (url) {
    const res = await graphFetch<{
      value?: GraphMessage[];
      "@odata.nextLink"?: string;
    }>(accessToken, url);

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

export async function getMessageById(shop: string, messageId: string): Promise<MailMessage> {
  const { accessToken } = await getAuthenticatedClient(shop);
  const url = `${GRAPH_BASE}/me/messages/${messageId}?$select=${MSG_SELECT}`;
  const res = await graphFetch<GraphMessage>(accessToken, url);

  if (!res.ok) {
    throw new Error(`Graph getMessage failed (${res.status}): ${JSON.stringify(res.data)}`);
  }

  const msg = parseGraphMessage(res.data);

  if (res.data.hasAttachments) {
    msg.attachments = await fetchAttachments(accessToken, messageId);
  }

  return msg;
}

async function fetchAttachments(
  accessToken: string,
  messageId: string,
): Promise<MailAttachment[]> {
  const url = `${GRAPH_BASE}/me/messages/${messageId}/attachments?$select=id,name,contentType,size,contentId,isInline,contentBytes`;
  const res = await graphFetch<{ value?: GraphAttachment[] }>(accessToken, url);

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
  shop: string,
  conversationId: string,
): Promise<MailMessage[]> {
  const { accessToken } = await getAuthenticatedClient(shop);
  const url =
    `${GRAPH_BASE}/me/messages?$filter=conversationId eq '${encodeURIComponent(conversationId)}'` +
    `&$select=${MSG_SELECT}&$orderby=receivedDateTime asc&$top=50`;

  const res = await graphFetch<{ value?: GraphMessage[] }>(accessToken, url);

  if (!res.ok) {
    throw new Error(`Graph getThreadMessages failed (${res.status}): ${JSON.stringify(res.data)}`);
  }

  return (res.data.value ?? []).map(parseGraphMessage);
}

export async function getCurrentDeltaLink(shop: string): Promise<string | null> {
  const result = await fetchDeltaMessages(shop, null);
  if (result.staleDeltaToken) return null;
  return result.nextDeltaLink;
}
