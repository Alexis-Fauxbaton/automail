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
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state") ?? "";

  if (!code || !rawState) {
    return redirect("/app/inbox?error=missing_params");
  }

  const verified = verifyOAuthState(rawState);
  if (!verified) {
    console.warn("[mail-auth] rejected invalid OAuth state");
    return redirect("/app/inbox?error=invalid_state");
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

    const storeName = shop.replace(".myshopify.com", "");
    const apiKey = process.env.SHOPIFY_API_KEY || "";
    const adminUrl = `https://admin.shopify.com/store/${storeName}/apps/${apiKey}/app/inbox?connected=true`;
    return redirect(adminUrl);
  } catch (err) {
    console.error(`[mail-auth] ${provider} token exchange failed:`, err);
    return redirect("/app/inbox?error=auth_failed");
  }
};
