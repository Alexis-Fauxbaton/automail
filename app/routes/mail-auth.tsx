import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { verifyOAuthState } from "../lib/mail/oauth-state";

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

function errorPage(title: string, detail: string): Response {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Auth error</title>
<style>body{font-family:sans-serif;padding:40px;max-width:600px;margin:auto}
h1{color:#b91c1c}pre{background:#f1f5f9;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-all}</style>
</head><body>
<h1>${title}</h1>
<pre>${detail}</pre>
<p>Check the server logs for more details. You can close this tab and retry from the Shopify admin.</p>
</body></html>`;
  return new Response(html, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state") ?? "";

  console.log(`[mail-auth] incoming code=${!!code} state_len=${rawState.length} state_preview=${rawState.slice(0, 40)}`);

  if (!code || !rawState) {
    console.warn("[mail-auth] missing code or state");
    return errorPage("Missing OAuth parameters", `code present: ${!!code}\nstate present: ${!!rawState}`);
  }

  const verified = verifyOAuthState(rawState);
  if (!verified) {
    console.warn("[mail-auth] rejected invalid OAuth state");
    // Try to decode payload for debugging (ignore signature)
    let debugInfo = `state length: ${rawState.length}\nstate preview: ${rawState.slice(0, 60)}`;
    try {
      const dot = rawState.lastIndexOf(".");
      if (dot > 0) {
        const body = rawState.slice(0, dot);
        const pad = body.length % 4 === 0 ? "" : "=".repeat(4 - (body.length % 4));
        const decoded = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
        const payload = JSON.parse(decoded);
        const age = Date.now() - payload.t;
        debugInfo += `\ndecoded payload: ${decoded}\nage: ${Math.round(age / 1000)}s (TTL: 600s)`;
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
    } else {
      const { exchangeCodeForTokens, saveConnection } = await import(
        "../lib/gmail/auth"
      );
      const tokens = await exchangeCodeForTokens(code);
      await saveConnection(shop, tokens);
    }

    return redirect(adminInboxUrl(shop, { connected: "true" }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mail-auth] ${provider} token exchange failed:`, err);
    return errorPage(
      `${provider} token exchange failed`,
      msg,
    );
  }
};
