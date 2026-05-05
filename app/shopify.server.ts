import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// Minimum scopes needed for a read-only support copilot.
// Do NOT add write_* scopes unless a feature explicitly requires them —
// unnecessary write access triggers extra scrutiny in the App Store review
// and erodes merchant trust.
const REQUIRED_SCOPES = [
  "read_orders",
  "read_all_orders",
  "read_customers",
  "read_fulfillments",
];

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(",") ?? REQUIRED_SCOPES,
  appUrl: process.env.SHOPIFY_APP_URL || process.env.HOST || "",
  authPathPrefix: "/auth",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionStorage: new PrismaSessionStorage(prisma) as any,
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

// ---------------------------------------------------------------------------
// E2E auth bypass — opt-in, double-gated, NEVER active in production.
//
// Set E2E_AUTH_BYPASS=true in the dev server's environment to activate.
// authenticate.admin() will return a fake offline session for
// e2e-test.myshopify.com so Playwright layout-capture tests can render the
// inbox without going through the real Shopify OAuth flow.
//
// The Admin GraphQL client is intentionally NOT mocked — any loader that
// calls admin.graphql() will fail loudly (by design).
// ---------------------------------------------------------------------------
const E2E_AUTH_BYPASS_ACTIVE =
  process.env.E2E_AUTH_BYPASS === "true" &&
  process.env.NODE_ENV !== "production";

const E2E_BYPASS_SHOP = "e2e-test.myshopify.com";

let _e2eWarningLogged = false;

function logE2eWarningOnce() {
  if (_e2eWarningLogged) return;
  _e2eWarningLogged = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[E2E_AUTH_BYPASS] Active — authenticate.admin() returns a fake session for " +
      E2E_BYPASS_SHOP +
      ". NEVER set E2E_AUTH_BYPASS=true in production."
  );
}

export const authenticate = E2E_AUTH_BYPASS_ACTIVE
  ? {
      // Spread the real authenticate so public/webhooks/etc. are untouched.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(shopify.authenticate as any),
      admin: async (_request: Request) => {
        logE2eWarningOnce();
        const session = {
          id: `offline_${E2E_BYPASS_SHOP}`,
          shop: E2E_BYPASS_SHOP,
          state: "active",
          isOnline: false,
          accessToken: "e2e-test-token",
          scope:
            "read_orders,read_customers,read_fulfillments,read_all_orders",
          isActive: () => true,
          expires: undefined,
        };
        return {
          session,
          sessionToken: undefined,
          // admin.graphql is intentionally undefined — fails loudly if called.
          admin: undefined,
          cors: (response: Response) => response,
          billing: undefined,
          redirect: () => {
            throw new Error(
              "[E2E_AUTH_BYPASS] redirect() is not supported in bypass mode"
            );
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      },
    }
  : shopify.authenticate;
