import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getGmailServiceByConnection } from "../lib/gmail/client";
import { getZohoAccessTokenByConnection } from "../lib/zoho/auth";
import { listZohoFoldersByConnection } from "../lib/zoho/client";

const SAFE_INLINE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

function safeMimeType(mime: string): { contentType: string; forceDownload: boolean } {
  const normalized = mime.toLowerCase().split(";")[0].trim();
  if (SAFE_INLINE_MIME_TYPES.has(normalized)) {
    return { contentType: normalized, forceDownload: false };
  }
  return { contentType: "application/octet-stream", forceDownload: true };
}

/**
 * GET /api/incoming-attachment?id=<attachmentId>
 *
 * Serves an attachment from an incoming email, either from the stored
 * inlineData or by proxying the request to the provider (Gmail / Zoho).
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const attachmentId = url.searchParams.get("id");
  if (!attachmentId) {
    return new Response("Missing id", { status: 400 });
  }

  const attachment = await prisma.incomingEmailAttachment.findUnique({
    where: { id: attachmentId },
    select: {
      id: true,
      shop: true,
      emailId: true,
      fileName: true,
      mimeType: true,
      disposition: true,
      inlineData: true,
      provider: true,
      providerMsgId: true,
      providerAttachId: true,
      providerFolderId: true,
      // Join through the parent email to get the mailConnectionId for routing
      email: { select: { mailConnectionId: true } },
    },
  });

  if (!attachment || attachment.shop !== shop) {
    return new Response("Not found", { status: 404 });
  }

  const safeFileName = encodeURIComponent(attachment.fileName);
  const cd = attachment.disposition === "inline"
    ? `inline; filename="${safeFileName}"`
    : `attachment; filename="${safeFileName}"`;

  // Fast path: serve stored inline data
  if (attachment.inlineData) {
    const buffer = Buffer.from(attachment.inlineData, "base64");
    const { contentType, forceDownload } = safeMimeType(attachment.mimeType);
    const safeCd = (forceDownload || contentType === "image/svg+xml") ? `attachment; filename="${safeFileName}"` : cd;
    return new Response(buffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buffer.length),
        "Content-Disposition": safeCd,
        "Cache-Control": "private, max-age=604800",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // Proxy path: fetch from provider
  if (!attachment.providerAttachId) {
    return new Response("No attachment data available", { status: 404 });
  }

  try {
    if (attachment.provider === "gmail") {
      const mailConnectionId = attachment.email?.mailConnectionId ?? null;
      const gmailConn = mailConnectionId
        ? await prisma.mailConnection.findUnique({ where: { id: mailConnectionId } })
        : await prisma.mailConnection.findFirst({ where: { shop, provider: "gmail" } });
      if (!gmailConn) return new Response("No Gmail connection", { status: 404 });
      const gmail = await getGmailServiceByConnection(gmailConn);
      const res = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: attachment.providerMsgId,
        id: attachment.providerAttachId,
      });
      const data = res.data.data;
      if (!data) return new Response("Empty attachment", { status: 502 });
      const buffer = Buffer.from(data, "base64url");
      const { contentType, forceDownload } = safeMimeType(attachment.mimeType);
      const safeCd = (forceDownload || contentType === "image/svg+xml") ? `attachment; filename="${safeFileName}"` : cd;
      return new Response(buffer, {
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(buffer.length),
          "Content-Disposition": safeCd,
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (attachment.provider === "zoho") {
      const mailConnectionId = attachment.email?.mailConnectionId ?? null;
      const conn = mailConnectionId
        ? await prisma.mailConnection.findUnique({ where: { id: mailConnectionId } })
        : await prisma.mailConnection.findFirst({ where: { shop, provider: "zoho" } });
      if (!conn?.zohoAccountId) return new Response("No Zoho connection", { status: 404 });
      const token = await getZohoAccessTokenByConnection(conn);
      const zohoDomain = process.env.ZOHO_API_DOMAIN || "mail.zoho.com";

      // Resolve folderId — stored for new records; look it up for legacy ones.
      let folderId = attachment.providerFolderId;
      if (!folderId) {
        const folders = await listZohoFoldersByConnection(conn);
        const inbox = folders.find((f) => f.folderType === "Inbox");
        const sent = folders.find((f) => f.folderType === "Sent");
        folderId = inbox?.folderId ?? sent?.folderId ?? null;
        if (folderId) {
          // Backfill so we don't pay this lookup cost again
          await prisma.incomingEmailAttachment.update({
            where: { id: attachment.id },
            data: { providerFolderId: folderId },
          }).catch(() => { /* non-critical */ });
        }
      }
      if (!folderId) return new Response("Cannot resolve Zoho folder ID", { status: 502 });

      const downloadUrl = `https://${zohoDomain}/api/accounts/${conn.zohoAccountId}/folders/${folderId}/messages/${attachment.providerMsgId}/attachments/${attachment.providerAttachId}`;
      const proxyRes = await fetch(downloadUrl, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      if (!proxyRes.ok) return new Response("Provider error", { status: 502 });
      const buffer = Buffer.from(await proxyRes.arrayBuffer());
      const { contentType, forceDownload } = safeMimeType(attachment.mimeType);
      const safeCd = (forceDownload || contentType === "image/svg+xml") ? `attachment; filename="${safeFileName}"` : cd;
      return new Response(buffer, {
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(buffer.byteLength),
          "Content-Disposition": safeCd,
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return new Response("Unsupported provider", { status: 400 });
  } catch (err) {
    console.error("[api.incoming-attachment] proxy error:", err);
    return new Response("Failed to fetch attachment", { status: 502 });
  }
}
