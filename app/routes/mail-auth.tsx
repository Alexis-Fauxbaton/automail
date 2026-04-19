import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state") ?? "";

  console.log("[mail-auth] OAuth callback received, state:", rawState);

  if (!code || !rawState) {
    return redirect("/app/inbox?error=missing_params");
  }

  let provider: "gmail" | "zoho" = "gmail";
  let shop = rawState;
  if (rawState.startsWith("zoho:")) {
    provider = "zoho";
    shop = rawState.slice(5);
  } else if (rawState.startsWith("gmail:")) {
    provider = "gmail";
    shop = rawState.slice(6);
  }

  console.log(`[mail-auth] Exchanging ${provider} token for shop ${shop}`);

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

    // Redirect to Shopify admin embedded app URL
    const storeName = shop.replace(".myshopify.com", "");
    const apiKey = process.env.SHOPIFY_API_KEY || "";
    const adminUrl = `https://admin.shopify.com/store/${storeName}/apps/${apiKey}/app/inbox?connected=true`;
    console.log(`[mail-auth] Success, redirecting to ${adminUrl}`);

    return redirect(adminUrl);
  } catch (err) {
    console.error("[mail-auth] Token exchange failed:", err);
    return redirect("/app/inbox?error=auth_failed");
  }
};
