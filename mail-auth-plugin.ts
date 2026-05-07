/**
 * Vite plugin that handles the OAuth callback for mail providers (Gmail, Zoho)
 * BEFORE the Shopify middleware can intercept it.
 */
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import { verifyOAuthState } from "./app/lib/mail/oauth-state";

export function mailAuthPlugin(): Plugin {
  return {
    name: "mail-auth-callback",
    enforce: "pre",
    configureServer(server) {
      // Return a function — Vite calls it AFTER internal middlewares are set up
      // but we manually unshift into position 0 so we run before everything.
      server.middlewares.stack.unshift({
        route: "",
        handle: (async (
          req: IncomingMessage,
          res: ServerResponse,
          next: () => void,
        ) => {
          if (process.env.NODE_ENV === "production") {
            return;
          }

          const fullUrl = req.url ?? "";
          if (!fullUrl.startsWith("/mail-auth")) {
            return next();
          }

          console.log("[mail-auth-plugin] Intercepted callback:", fullUrl);

          try {
            const url = new URL(fullUrl, `http://${req.headers.host}`);
            const code = url.searchParams.get("code");
            const rawState = url.searchParams.get("state") ?? "";

            if (!code || !rawState) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Missing OAuth parameters (code or state)");
              return;
            }

            const verified = verifyOAuthState(rawState);
            if (!verified) {
              console.warn("[mail-auth-plugin] Invalid OAuth state, state_len=", rawState.length);
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Invalid or expired OAuth state. Please try connecting again.");
              return;
            }

            const { provider, shop } = verified;
            console.log(`[mail-auth-plugin] Exchanging ${provider} token for shop ${shop}`);

            if (provider === "zoho") {
              const { exchangeZohoCode, saveZohoConnection } = await import(
                "./app/lib/zoho/auth"
              );
              const tokens = await exchangeZohoCode(code);
              await saveZohoConnection(shop, tokens);
            } else if (provider === "outlook") {
              const { exchangeCodeForTokens, saveConnection } = await import(
                "./app/lib/outlook/auth"
              );
              const tokens = await exchangeCodeForTokens(code);
              await saveConnection(shop, tokens);
            } else {
              const { exchangeCodeForTokens, saveConnection } = await import(
                "./app/lib/gmail/auth"
              );
              const tokens = await exchangeCodeForTokens(code);
              await saveConnection(shop, tokens);
            }

            // Redirect to Shopify admin embedded app URL
            const storeName = shop.replace(".myshopify.com", "");
            const apiKey = process.env.SHOPIFY_API_KEY || "";
            const adminUrl = `https://admin.shopify.com/store/${storeName}/apps/${apiKey}/app/inbox?connected=true`;
            console.log(`[mail-auth-plugin] Redirecting to ${adminUrl}`);

            res.writeHead(302, { Location: adminUrl });
            res.end();
          } catch (err) {
            console.error("[mail-auth-plugin] Token exchange failed:", err);
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(`Token exchange failed: ${msg}`);
          }
        }) as any,
      });
    },
  };
}
