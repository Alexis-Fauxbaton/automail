import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useTranslation } from "react-i18next";
import { useEffect } from "react";

import { authenticate } from "../shopify.server";
import { getUiLanguage } from "../lib/user-preferences";
import { EntitlementsProvider } from "../lib/billing/entitlements-context";
import { TopBarCounter } from "../components/billing/TopBarCounter";
import { QuotaBanner } from "../components/billing/QuotaBanner";
import { TrialBanner } from "../components/billing/TrialBanner";
import { SyncSuspendedBanner as SyncSuspendedBannerSlot } from "../components/billing/SyncSuspendedBanner";

// Strict shape check: we only accept canonical Shopify shop domains for
// the synthetic-host fallback below. Anything else (typos, attempted host
// injection, custom domains) bails out and triggers Shopify's normal
// install/auth redirect.
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/i;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  let effectiveRequest = request;
  const shop = url.searchParams.get("shop");
  // Shopify normally provides BOTH `shop` and `host` in the iframe URL.
  // Some entry paths (bookmarks, deep links, manual navigation) may carry
  // only `shop`. We synthesize a plausible `host` so authenticate.admin
  // doesn't bounce the user to the install flow needlessly. We refuse the
  // fallback for anything that doesn't look like a real myshopify.com host.
  if (shop && SHOP_DOMAIN_RE.test(shop) && !url.searchParams.get("host")) {
    const shopId = shop.split(".")[0];
    const host = Buffer.from(`admin.shopify.com/store/${shopId}`).toString("base64");
    url.searchParams.set("host", host);
    url.searchParams.set("embedded", "1");
    effectiveRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body ?? undefined,
      signal: request.signal,
    });
  }

  const { session, sessionToken, admin } = await authenticate.admin(effectiveRequest);

  const userId = sessionToken?.sub ?? null;
  const uiLanguage = userId ? await getUiLanguage(userId, session.shop) : null;

  // eslint-disable-next-line no-undef
  const isE2E = process.env.E2E_AUTH_BYPASS === "true";

  const { resolveEntitlements } = await import("../lib/billing/entitlements");
  const ent = await resolveEntitlements({ shop: session.shop, admin });

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    uiLanguage,
    isE2E,
    entitlements: {
      shop: ent.shop,
      state: ent.state,
      planId: ent.planId,
      plan: ent.plan,
      canGenerateDraft: ent.canGenerateDraft,
      canConnectMailbox: ent.canConnectMailbox,
      canViewAdvancedDashboard: ent.canViewAdvancedDashboard,
      isSyncSuspended: ent.isSyncSuspended,
      trialDaysRemaining: ent.trialDaysRemaining,
      trialExpiresAt: ent.trialExpiresAt?.toISOString() ?? null,
      quotaStatus: { ...ent.quotaStatus, periodStart: ent.quotaStatus.periodStart.toISOString() },
      mailboxStatus: ent.mailboxStatus,
      dashboardMaxRangeDays: ent.dashboardMaxRangeDays,
    },
  };
};

export default function App() {
  const { apiKey, uiLanguage, isE2E, entitlements } = useLoaderData<typeof loader>();
  const { t, i18n } = useTranslation();

  useEffect(() => {
    if (uiLanguage && i18n.language !== uiLanguage) {
      i18n.changeLanguage(uiLanguage);
    }
  }, [uiLanguage, i18n]);

  const hydratedEntitlements = entitlements
    ? {
        ...entitlements,
        trialExpiresAt: entitlements.trialExpiresAt
          ? new Date(entitlements.trialExpiresAt)
          : null,
        quotaStatus: {
          ...entitlements.quotaStatus,
          periodStart: new Date(entitlements.quotaStatus.periodStart),
        },
      }
    : null;

  return (
    <AppProvider embedded={!isE2E} apiKey={apiKey}>
      {hydratedEntitlements ? (
        <EntitlementsProvider value={hydratedEntitlements}>
          <s-app-nav name="Automail">
            <s-link href="/app">{t("nav.home")}</s-link>
            <s-link href="/app/inbox">{t("nav.emailInbox")}</s-link>
            <s-link href="/app/dashboard">{t("nav.dashboard")}</s-link>
            <s-link href="/app/settings">{t("nav.settings")}</s-link>
            <s-link href="/app/billing">{t("nav.billing")}</s-link>
            <s-link href="/app/help">{t("nav.help")}</s-link>
          </s-app-nav>
          {/* Top app-shell bar (trial banner + quota banner + counter).
              Non-sticky on purpose: when sticky, it covered the top of any
              other sticky element underneath (notably the inbox detail panel
              header). Scrolling it out of view is a fair tradeoff — the
              messages reappear at the next page navigation. */}
          {/* Top app-shell strip.
              CSS grid with 2 columns: [banners 1fr] [counter auto]
              Row 1: TrialBanner + QuotaBanner share col 1, TopBarCounter in col 2.
              Row 2: SyncSuspendedBanner spans col 1 only — col 2 stays empty so
              both rows share the same right edge for the banner column,
              regardless of the counter's dynamic width.
              SyncSuspendedBanner is null-rendering when ent.isSyncSuspended
              is false, so this stays invisible in healthy state. */}
          <div style={{
            background: "rgba(248, 250, 252, 0.92)",
            backdropFilter: "saturate(180%) blur(8px)",
            WebkitBackdropFilter: "saturate(180%) blur(8px)",
            padding: "10px 16px",
            display: "grid",
            gridTemplateColumns: "1fr auto",
            columnGap: 12,
            rowGap: 8,
            alignItems: "center",
            borderBottom: "1px solid #e2e8f0",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              <TrialBanner />
              <QuotaBanner />
            </div>
            <TopBarCounter />
            <div style={{ gridColumn: "1 / 2", minWidth: 0 }}>
              <SyncSuspendedBannerSlot />
            </div>
          </div>
          <Outlet />
          {/* Floating quota counter — persists at the bottom-right of the
              viewport so the user always sees their remaining drafts /
              trial state, even after scrolling past the (non-sticky) top
              bar. */}
          <TopBarCounter variant="floating" />
        </EntitlementsProvider>
      ) : (
        <>
          <s-app-nav name="Automail">
            <s-link href="/app">{t("nav.home")}</s-link>
            <s-link href="/app/inbox">{t("nav.emailInbox")}</s-link>
            <s-link href="/app/dashboard">{t("nav.dashboard")}</s-link>
            <s-link href="/app/settings">{t("nav.settings")}</s-link>
            <s-link href="/app/help">{t("nav.help")}</s-link>
          </s-app-nav>
          <Outlet />
        </>
      )}
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const { t } = useTranslation();

  if (error instanceof Response) {
    return boundary.error(error);
  }

  // eslint-disable-next-line no-undef
  if (process.env.NODE_ENV === "production") {
    return (
      <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
        <h1>{t("nav.errorTitle")}</h1>
        <p>{t("nav.errorDesc")}</p>
        <p>{t("nav.errorContact")}</p>
      </div>
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    <div style={{ padding: "2rem", fontFamily: "monospace" }}>
      <h1>{t("nav.errorDevTitle")}</h1>
      <pre style={{ whiteSpace: "pre-wrap", color: "crimson" }}>{message}</pre>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
