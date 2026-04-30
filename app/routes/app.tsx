import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useTranslation } from "react-i18next";
import { useEffect } from "react";

import { authenticate } from "../shopify.server";
import { getUiLanguage } from "../lib/user-preferences";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  let effectiveRequest = request;
  const shop = url.searchParams.get("shop");
  if (shop && !url.searchParams.get("host")) {
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

  const { session, sessionToken } = await authenticate.admin(effectiveRequest);

  const userId = sessionToken?.sub ?? null;
  const uiLanguage = userId ? await getUiLanguage(userId, session.shop) : null;

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", uiLanguage };
};

export default function App() {
  const { apiKey, uiLanguage } = useLoaderData<typeof loader>();
  const { t, i18n } = useTranslation();

  useEffect(() => {
    if (uiLanguage && i18n.language !== uiLanguage) {
      i18n.changeLanguage(uiLanguage);
    }
  }, [uiLanguage, i18n]);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">{t("nav.home")}</s-link>
        <s-link href="/app/inbox">{t("nav.emailInbox")}</s-link>
        <s-link href="/app/dashboard">{t("nav.dashboard")}</s-link>
        <s-link href="/app/settings">{t("nav.settings")}</s-link>
      </s-app-nav>
      <Outlet />
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
