import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useTranslation } from "react-i18next";
import { useState, useEffect, useRef } from "react";

import { authenticate } from "../shopify.server";

const LANGUAGES = [
  { code: "fr", label: "Français", flag: "🇫🇷" },
  { code: "en", label: "English", flag: "🇬🇧" },
];

function LanguagePicker() {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = LANGUAGES.find((l) => l.code === i18n.language) ?? LANGUAGES[0];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "3px 10px 3px 8px", borderRadius: 6,
          border: "1px solid #e1e3e5", background: open ? "#f6f6f7" : "#ffffff",
          cursor: "pointer", fontSize: 13, fontWeight: 500, color: "#202223",
          boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
          transition: "background 0.1s",
        }}
      >
        <span style={{ fontSize: 15, lineHeight: 1 }}>{current.flag}</span>
        <span>{current.label}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ marginLeft: 2, opacity: 0.4, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
          <path d="M1 1l4 4 4-4" stroke="#202223" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 100,
          background: "#ffffff", border: "1px solid #e1e3e5", borderRadius: 8,
          boxShadow: "0 4px 16px rgba(0,0,0,0.10), 0 1px 4px rgba(0,0,0,0.06)",
          minWidth: 140, overflow: "hidden", padding: "4px",
        }}>
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              onClick={() => { i18n.changeLanguage(lang.code); setOpen(false); }}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", padding: "7px 10px", border: "none",
                background: lang.code === i18n.language ? "#f3f4f6" : "transparent",
                cursor: "pointer", fontSize: 13, fontWeight: lang.code === i18n.language ? 600 : 400,
                color: "#202223", borderRadius: 6, textAlign: "left",
              }}
            >
              <span style={{ fontSize: 15 }}>{lang.flag}</span>
              <span>{lang.label}</span>
              {lang.code === i18n.language && (
                <svg style={{ marginLeft: "auto" }} width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6l3 3 5-5" stroke="#4b8cf7" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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

  await authenticate.admin(effectiveRequest);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  const { t, i18n } = useTranslation();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">{t("nav.home")}</s-link>
        <s-link href="/app/inbox">{t("nav.emailInbox")}</s-link>
        <s-link href="/app/dashboard">{t("nav.dashboard")}</s-link>
        <s-link href="/app/settings">{t("nav.settings")}</s-link>
      </s-app-nav>
      <div style={{
        display: "flex", justifyContent: "flex-end", alignItems: "center",
        padding: "5px 16px", borderBottom: "1px solid #e1e3e5",
        background: "#fafafa", gap: "10px",
      }}>
        <LanguagePicker />
      </div>
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
