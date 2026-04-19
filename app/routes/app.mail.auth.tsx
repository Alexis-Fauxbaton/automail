import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { exchangeCodeForTokens, saveConnection } from "../lib/gmail/auth";
import { exchangeZohoCode, saveZohoConnection } from "../lib/zoho/auth";

/**
 * Unified OAuth callback route for Gmail and Zoho.
 * The `state` parameter carries "provider:shop" (e.g. "zoho:myshop.myshopify.com").
 * For backwards compatibility, a bare shop domain (no prefix) is treated as Gmail.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state") ?? "";

  if (!code || !rawState) {
    return redirect("/app/inbox?error=missing_params");
  }

  // Parse state: "zoho:shop.myshopify.com" or just "shop.myshopify.com" (legacy Gmail)
  let provider: "gmail" | "zoho" = "gmail";
  let shop = rawState;
  if (rawState.startsWith("zoho:")) {
    provider = "zoho";
    shop = rawState.slice(5);
  } else if (rawState.startsWith("gmail:")) {
    provider = "gmail";
    shop = rawState.slice(6);
  }

  try {
    if (provider === "zoho") {
      const tokens = await exchangeZohoCode(code);
      await saveZohoConnection(shop, tokens);
    } else {
      const tokens = await exchangeCodeForTokens(code);
      await saveConnection(shop, tokens);
    }
    return redirect("/app/inbox?connected=true");
  } catch (err) {
    console.error(`[${provider}/auth] Token exchange failed:`, err);
    return redirect("/app/inbox?error=auth_failed");
  }
};

export default function MailAuthCallback() {
  return <p>Redirecting…</p>;
}
