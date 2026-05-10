import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getZohoAccessToken } from "../lib/zoho/auth";
import { checkRateLimit } from "../lib/rate-limit";

// Bound the Zoho proxy: a single inbox view loads dozens of inline images,
// so this is generous on purpose. Caps abusive bursts from a compromised
// session that could otherwise spray Zoho with requests on the shop's quota.
const RATE_LIMIT_PER_SHOP_PER_MIN = 300;

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
 * GET /api/zoho-inline?na=...&nmsgId=...&f=...&cid=...&mode=...
 *
 * Proxies Zoho's internal /mail/ImageDisplay URLs using the shop's Zoho
 * OAuth token. Called from the email HTML iframe when inline images reference
 * Zoho's proprietary URL format instead of cid: URIs.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const limit = await checkRateLimit({
    key: shop,
    kind: "zoho-inline",
    limit: RATE_LIMIT_PER_SHOP_PER_MIN,
    windowMs: 60_000,
  });
  if (!limit.ok) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": Math.ceil(limit.resetMs / 1000).toString() },
    });
  }

  const url = new URL(request.url);
  const na = url.searchParams.get("na");
  const nmsgId = url.searchParams.get("nmsgId");
  const f = url.searchParams.get("f");
  const cid = url.searchParams.get("cid");
  const mode = url.searchParams.get("mode") ?? "inline";

  if (!na || !nmsgId || !f) {
    return new Response("Missing params", { status: 400 });
  }

  // Verify the account ID matches the shop's connected Zoho account.
  const conn = await prisma.mailConnection.findUnique({ where: { shop } });
  if (!conn?.zohoAccountId || conn.zohoAccountId !== na) {
    return new Response("Unauthorized", { status: 403 });
  }

  try {
    const token = await getZohoAccessToken(shop);
    const domain = process.env.ZOHO_API_DOMAIN || "mail.zoho.com";

    // Reconstruct the Zoho ImageDisplay URL and proxy it with OAuth token.
    const params = new URLSearchParams({ na, nmsgId, f, mode });
    if (cid) params.set("cid", cid);
    const imageUrl = `https://${domain}/mail/ImageDisplay?${params}`;

    // 8 s timeout protects the Node thread if Zoho hangs.
    const res = await fetch(imageUrl, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.error(`[api.zoho-inline] Zoho ${res.status} for ${imageUrl}`);
      return new Response("Image not available", { status: 502 });
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const rawContentType = res.headers.get("Content-Type") || "image/jpeg";
    const { contentType, forceDownload } = safeMimeType(rawContentType);

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(buffer.byteLength),
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    };

    if (forceDownload || contentType === "image/svg+xml") {
      headers["Content-Disposition"] = "attachment";
    }

    return new Response(buffer, { headers });
  } catch (err) {
    console.error("[api.zoho-inline] error:", err);
    return new Response("Failed to fetch image", { status: 502 });
  }
}
