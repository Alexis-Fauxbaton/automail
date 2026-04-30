import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getGmailService } from "../lib/gmail/client";
import { getZohoAccessToken } from "../lib/zoho/auth";

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
    return new Response(buffer, {
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Length": String(buffer.length),
        "Content-Disposition": cd,
        "Cache-Control": "private, max-age=604800",
      },
    });
  }

  // Proxy path: fetch from provider
  if (!attachment.providerAttachId) {
    return new Response("No attachment data available", { status: 404 });
  }

  try {
    if (attachment.provider === "gmail") {
      const gmail = await getGmailService(shop);
      const res = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: attachment.providerMsgId,
        id: attachment.providerAttachId,
      });
      const data = res.data.data;
      if (!data) return new Response("Empty attachment", { status: 502 });
      const buffer = Buffer.from(data, "base64url");
      return new Response(buffer, {
        headers: {
          "Content-Type": attachment.mimeType,
          "Content-Length": String(buffer.length),
          "Content-Disposition": cd,
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    if (attachment.provider === "zoho") {
      const conn = await prisma.mailConnection.findUnique({ where: { shop } });
      if (!conn?.zohoAccountId) return new Response("No Zoho connection", { status: 404 });
      const token = await getZohoAccessToken(shop);
      // Zoho attachment download endpoint (domain from env, default mail.zoho.com)
      const zohoDomain = process.env.ZOHO_API_DOMAIN || "mail.zoho.com";
      const downloadUrl = `https://${zohoDomain}/api/accounts/${conn.zohoAccountId}/messages/${attachment.providerMsgId}/attachments/${attachment.providerAttachId}`;
      const proxyRes = await fetch(downloadUrl, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      if (!proxyRes.ok) return new Response("Provider error", { status: 502 });
      const buffer = Buffer.from(await proxyRes.arrayBuffer());
      return new Response(buffer, {
        headers: {
          "Content-Type": attachment.mimeType,
          "Content-Length": String(buffer.byteLength),
          "Content-Disposition": cd,
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    return new Response("Unsupported provider", { status: 400 });
  } catch (err) {
    console.error("[api.incoming-attachment] proxy error:", err);
    return new Response("Failed to fetch attachment", { status: 502 });
  }
}
