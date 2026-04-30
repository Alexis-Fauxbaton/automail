import prisma from "../../db.server";
import { getZohoAccessToken } from "./auth";
import type { MailAttachment, MailMessage, MailClient } from "../mail/types";

// Reuse cleanHtml and decodeHtmlEntities from gmail client
import { cleanHtml, decodeHtmlEntities } from "../gmail/client";

function getApiDomain(): string {
  return process.env.ZOHO_API_DOMAIN || "mail.zoho.com";
}

async function zohoFetch(
  accessToken: string,
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const domain = getApiDomain();
  const url = new URL(`https://${domain}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zoho API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

interface ZohoListItem {
  messageId: string;
  threadId?: string;
  fromAddress: string;
  sender: string;
  subject: string;
  summary: string;
  receivedTime: string; // epoch ms
  folderId: string;
}

interface ZohoFolders {
  inbox: string;
  sent: string | null;
}

/**
 * Raw list of folders (for diagnostics). Exposes name + type + id.
 */
export async function listZohoFoldersRaw(
  shop: string,
): Promise<Array<{ folderId: string; folderName: string; folderType: string }>> {
  const conn = await prisma.mailConnection.findUnique({ where: { shop } });
  if (!conn || conn.provider !== "zoho" || !conn.zohoAccountId) {
    throw new Error("No Zoho connection for this shop");
  }
  const token = await getZohoAccessToken(shop);
  const data = (await zohoFetch(
    token,
    `/api/accounts/${conn.zohoAccountId}/folders`,
  )) as {
    data?: Array<{ folderId: string; folderName: string; folderType?: string }>;
  };
  return (data.data ?? []).map((f) => ({
    folderId: f.folderId,
    folderName: f.folderName,
    folderType: f.folderType ?? "",
  }));
}

/**
 * Fetch Inbox (and Sent) folder IDs for a Zoho account.
 * Zoho returns a `folderType` field (Inbox, Sent, Drafts, Trash, Spam) which
 * is language-independent; we prefer that over name-matching.
 */
async function getZohoFolders(
  accessToken: string,
  accountId: string,
): Promise<ZohoFolders> {
  const data = (await zohoFetch(
    accessToken,
    `/api/accounts/${accountId}/folders`,
  )) as {
    data?: Array<{ folderId: string; folderName: string; folderType?: string }>;
  };
  const folders = data.data ?? [];
  console.log(
    "[zoho] Folders discovered:",
    folders.map((f) => `${f.folderName} [type=${f.folderType}] id=${f.folderId}`).join(" | "),
  );

  const byType = (type: string) =>
    folders.find((f) => f.folderType?.toLowerCase() === type.toLowerCase());

  const SENT_RE = /sent|envoy|gesend|invia|verzond/i;
  const inbox =
    byType("Inbox") ?? folders.find((f) => f.folderName.toLowerCase() === "inbox");
  const sent =
    byType("Sent") ?? folders.find((f) => SENT_RE.test(f.folderName));

  if (!inbox) {
    throw new Error(
      `Inbox folder not found in Zoho. Available: ${folders
        .map((f) => `${f.folderName}(${f.folderType ?? "?"})`)
        .join(", ")}`,
    );
  }
  console.log(
    `[zoho] Inbox folder: ${inbox.folderName} (${inbox.folderId}); Sent folder: ${sent?.folderName ?? "NOT FOUND"} (${sent?.folderId ?? "-"})`,
  );
  return { inbox: inbox.folderId, sent: sent?.folderId ?? null };
}

/**
 * Create a ZohoMailClient implementing MailClient interface.
 */
export async function createZohoClient(shop: string): Promise<MailClient> {
  const conn = await prisma.mailConnection.findUnique({ where: { shop } });
  if (!conn || conn.provider !== "zoho" || !conn.zohoAccountId) {
    throw new Error("No Zoho connection for this shop");
  }

  const accountId = conn.zohoAccountId;

  // Cache folder IDs (fetched once per client creation)
  let cachedFolders: ZohoFolders | null = null;
  async function getFolders(token: string): Promise<ZohoFolders> {
    if (!cachedFolders) {
      cachedFolders = await getZohoFolders(token, accountId);
    }
    return cachedFolders;
  }
  async function getInbox(token: string): Promise<string> {
    return (await getFolders(token)).inbox;
  }

  return {
    async listRecentMessages(opts) {
      const token = await getZohoAccessToken(shop);
      const folders = await getFolders(token);

      const idSet = new Set<string>();
      const maxResults = opts.maxResults ?? 500;

      // Fetch from both Inbox and Sent folders, each with its OWN budget.
      // Using a shared budget would starve the Sent folder when Inbox is busier.
      const folderIds = [folders.inbox, ...(folders.sent ? [folders.sent] : [])];
      const perFolderMax = Math.max(50, Math.ceil(maxResults / folderIds.length));

      for (const folderId of folderIds) {
        const isSent = folderId === folders.sent;
        const folderLabel = isSent ? "SENT" : "INBOX";
        const idsBefore = idSet.size;
        let collectedInFolder = 0;
        let start = 1;
        const pageSize = 200;

        do {
          const remainingInFolder = perFolderMax - collectedInFolder;
          if (remainingInFolder <= 0) break;

          const data = (await zohoFetch(
            token,
            `/api/accounts/${accountId}/messages/view`,
            {
              folderId,
              sortBy: "date", // Zoho default is DESC (newest first)
              start: String(start),
              limit: String(Math.min(pageSize, remainingInFolder)),
            },
          )) as { data?: ZohoListItem[] };

          const items = data.data ?? [];
          console.log(`[zoho/listRecentMessages] folder=${folderLabel} start=${start} got=${items.length}`);
          if (items.length === 0) break;

          let stopped = false;
          for (const item of items) {
            if (opts.afterDate) {
              const received = parseInt(item.receivedTime, 10);
              if (received < opts.afterDate.getTime()) {
                stopped = true;
                break;
              }
            }
            idSet.add(item.messageId);
            collectedInFolder++;
          }
          if (stopped) break;

          start += items.length;
        } while (collectedInFolder < perFolderMax);

        console.log(`[zoho/listRecentMessages] folder=${folderLabel} collected ${idSet.size - idsBefore} ids`);
      }

      return Array.from(idSet);
    },

    async getMessage(messageId) {
      const token = await getZohoAccessToken(shop);
      const folders = await getFolders(token);

      // Try inbox first, then sent folder to find the message's actual folder.
      const folderCandidates = [folders.inbox, ...(folders.sent ? [folders.sent] : [])];
      let folderId = folders.inbox;
      let detailRaw: unknown = null;
      for (const fid of folderCandidates) {
        try {
          detailRaw = await zohoFetch(
            token,
            `/api/accounts/${accountId}/folders/${fid}/messages/${messageId}/details`,
          );
          folderId = fid;
          break;
        } catch {
          // try next folder
        }
      }
      if (!detailRaw) throw new Error(`Zoho message ${messageId} not found in any folder`);

      const detailData = detailRaw as {
        data?: {
          messageId: string;
          threadId?: string;
          fromAddress: string;
          sender: string;
          subject: string;
          summary: string;
          receivedTime: string;
          toAddress?: string;
          ccAddress?: string;
        };
      };
      const detail = detailData.data;
      if (!detail) throw new Error(`Zoho message ${messageId} not found`);

      // Fetch message content (HTML body)
      const contentData = (await zohoFetch(
        token,
        `/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`,
        { includeBlockContent: "true" },
      )) as { data?: { content: string } };
      const htmlBody = contentData.data?.content ?? "";
      const bodyText = cleanHtml(htmlBody);

      // Parse sender
      const fromAddress = extractEmail(detail.fromAddress);
      const fromName = decodeHtmlEntities(extractName(detail.fromAddress) || detail.sender || "");

      // Best-effort: fetch attachment metadata for this message
      const zohoAttachments = await fetchZohoAttachmentsMeta(
        token, accountId, folderId, String(detail.messageId),
      ).catch(() => []);

      return {
        id: String(detail.messageId),
        threadId: String(detail.threadId ?? detail.messageId),
        from: fromAddress,
        fromName,
        subject: decodeHtmlEntities(detail.subject || "(no subject)"),
        bodyText,
        bodyHtml: htmlBody || undefined,
        snippet: detail.summary ? decodeHtmlEntities(detail.summary) : bodyText.slice(0, 200),
        receivedAt: new Date(parseInt(detail.receivedTime, 10)),
        // Use a virtual "SENT" label when the message lives in the Sent folder
        // so the pipeline can reliably detect outgoing messages on Zoho too.
        labelIds: (folders.sent && folderId === folders.sent) ? ["SENT"] : [],
        headers: {},
        attachments: zohoAttachments,
      } satisfies MailMessage;
    },

    async listNewMessages(cursor) {
      // Zoho doesn't have a History API. We use the cursor as a timestamp.
      //
      // IMPORTANT: capture the new cursor BEFORE the API call, with a 2-minute
      // safety margin. This prevents a race condition where a message arrives
      // during the API round-trip: its receivedTime would be older than a
      // post-call cursor, causing it to be permanently skipped on all future
      // syncs (afterDate > receivedTime). The 2-minute margin also absorbs
      // any Zoho indexing delay.
      const nextCursorTs = Date.now() - 2 * 60_000;

      const afterDate = cursor ? new Date(parseInt(cursor, 10)) : undefined;
      const messageIds = await this.listRecentMessages({
        afterDate,
        maxResults: 500,
      });
      return {
        messageIds,
        latestCursor: String(nextCursorTs),
      };
    },

    async getSyncCursor() {
      // Return current timestamp minus a 2-minute margin as cursor.
      // Same rationale as listNewMessages: avoids missing messages that
      // arrive just before or during the Zoho API call window.
      return String(Date.now() - 2 * 60_000);
    },

    async getThreadMessages(threadId) {
      // Zoho doesn't have a unified "get all messages in thread" endpoint that's
      // reliably documented across plans. Best-effort: try the threads endpoint;
      // if it fails, return empty and let the pipeline fall back to DB messages.
      try {
        const token = await getZohoAccessToken(shop);
        const data = (await zohoFetch(
          token,
          `/api/accounts/${accountId}/messages/${threadId}/threads`,
        )) as {
          data?: Array<{
            messageId: string;
            threadId?: string;
            fromAddress: string;
            sender: string;
            subject: string;
            summary: string;
            receivedTime: string;
            folderId?: string;
          }>;
        };
        const items = data.data ?? [];
        if (items.length === 0) return [];

        const messages: MailMessage[] = [];
        for (const item of items) {
          try {
            // Fetch content for each thread message
            const folderId = item.folderId ?? (await getInbox(token));
            const contentData = (await zohoFetch(
              token,
              `/api/accounts/${accountId}/folders/${folderId}/messages/${item.messageId}/content`,
              { includeBlockContent: "true" },
            )) as { data?: { content: string } };
            const htmlBody = contentData.data?.content ?? "";
            const bodyText = cleanHtml(htmlBody);
            messages.push({
              id: String(item.messageId),
              threadId: String(item.threadId ?? threadId),
              from: extractEmail(item.fromAddress),
              fromName: decodeHtmlEntities(extractName(item.fromAddress) || item.sender || ""),
              subject: decodeHtmlEntities(item.subject || "(no subject)"),
              bodyText,
              snippet: item.summary ? decodeHtmlEntities(item.summary) : bodyText.slice(0, 200),
              receivedAt: new Date(parseInt(item.receivedTime, 10)),
              labelIds: [],
              headers: {},
            });
          } catch (err) {
            console.error(`[zoho] Failed to fetch content for ${item.messageId}:`, err);
          }
        }
        messages.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
        return messages;
      } catch (err) {
        console.error("[zoho] getThreadMessages failed, falling back:", err);
        return [];
      }
    },
  };
}

// --- Helpers ---

/** Fetch attachment metadata for a Zoho message (best-effort, returns [] on error). */
async function fetchZohoAttachmentsMeta(
  accessToken: string,
  accountId: string,
  _folderId: string,
  messageId: string,
): Promise<MailAttachment[]> {
  // Zoho attachment list endpoint does NOT require folderId (unlike message detail).
  // The download endpoint also uses /messages/{id}/attachments without folderId.
  let data: unknown;
  try {
    data = await zohoFetch(
      accessToken,
      `/api/accounts/${accountId}/messages/${messageId}/attachments`,
    );
  } catch (err) {
    console.error(`[zoho/attachments] API error for message=${messageId}:`, err);
    throw err;
  }
  const typed = data as {
    data?: Array<{
      attachmentId?: string;
      fileName?: string;
      mimeType?: string;
      size?: number;
      contentId?: string;
      isInline?: boolean;
    }>;
  };
  const items = typed.data ?? [];
  console.log(`[zoho/attachments] message=${messageId} count=${items.length}`, items.map(a => `${a.fileName}(inline=${a.isInline},id=${a.attachmentId})`).join(", "));
  return items.map((att) => ({
    fileName: att.fileName ?? "attachment",
    mimeType: att.mimeType ?? "application/octet-stream",
    sizeBytes: att.size ?? 0,
    contentId: att.contentId ? att.contentId.replace(/^<|>$/g, "") : undefined,
    disposition: att.isInline ? ("inline" as const) : ("attachment" as const),
    inlineData: undefined,
    providerAttachId: att.attachmentId,
  }));
}

function extractEmail(addr: string): string {
  const match = addr.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase();
  if (addr.includes("@")) return addr.trim().toLowerCase();
  return addr;
}

function extractName(addr: string): string {
  const match = addr.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  return "";
}
