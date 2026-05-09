/**
 * One-time backfill: create a ShopFlag for every shop that has a
 * Shopify session but no flag yet.
 *
 * Why: the entitlements resolver creates flags lazily on first-touch, so
 * for actively-used shops this is a no-op. But for shops that haven't
 * called any entitlement-aware route since billing rolled out (e.g. the
 * sync runs server-side without ever loading a UI loader), the flag is
 * missing and the trial countdown isn't anchored.
 *
 * Safe to run repeatedly: only inserts where missing.
 *
 * Returns the list of shops for which a flag was created.
 */

import prisma from '../../db.server';

export async function backfillBillingShopFlags(): Promise<string[]> {
  const sessions = await prisma.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ['shop'],
  });

  if (sessions.length === 0) return [];

  const existingFlags = await prisma.shopFlag.findMany({
    where: { shop: { in: sessions.map((s) => s.shop) } },
    select: { shop: true },
  });
  const haveFlag = new Set(existingFlags.map((f) => f.shop));

  const missing = sessions
    .map((s) => s.shop)
    .filter((shop) => !haveFlag.has(shop));

  if (missing.length === 0) return [];

  const now = new Date();
  await prisma.shopFlag.createMany({
    data: missing.map((shop) => ({ shop, installDate: now, isInternal: false })),
    skipDuplicates: true,
  });

  console.log(`[billing-migration] backfilled ${missing.length} ShopFlag rows: ${missing.join(', ')}`);
  return missing;
}
