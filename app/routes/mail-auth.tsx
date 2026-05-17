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

type Locale = "fr" | "en";

/** Pick FR/EN from Accept-Language. Default EN. */
function detectLocale(request: Request): Locale {
  const al = request.headers.get("accept-language") ?? "";
  return /\bfr\b/i.test(al) ? "fr" : "en";
}

const T: Record<Locale, {
  title: string;
  detail: string;
  retryHint: string;
  errors: {
    consent: { title: string; body: string };
    oauth: (provider: string) => { title: string };
    missing: { title: string; body: (codeOk: boolean, stateOk: boolean) => string };
    invalidState: { title: string };
    mailboxLimit: { title: string; body: (used: number, limit: number) => string };
    entitlements: { title: string; body: (ref: string) => string };
    tokenExchange: { title: (provider: string) => string; body: (ref: string) => string };
  };
}> = {
  fr: {
    title: "Erreur d'authentification",
    detail: "Détails",
    retryHint: "Consultez les journaux serveur pour plus de détails. Vous pouvez fermer cet onglet et réessayer depuis l'administration Shopify.",
    errors: {
      consent: {
        title: "Consentement administrateur Microsoft requis",
        body:
          "L'administrateur Microsoft 365 de votre organisation doit approuver cette application avant que vous puissiez la connecter.\n\n" +
          "Demandez à votre administrateur informatique de se connecter au portail Azure et d'accorder le consentement pour la permission « Mail.Read ».\n\n" +
          "Après approbation, recommencez la connexion depuis l'administration Shopify.",
      },
      oauth: (provider) => ({ title: `Erreur OAuth : ${provider}` }),
      missing: {
        title: "Paramètres OAuth manquants",
        body: (codeOk, stateOk) => `code présent : ${codeOk}\nstate présent : ${stateOk}`,
      },
      invalidState: { title: "État OAuth invalide" },
      mailboxLimit: {
        title: "Limite de boîtes mail atteinte",
        body: (used, limit) =>
          `Limite du forfait atteinte : ${used} / ${limit} boîtes mail connectées. Passez au forfait Pro pour en connecter davantage.`,
      },
      entitlements: {
        title: "Vérification du forfait impossible",
        body: (ref) => `Impossible de vérifier les limites du forfait. Référence : ${ref}`,
      },
      tokenExchange: {
        title: (provider) => `Échec de l'échange de jeton ${provider}`,
        body: (ref) => `L'échange de jeton a échoué. Référence : ${ref}`,
      },
    },
  },
  en: {
    title: "Auth error",
    detail: "Details",
    retryHint: "Check the server logs for more details. You can close this tab and retry from the Shopify admin.",
    errors: {
      consent: {
        title: "Microsoft admin consent required",
        body:
          "Your Microsoft 365 administrator must approve this app before you can connect it.\n\n" +
          "Ask your IT admin to visit the Microsoft Azure portal and grant consent for the 'Mail.Read' permission.\n\n" +
          "After admin approval, retry connecting from the Shopify admin.",
      },
      oauth: (provider) => ({ title: `OAuth error: ${provider}` }),
      missing: {
        title: "Missing OAuth parameters",
        body: (codeOk, stateOk) => `code present: ${codeOk}\nstate present: ${stateOk}`,
      },
      invalidState: { title: "Invalid OAuth state" },
      mailboxLimit: {
        title: "Mailbox limit reached",
        body: (used, limit) =>
          `Plan limit reached: ${used} / ${limit} mailboxes connected. Upgrade to Pro to connect more.`,
      },
      entitlements: {
        title: "Entitlements check failed",
        body: (ref) => `Unable to verify plan limits. Reference: ${ref}`,
      },
      tokenExchange: {
        title: (provider) => `${provider} token exchange failed`,
        body: (ref) => `Token exchange failed. Reference: ${ref}`,
      },
    },
  },
};

function errorPage(locale: Locale, title: string, detail: string): Response {
  const t = T[locale];
  const html = `<!DOCTYPE html><html lang="${locale}"><head><meta charset="utf-8"><title>${escapeHtml(t.title)}</title>
<style>body{font-family:sans-serif;padding:40px;max-width:600px;margin:auto}
h1{color:#b91c1c}pre{background:#f1f5f9;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-all}</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
<pre>${escapeHtml(detail)}</pre>
<p>${escapeHtml(t.retryHint)}</p>
</body></html>`;
  return new Response(html, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const locale = detectLocale(request);
  const t = T[locale].errors;

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
    // Log only the error CODE — error_description may echo back secret/PII
    // fragments from the provider. The description is still surfaced to the
    // end user via errorPage below (acceptable: it is shown only to the
    // person who triggered the OAuth flow).
    console.warn(`[mail-auth] OAuth provider error: ${oauthError}`);
    if (errorDesc.includes("AADSTS65001") || oauthError === "consent_required") {
      return errorPage(locale, t.consent.title, t.consent.body);
    }
    return errorPage(locale, t.oauth(oauthError).title, errorDesc);
  }

  if (!code || !rawState) {
    console.warn("[mail-auth] missing code or state");
    return errorPage(locale, t.missing.title, t.missing.body(!!code, !!rawState));
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
    return errorPage(locale, t.invalidState.title, debugInfo);
  }

  const { provider, shop } = verified;
  console.log(`[mail-auth] ${provider} callback for shop=${shop}`);

  // Enforce mailbox limit before any token exchange or DB write.
  try {
    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(shop);
    const { resolveEntitlements } = await import("../lib/billing/entitlements");
    const ent = await resolveEntitlements({ shop, admin });
    if (!ent.canConnectMailbox) {
      return errorPage(
        locale,
        t.mailboxLimit.title,
        t.mailboxLimit.body(ent.mailboxStatus.used, ent.mailboxStatus.limit),
      );
    }
  } catch (entErr) {
    const correlationId = Date.now().toString(36);
    console.error(`[mail-auth] entitlements check failed [ref=${correlationId}]:`, entErr);
    return errorPage(locale, t.entitlements.title, t.entitlements.body(correlationId));
  }

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
      locale,
      t.tokenExchange.title(provider),
      t.tokenExchange.body(correlationId),
    );
  }
};
