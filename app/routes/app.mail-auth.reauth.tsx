import { redirect, type LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useTranslation } from "react-i18next";

// Provider auth URL generators — same functions used by app.connections.tsx.
// Post-Task-2.4 the SCOPES constants include the send permission, so a fresh
// OAuth consent issued via these URLs will grant canSend.
import { getAuthUrl as getGmailAuthUrl } from "../lib/gmail/auth";
import { getAuthUrl as getOutlookAuthUrl } from "../lib/outlook/auth";
import { getZohoAuthUrl } from "../lib/zoho/auth";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const mailConnectionId = url.searchParams.get("mailConnectionId");
  const returnTo = url.searchParams.get("returnTo") ?? "/app/inbox";

  if (!mailConnectionId) return redirect("/app/connections");

  const conn = await prisma.mailConnection.findUnique({
    where: { id: mailConnectionId, shop: session.shop },
    select: { id: true, email: true, provider: true },
  });
  if (!conn) return redirect("/app/connections");

  // Generate a fresh OAuth URL with a new HMAC-signed state. The SCOPES
  // constant (expanded in Task 2.4) ensures the new consent includes the
  // send-mail permission. saveConnection's upsert by (shop, email) will
  // update grantedScopes transparently when the callback fires.
  //
  // NB: v1 does not thread `returnTo` through the OAuth state — after
  // re-consent the callback lands on /app/inbox (via adminInboxUrl). Wiring
  // returnTo through the state is deferred to a later iteration.
  let authStartUrl: string;
  try {
    switch (conn.provider) {
      case "gmail":
        authStartUrl = getGmailAuthUrl(session.shop);
        break;
      case "outlook":
        authStartUrl = getOutlookAuthUrl(session.shop);
        break;
      case "zoho":
        authStartUrl = getZohoAuthUrl(session.shop);
        break;
      default:
        return redirect("/app/connections");
    }
  } catch {
    // Provider not configured (missing env vars) — fall back to connections.
    return redirect("/app/connections");
  }

  return {
    connection: conn,
    authStartUrl,
    returnTo,
  };
}

export default function ReauthExplainer() {
  const { connection, authStartUrl, returnTo } = useLoaderData<typeof loader>();
  const { t } = useTranslation();

  const providerName =
    connection.provider === "gmail"
      ? "Google"
      : connection.provider === "outlook"
        ? "Microsoft"
        : "Zoho";

  // The Shopify admin embeds our app in an iframe. A plain <a href> would
  // navigate only the iframe. We need window.top to break out — same trick
  // used in app.connections.tsx for the "reauth" action.
  const handleContinue = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (typeof window !== "undefined" && window.top) {
      window.top.location.href = authStartUrl;
    } else {
      window.location.href = authStartUrl;
    }
  };

  return (
    <div
      style={{
        maxWidth: 560,
        margin: "60px auto",
        padding: 24,
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#0f172a",
      }}
    >
      <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>
        {t("mail-auth.reauth.title", {
          email: connection.email,
          provider: providerName,
        })}
      </h1>
      <p style={{ marginBottom: 16, color: "#475569", lineHeight: 1.6 }}>
        {t("mail-auth.reauth.intro", { provider: providerName })}
      </p>
      <ul
        style={{
          marginBottom: 24,
          color: "#475569",
          paddingLeft: 20,
          lineHeight: 1.8,
        }}
      >
        <li>{t("mail-auth.reauth.bullet_no_auto")}</li>
        <li>{t("mail-auth.reauth.bullet_each_click")}</li>
        <li>{t("mail-auth.reauth.bullet_no_extra_read")}</li>
      </ul>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <a
          href={authStartUrl}
          onClick={handleContinue}
          style={{
            background: "#1a1a1a",
            color: "white",
            padding: "10px 20px",
            borderRadius: 6,
            textDecoration: "none",
            fontWeight: 500,
            display: "inline-block",
          }}
        >
          {t("mail-auth.reauth.continue", { provider: providerName })}
        </a>
        {/* Use Link, not <a>, to keep SPA navigation inside the embedded
            iframe and preserve shop/host/embedded query params. */}
        <Link
          to={returnTo}
          style={{
            padding: "10px 20px",
            color: "#1a1a1a",
            textDecoration: "none",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            display: "inline-block",
          }}
        >
          {t("common.cancel")}
        </Link>
      </div>
    </div>
  );
}
