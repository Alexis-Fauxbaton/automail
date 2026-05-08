import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { verifyOAuthState } from "../lib/mail/oauth-state";
import { checkRateLimit, getClientIp } from "../lib/rate-limit";

/**
 * Public OAuth callback for Gmail / Zoho.
 *
 * The route is necessarily public (Google/Zoho redirect here from outside
 * our app's authenticated admin zone). Security rests entirely on:
 *   1. HMAC-signed `state` (see lib/mail/oauth-state.ts): guarantees the
 *      `shop` we bind tokens to was issued by this server. Without this,
 *      an attacker could forge a state for a victim shop and end up
 *      binding their own mailbox to that shop.
 *   2. State TTL (10 min): shrinks replay window if a state ever leaks.
 *   3. Provider-specific token exchange: the authorization code is
 *      single-use and verified by the provider against the redirect URI.
 */
function adminInboxUrl(shop: string, params: Record<string, string>): string {
  const storeName = shop.replace(".myshopify.com", "");
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const qs = new URLSearchParams(params).toString();
  return `https://admin.shopify.com/store/${storeName}/apps/${apiKey}/app/inbox?${qs}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function errorPage(title: string, detail: string): Response {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Auth error</title>
<style>body{font-family:sans-serif;padding:40px;max-width:600px;margin:auto}
h1{color:#b91c1c}pre{background:#f1f5f9;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-all}</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
<pre>${escapeHtml(detail)}</pre>
<p>Check the server logs for more details. You can close this tab and retry from the Shopify admin.</p>
</body></html>`;
  return new Response(html, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Public endpoint — Google/Zoho/Microsoft redirect users here. Cap per-IP
  // request volume so a hostile actor can't spray invalid `state` values to
  // grow our log surface or trip downstream provider quotas.
  const ip = getClientIp(request);
  const ipLimit = await checkRateLimit({
    key: ip,
    kind: "mail-auth",
    limit: 30,
    windowMs: 60_000,
  });
  if (!ipLimit.ok) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(ipLimit.resetMs / 1000)) },
    });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state") ?? "";

  console.log(`[mail-auth] incoming code=${!!code} state_len=${rawState.length} state_preview=${rawState.slice(0, 40)}`);

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const errorDesc = url.searchParams.get("error_description") ?? "";
    console.warn(`[mail-auth] OAuth provider error: ${oauthError} — ${errorDesc}`);
    if (errorDesc.includes("AADSTS65001") || oauthError === "consent_required") {
      return errorPage(
        "Microsoft admin consent required",
        "Your Microsoft 365 administrator must approve this app before you can connect it.\n\n" +
        "Ask your IT admin to visit the Microsoft Azure portal and grant consent for the 'Mail.Read' permission.\n\n" +
        "After admin approval, retry connecting from the Shopify admin.",
      );
    }
    return errorPage(`OAuth error: ${oauthError}`, errorDesc);
  }

  if (!code || !rawState) {
    console.warn("[mail-auth] missing code or state");
    return errorPage("Missing OAuth parameters", `code present: ${!!code}\nstate present: ${!!rawState}`);
  }

  const verified = verifyOAuthState(rawState);
  if (!verified) {
    console.warn("[mail-auth] rejected invalid OAuth state");
    // Log full state details server-side only — never expose decoded payload to browser.
    const debugInfo = `state length: ${rawState.length}\nstate preview: ${rawState.slice(0, 20)}...`;
    try {
      const dot = rawState.lastIndexOf(".");
      if (dot > 0) {
        const body = rawState.slice(0, dot);
        const pad = body.length % 4 === 0 ? "" : "=".repeat(4 - (body.length % 4));
        const decoded = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
        const payload = JSON.parse(decoded);
        const age = Date.now() - payload.t;
        console.warn(`[mail-auth] state rejected: age=${Math.round(age / 1000)}s payload=${decoded}`);
      }
    } catch { /* best-effort */ }
    return errorPage("Invalid OAuth state", debugInfo);
  }

  const { provider, shop } = verified;
  console.log(`[mail-auth] ${provider} callback for shop=${shop}`);

  try {
    if (provider === "zoho") {
      const { exchangeZohoCode, saveZohoConnection } = await import(
        "../lib/zoho/auth"
      );
      const tokens = await exchangeZohoCode(code);
      await saveZohoConnection(shop, tokens);
    } else if (provider === "outlook") {
      const { exchangeCodeForTokens, saveConnection } = await import(
        "../lib/outlook/auth"
      );
      const tokens = await exchangeCodeForTokens(code);
      await saveConnection(shop, tokens);
    } else {
      const { exchangeCodeForTokens, saveConnection } = await import(
        "../lib/gmail/auth"
      );
      const tokens = await exchangeCodeForTokens(code);
      await saveConnection(shop, tokens);
    }

    return redirect(adminInboxUrl(shop, { connected: "true" }));
  } catch (err) {
    const correlationId = Date.now().toString(36);
    console.error(`[mail-auth] ${provider} token exchange failed [ref=${correlationId}]:`, err);
    return errorPage(
      `${provider} token exchange failed`,
      `Token exchange failed. Reference: ${correlationId}`,
    );
  }
};
