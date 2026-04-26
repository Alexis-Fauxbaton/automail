// tests/e2e/global-setup.ts
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs/promises';
import path from 'node:path';

export const E2E_SHOP = 'e2e-test.myshopify.com';

export default async function globalSetup() {
  const db = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
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
