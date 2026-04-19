import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { exchangeCodeForTokens, saveConnection } from "../lib/gmail/auth";

/**
 * Google OAuth callback route.
 * Google redirects here after the user grants consent.
 * The `state` parameter carries the shop domain so we don't need
 * Shopify session auth (this request comes from Google, not from the iframe).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const shop = url.searchParams.get("state");

  if (!code || !shop) {
    return redirect("/app/gmail?error=missing_params");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    await saveConnection(shop, tokens);
    // Redirect back to the Shopify admin app page (not the ngrok URL)
    return redirect("/app/gmail?connected=true");
  } catch (err) {
    console.error("[gmail/auth] Token exchange failed:", err);
    return redirect("/app/gmail?error=auth_failed");
  }
};

export default function GmailAuthCallback() {
  return <p>Redirecting…</p>;
}
