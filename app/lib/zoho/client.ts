import prisma from "../../db.server";
import { getZohoAccessToken, getZohoApiDomain } from "./auth";
import type { MailAttachment, MailMessage, MailClient } from "../mail/types";

// Reuse cleanHtml and decodeHtmlEntities from gmail client
import { cleanHtml, decodeHtmlEntities } from "../gmail/client";

// Re-exported under the canonical name for clarity within this module.
const getApiDomain = getZohoApiDomain;

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
  // 15 s timeout protects against hung sockets — a single hung Zoho call
  // would otherwise block an auto-sync worker slot for the OS default
  // (often 120 s+) and starve other shops.
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
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
  const mailboxLower = (conn.email ?? "").trim().toLowerCase();

  // Cache folder IDs (fetched once per client creation). We do NOT cache
  // a `null` failure result — otherwise a transient Zoho hiccup at first
  // call freezes folders=null for the lifetime of the client and every
  // subsequent sync looks empty. The next call re-tries.
  let cachedFolders: ZohoFolders | null = null;
  async function getFolders(token: string): Promise<ZohoFolders> {
    if (cachedFolders) return cachedFolders;
    const fresh = await getZohoFolders(token, accountId);
    cachedFolders = fresh; // only set on success — throws propagate
    return fresh;
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

      // Folder probing is for finding which folder actually hosts the
      // message content; it CANNOT be used to infer direction. Zoho's
      // `/folders/{fid}/messages/{messageId}/details` endpoint does not
      // 404 when the message isn't in that folder — it returns the message
      // regardless — so a "try SENT first, fall back to INBOX" probe used
      // to mark EVERY message as SENT, which made the pipeline skip tier1/
      // tier2 classification on real customer emails.
      //
      // Direction is now derived from `fromAddress === mailboxLower` below,
      // with merchant-alias detection handled by `outgoing-detection.ts`.
      const folderCandidates = [
        folders.inbox,
        ...(folders.sent ? [folders.sent] : []),
      ];
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
      const rawHtml = contentData.data?.content ?? "";
      const htmlBody = rawHtml
        ? await embedZohoInlineImages(rawHtml, token, getApiDomain(), accountId, folderId, String(detail.messageId))
        : rawHtml;
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
        // Virtual "SENT" label is set based on the sender matching the
        // connected mailbox, NOT on the folder we happened to find the
        // message in (see comment above on folderCandidates). Alias-based
        // outgoing detection is handled downstream in outgoing-detection.ts.
        labelIds: (mailboxLower && fromAddress.toLowerCase() === mailboxLower) ? ["SENT"] : [],
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
              attachments: [],
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

const IMAGE_DISPLAY_RE = /src\s*=\s*"(\/mail\/ImageDisplay\?[^"]+)"/gi;
const MAX_INLINE_IMAGE_BYTES = 512 * 1024;

/**
 * Embeds Zoho inline images as data: URIs using the correct Zoho Mail API:
 *   1. GET attachmentinfo?includeInline=true  → list inline images with cid + fileName
 *   2. GET /inline?contentId={cid}&fileName={name} → binary image download
 *   3. Match each /mail/ImageDisplay?...&cid=X URL and replace with data: URI
 */
async function embedZohoInlineImages(
  html: string,
  accessToken: string,
  domain: string,
  accountId: string,
  folderId: string,
  messageId: string,
): Promise<string> {
  // Check if there are any ImageDisplay URLs to replace
  IMAGE_DISPLAY_RE.lastIndex = 0;
  if (!IMAGE_DISPLAY_RE.test(html)) return html;
  IMAGE_DISPLAY_RE.lastIndex = 0;

  // Log the first ImageDisplay URL for debugging CID matching
  const firstMatch = html.match(/src\s*=\s*"(\/mail\/ImageDisplay\?[^"]+)"/i);
  console.log(`[zoho/embedImages] first ImageDisplay URL: ${firstMatch?.[1]?.slice(0, 120) ?? "(none found)"}`);

  // Step 1: fetch inline image info
  let inlineItems: Array<{ cid: string; attachmentName: string; attachmentSize?: number }> = [];
  try {
    const infoUrl = `https://${domain}/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/attachmentinfo?includeInline=true`;
    const r = await fetch(infoUrl, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
    if (r.ok) {
      const json = await r.json() as {
        data?: {
          attachments?: Array<{ cid?: string; attachmentName?: string; attachmentSize?: number }>;
          inline?: Array<{ cid?: string; attachmentName?: string; attachmentSize?: number }>;
        };
      };
      const inlineArr = json.data?.inline ?? [];
      // Fallback: some Zoho responses put inline images in the attachments array (with a cid field)
      const attachWithCid = (json.data?.attachments ?? []).filter((a) => !!a.cid);
      const candidates = inlineArr.length > 0 ? inlineArr : attachWithCid;
      inlineItems = candidates
        .filter((a): a is { cid: string; attachmentName: string; attachmentSize?: number } =>
          !!a.cid && !!a.attachmentName)
        .map((a) => ({ cid: a.cid!, attachmentName: a.attachmentName!, attachmentSize: a.attachmentSize }));
      console.log(`[zoho/embedImages] attachmentinfo: inline=${inlineArr.length} attachWithCid=${attachWithCid.length} usable=${inlineItems.length} items=${JSON.stringify(inlineItems.map(i => ({ cid: i.cid, name: i.attachmentName })))}`);
    } else {
      const body = await r.text();
      console.warn(`[zoho/embedImages] attachmentinfo → ${r.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[zoho/embedImages] attachmentinfo error:`, String(err).slice(0, 100));
  }

  if (inlineItems.length === 0) return html;

  // Step 2: download each inline image and build cid → data: URI map.
  // Cap concurrency to 5 so a 100-image email doesn't fan out 100 parallel
  // fetches (Zoho returns 429 quickly, and Node's socket pool gets noisy).
  const cidToDataUri = new Map<string, string>();
  const INLINE_DOWNLOAD_CONCURRENCY = 5;
  for (let i = 0; i < inlineItems.length; i += INLINE_DOWNLOAD_CONCURRENCY) {
    const slice = inlineItems.slice(i, i + INLINE_DOWNLOAD_CONCURRENCY);
    await Promise.allSettled(slice.map(async (img) => {
    try {
      const cid = img.cid.replace(/^<|>$/g, "");
      // Zoho /inline endpoint uses the raw cid (with angle brackets stripped is fine)
      const downloadUrl = `https://${domain}/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/inline?contentId=${encodeURIComponent(cid)}&fileName=${encodeURIComponent(img.attachmentName)}`;
      console.log(`[zoho/embedImages] downloading cid=${cid} url=${downloadUrl.slice(downloadUrl.indexOf("/api/"))}`);
      const r = await fetch(downloadUrl, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
      const contentType = r.headers.get("Content-Type") ?? "";
      console.log(`[zoho/embedImages] inline download → ${r.status} type=${contentType} cid=${cid}`);
      if (!r.ok) {
        const t = await r.text();
        console.warn(`[zoho/embedImages] download body: ${t.slice(0, 200)}`);
        return;
      }
      // Zoho returns application/octet-stream even for images — infer from filename
      let mimeType = contentType.split(";")[0].trim();
      if (!mimeType.startsWith("image/")) {
        const ext = img.attachmentName.split(".").pop()?.toLowerCase() ?? "";
        const EXT_MAP: Record<string, string> = {
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
          gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
        };
        mimeType = EXT_MAP[ext] ?? "";
        if (!mimeType) {
          console.warn(`[zoho/embedImages] unknown image type for ${img.attachmentName}, skipping`);
          return;
        }
        console.log(`[zoho/embedImages] inferred mimeType=${mimeType} from filename`);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_INLINE_IMAGE_BYTES) return;
      cidToDataUri.set(cid, `data:${mimeType};base64,${buf.toString("base64")}`);
    } catch (err) {
      console.warn(`[zoho/embedImages] download error for cid=${img.cid}:`, String(err).slice(0, 100));
    }
    }));
  }

  console.log(`[zoho/embedImages] cidToDataUri size=${cidToDataUri.size} keys=[${Array.from(cidToDataUri.keys()).join(",")}]`);
  if (cidToDataUri.size === 0) return html;

  // Step 3: replace /mail/ImageDisplay?...&cid=X with data: URI
  let replacedCount = 0;
  const result = html.replace(IMAGE_DISPLAY_RE, (match, relUrl) => {
    try {
      const decoded = relUrl.replace(/&amp;/g, "&");
      const qs = decoded.includes("?") ? decoded.slice(decoded.indexOf("?") + 1) : decoded;
      const cid = new URLSearchParams(qs).get("cid") ?? "";
      console.log(`[zoho/embedImages] matching cid="${cid}" found=${cidToDataUri.has(cid)}`);
      const dataUri = cidToDataUri.get(cid);
      if (dataUri) { replacedCount++; return `src="${dataUri}"`; }
    } catch { /* keep original */ }
    return match;
  });
  console.log(`[zoho/embedImages] replaced ${replacedCount} ImageDisplay URLs`);
  return result;
}

/** Fetch attachment metadata for a Zoho message using attachmentinfo endpoint. */
async function fetchZohoAttachmentsMeta(
  accessToken: string,
  accountId: string,
  folderId: string,
  messageId: string,
): Promise<MailAttachment[]> {
  try {
    const domain = getApiDomain();
    const url = `https://${domain}/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/attachmentinfo?includeInline=true`;
    const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
    if (!r.ok) return [];
    const json = await r.json() as {
      data?: {
        // Some Zoho responses place inline images in the attachments array with a cid field.
        attachments?: Array<{ attachmentId?: string; attachmentName?: string; mimeType?: string; attachmentSize?: number; cid?: string }>;
        inline?: Array<{ attachmentId?: string; attachmentName?: string; mimeType?: string; attachmentSize?: number; cid?: string }>;
      };
    };
    const attachments = json.data?.attachments ?? [];
    const inline = json.data?.inline ?? [];
    return [
      ...attachments.map((a) => {
        const contentId = a.cid ? a.cid.replace(/^<|>$/g, "") : undefined;
        return {
          fileName: a.attachmentName ?? "attachment",
          mimeType: a.mimeType ?? "application/octet-stream",
          sizeBytes: a.attachmentSize ?? 0,
          contentId,
          disposition: (contentId ? "inline" : "attachment") as "inline" | "attachment",
          inlineData: undefined,
          providerAttachId: a.attachmentId,
          providerFolderId: folderId,
        };
      }),
      ...inline.map((a) => ({
        fileName: a.attachmentName ?? "attachment",
        mimeType: a.mimeType ?? "application/octet-stream",
        sizeBytes: a.attachmentSize ?? 0,
        contentId: a.cid ? a.cid.replace(/^<|>$/g, "") : undefined,
        disposition: "inline" as const,
        inlineData: undefined,
        providerAttachId: a.attachmentId,
        providerFolderId: folderId,
      })),
    ];
  } catch {
    return [];
  }
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
