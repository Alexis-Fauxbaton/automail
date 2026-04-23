import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // When React Router does a hard-refresh on a sub-page (/app/inbox etc.), the
  // Shopify query params (host, embedded) are stripped from the URL.  The SDK
  // then fails validateShopAndHostParams and redirects to the login page.
  // Fix: reconstruct host/embedded from the shop param before calling authenticate.
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

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/support">Support copilot</s-link>
        <s-link href="/app/inbox">Email inbox</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  const error = useRouteError();

  // Let the Shopify boundary handle Response throws (auth redirects etc.)
  if (error instanceof Response) {
    return boundary.error(error);
  }

  // In production, never expose stack traces or internal error details.
  // eslint-disable-next-line no-undef
  if (process.env.NODE_ENV === "production") {
    return (
      <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
        <h1>Something went wrong</h1>
        <p>An unexpected error occurred. Please try refreshing the page.</p>
        <p>If the problem persists, contact support.</p>
      </div>
    );
  }

  // Development only — show the message but not the full stack.
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div style={{ padding: "2rem", fontFamily: "monospace" }}>
      <h1>Application Error</h1>
      <pre style={{ whiteSpace: "pre-wrap", color: "crimson" }}>{message}</pre>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
