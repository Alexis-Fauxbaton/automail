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
// E2E auth bypass — opt-in, triple-gated, NEVER active in production.
//
// Activation requires ALL THREE of:
//   1. E2E_AUTH_BYPASS = "true"
//   2. NODE_ENV != "production"
//   3. ALLOW_E2E_AUTH_BYPASS = "yes-i-know"
//
// The third gate is intentionally awkward to type so it can't be set by
// accident — the only valid usage is in the Playwright layout-capture
// flow where you're knowingly opting in.
//
// When active, authenticate.admin() returns a fake offline session for
// e2e-test.myshopify.com so the inbox loader can render against seeded
// Prisma data without going through real Shopify OAuth.
//
// HARD LIMITS (by design, not bugs):
// - Loader paths only. Action handlers that call `admin.graphql(...)` will
//   crash with "Cannot read properties of undefined" because admin is
//   intentionally undefined. The capture spec only does GETs — if the spec
//   is ever extended to click "Mark as resolved" or send a draft, that
//   action will break in bypass mode.
// - Webhook / public / unauthenticated routes are untouched (we spread the
//   real authenticate object and only override .admin).
// - billing and redirect are stubs that throw if used.
// ---------------------------------------------------------------------------
const E2E_AUTH_BYPASS_ACTIVE =
  process.env.E2E_AUTH_BYPASS === "true" &&
  (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") &&
  process.env.ALLOW_E2E_AUTH_BYPASS === "yes-i-know";

if (process.env.E2E_AUTH_BYPASS === "true" && process.env.NODE_ENV === "production") {
  throw new Error("E2E_AUTH_BYPASS must not be set in production");
}

const E2E_BYPASS_SHOP = "e2e-test.myshopify.com";

if (E2E_AUTH_BYPASS_ACTIVE) {
  // Module-load banner so a developer who set E2E_AUTH_BYPASS=true in their
  // .env sees feedback even if no auth route is hit during the session.
  // eslint-disable-next-line no-console
  console.warn(
    `\n[E2E_AUTH_BYPASS] ⚠️  ACTIVE at module load — authenticate.admin() will return a fake session for ${E2E_BYPASS_SHOP}.\n` +
      "   Loader paths only; action handlers that call admin.graphql will crash.\n" +
      "   NEVER set E2E_AUTH_BYPASS=true in production.\n"
  );
}

export const authenticate = E2E_AUTH_BYPASS_ACTIVE
  ? {
      // Spread the real authenticate so public/webhooks/etc. are untouched.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(shopify.authenticate as any),
      admin: async (_request: Request) => {
        if (_request.method !== "GET" && _request.method !== "HEAD") {
          throw new Response("E2E bypass is read-only", { status: 405 });
        }
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
