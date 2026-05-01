import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getZohoAccessToken } from "../lib/zoho/auth";
import prisma from "../db.server";

/**
 * GET /api/zoho-image-debug?messageId=XXX
 *
 * Diagnostic: tries every known Zoho attachment path for a given message
 * and returns the result of each attempt. Use from browser console:
 *   fetch('/api/zoho-image-debug?messageId=1777572792841015100').then(r=>r.json()).then(console.log)
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const messageId = url.searchParams.get("messageId");
  if (!messageId) {
    return new Response(JSON.stringify({ error: "messageId param required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const conn = await prisma.mailConnection.findUnique({ where: { shop } });
  if (!conn || conn.provider !== "zoho") {
    return new Response(JSON.stringify({ error: "No Zoho connection" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const token = await getZohoAccessToken(shop);
  const domain = process.env.ZOHO_API_DOMAIN || "mail.zoho.eu";
  const accountId = conn.zohoAccountId ?? "";

  // Find folderId from DB (from an email with this externalMessageId)
  const dbEmail = await prisma.incomingEmail.findFirst({
    where: { shop, externalMessageId: messageId },
    select: { bodyHtml: true },
  });

  const results: Array<{ path: string; status: number; contentType: string; body: string }> = [];

  // Paths to test
  const inboxFolderId = "8222095000000002014"; // from logs
  const paths = [
    `/api/accounts/${accountId}/messages/${messageId}/attachments`,
    `/api/accounts/${accountId}/folders/${inboxFolderId}/messages/${messageId}/attachments`,
    `/api/accounts/${accountId}/messages/${messageId}/attachments/1`,
    `/api/accounts/${accountId}/folders/${inboxFolderId}/messages/${messageId}/attachments/1`,
  ];

  for (const path of paths) {
    const fullUrl = `https://${domain}${path}`;
    try {
      const res = await fetch(fullUrl, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();
      results.push({ path, status: res.status, contentType, body: body.slice(0, 300) });
    } catch (err) {
      results.push({ path, status: 0, contentType: "", body: String(err) });
    }
  }

  return new Response(JSON.stringify({
    shop,
    accountId,
    domain,
    messageId,
    hasStoredHtml: !!dbEmail?.bodyHtml,
    htmlSnippet: dbEmail?.bodyHtml?.slice(0, 200) ?? null,
    results,
  }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}
