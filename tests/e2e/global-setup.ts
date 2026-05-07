// tests/e2e/global-setup.ts
//
// Setup that runs once before all e2e specs. Two artifacts are produced:
//
// 1. A `Session` row in Prisma for the e2e shop. Used by code paths that
//    read sessions via `sessionStorage.findSessionsByShop(shop)` — these
//    are NOT covered by E2E_AUTH_BYPASS in app/shopify.server.ts (which
//    only overrides authenticate.admin). Keep this even when running in
//    bypass mode.
//
// 2. A storageState cookie file (tests/e2e/.auth/session.json) referenced
//    by playwright.config.ts. The cookie itself was insufficient to
//    authenticate against real Shopify OAuth, which is why E2E_AUTH_BYPASS
//    was added — but the file must still exist for Playwright to start.
//
// In short: bypass-mode tests need (1) for sessionStorage lookups and need
// (2) only as a Playwright bootstrap requirement. Removing either breaks
// something — leave both.
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs/promises';
import path from 'node:path';

export const E2E_SHOP = 'e2e-test.myshopify.com';

export default async function globalSetup() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("E2E tests must not run in production");
  }

  const db = new PrismaClient({
    datasources: { db: { url: process.env.E2E_DATABASE_URL } },
  });

  try {
    await db.session.upsert({
      where: { id: `offline_${E2E_SHOP}` },
      update: {
        accessToken: 'e2e-test-token',
        scope: 'read_orders,read_customers,read_fulfillments,read_all_orders',
      },
      create: {
        id: `offline_${E2E_SHOP}`,
        shop: E2E_SHOP,
        state: 'active',
        isOnline: false,
        accessToken: 'e2e-test-token',
        scope: 'read_orders,read_customers,read_fulfillments,read_all_orders',
      },
    });
  } finally {
    await db.$disconnect();
  }

  // Write the storageState with the session cookie
  const authDir = path.join(process.cwd(), 'tests/e2e/.auth');
  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(
    path.join(authDir, 'session.json'),
    JSON.stringify({
      cookies: [
        {
          name: 'shopify_app_session',
          value: `offline_${E2E_SHOP}`,
          domain: 'localhost',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax' as const,
          expires: -1,
        },
      ],
      origins: [],
    }, null, 2)
  );
}
