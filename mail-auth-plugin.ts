/**
 * Vite plugin that handles the OAuth callback for mail providers (Gmail, Zoho)
 * BEFORE the Shopify middleware can intercept it.
 */
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "http";

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
              res.writeHead(302, { Location: "/app/inbox?error=missing_params" });
              res.end();
              return;
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

            console.log(
              `[mail-auth-plugin] Exchanging ${provider} token for shop ${shop}`,
            );

            if (provider === "zoho") {
              const { exchangeZohoCode, saveZohoConnection } = await import(
                "./app/lib/zoho/auth"
              );
              const tokens = await exchangeZohoCode(code);
              await saveZohoConnection(shop, tokens);
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
            res.writeHead(302, { Location: "/app/inbox?error=auth_failed" });
            res.end();
          }
        }) as any,
      });
    },
  };
}
