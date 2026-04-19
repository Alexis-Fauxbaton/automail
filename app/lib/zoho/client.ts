import prisma from "../../db.server";
import { getZohoAccessToken } from "./auth";
import type { MailMessage, MailClient } from "../mail/types";

// Reuse cleanHtml from gmail client
import { cleanHtml } from "../gmail/client";

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

/**
 * Find the Inbox folder ID for a Zoho account.
 */
async function getInboxFolderId(
  accessToken: string,
  accountId: string,
): Promise<string> {
  const data = (await zohoFetch(
    accessToken,
    `/api/accounts/${accountId}/folders`,
  )) as { data?: Array<{ folderId: string; folderName: string }> };
  const inbox = data.data?.find(
    (f) => f.folderName.toLowerCase() === "inbox",
  );
  if (!inbox) throw new Error("Inbox folder not found in Zoho");
  return inbox.folderId;
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

  // Cache inbox folder ID (fetched once per client creation)
  let inboxFolderId: string | null = null;
  async function getInbox(token: string): Promise<string> {
    if (!inboxFolderId) {
      inboxFolderId = await getInboxFolderId(token, accountId);
    }
    return inboxFolderId;
  }

  return {
    async listRecentMessages(opts) {
      const token = await getZohoAccessToken(shop);
      const folderId = await getInbox(token);

      const ids: string[] = [];
      const maxResults = opts.maxResults ?? 500;
      let start = 1;
      const limit = 200;

      do {
        const data = (await zohoFetch(
          token,
          `/api/accounts/${accountId}/messages/view`,
          {
            folderId,
            sortBy: "date",
            start: String(start),
            limit: String(Math.min(limit, maxResults - ids.length)),
          },
        )) as { data?: ZohoListItem[] };

        const items = data.data ?? [];
        if (items.length === 0) break;

        for (const item of items) {
          // Filter by date if needed
          if (opts.afterDate) {
            const received = parseInt(item.receivedTime, 10);
            if (received < opts.afterDate.getTime()) {
              // Messages are sorted by date desc, so we can stop
              return ids;
            }
          }
          ids.push(item.messageId);
        }

        start += items.length;
      } while (ids.length < maxResults);

      return ids;
    },

    async getMessage(messageId) {
      const token = await getZohoAccessToken(shop);
      const folderId = await getInbox(token);

      // Fetch message details
      const detailData = (await zohoFetch(
        token,
        `/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/details`,
      )) as {
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
      const fromName = extractName(detail.fromAddress) || detail.sender || "";

      return {
        id: String(detail.messageId),
        threadId: String(detail.threadId ?? detail.messageId),
        from: fromAddress,
        fromName,
        subject: detail.subject || "(no subject)",
        bodyText,
        snippet: detail.summary || bodyText.slice(0, 200),
        receivedAt: new Date(parseInt(detail.receivedTime, 10)),
        labelIds: [], // Zoho doesn't have Gmail-style labels
        headers: {}, // We don't get raw headers from Zoho API
      } satisfies MailMessage;
    },

    async listNewMessages(cursor) {
      // Zoho doesn't have a History API. We use the cursor as a timestamp.
      const afterDate = cursor ? new Date(parseInt(cursor, 10)) : undefined;
      const messageIds = await this.listRecentMessages({
        afterDate,
        maxResults: 500,
      });
      return {
        messageIds,
        latestCursor: String(Date.now()),
      };
    },

    async getSyncCursor() {
      // Return current timestamp as cursor
      return String(Date.now());
    },
  };
}

// --- Helpers ---

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
