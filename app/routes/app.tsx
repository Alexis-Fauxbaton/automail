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
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
