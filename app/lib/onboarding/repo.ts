import prisma from '../../db.server';
import type { ShopFlagLike } from './state';

export async function getShopFlag(shop: string): Promise<ShopFlagLike | null> {
  const row = await prisma.shopFlag.findUnique({ where: { shop } });
  if (!row) return null;
  return {
    shop: row.shop,
    onboardingCompletedAt: row.onboardingCompletedAt,
    checklistDismissedAt: row.checklistDismissedAt,
  };
}

export async function ensureShopFlag(shop: string) {
  return prisma.shopFlag.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });
}

/**
 * Sets onboardingCompletedAt if currently null. Idempotent: a second call
 * returns the existing timestamp instead of overwriting it.
 */
export async function markOnboardingComplete(shop: string): Promise<Date | null> {
  await prisma.shopFlag.upsert({
    where: { shop },
    create: { shop, onboardingCompletedAt: new Date() },
    update: {},
  });
  await prisma.$executeRaw`
    UPDATE "ShopFlag" SET "onboardingCompletedAt" = NOW()
    WHERE "shop" = ${shop} AND "onboardingCompletedAt" IS NULL
  `;
  const row = await prisma.shopFlag.findUnique({ where: { shop } });
  return row?.onboardingCompletedAt ?? null;
}

export async function markChecklistDismissed(shop: string): Promise<void> {
  await prisma.shopFlag.upsert({
    where: { shop },
    create: { shop, checklistDismissedAt: new Date() },
    update: { checklistDismissedAt: new Date() },
  });
}

export async function hasGeneratedAnyDraft(shop: string): Promise<boolean> {
  const count = await prisma.replyDraft.count({ where: { shop } });
  return count > 0;
}

/**
 * Settings are "customized" when at least one user-facing field differs from
 * its default. Mirrors the defaults declared in `prisma/schema.prisma`
 * (signatureName='Customer Support', tone='friendly', etc.).
 */
export async function hasCustomizedSupportSettings(shop: string): Promise<boolean> {
  const row = await prisma.supportSettings.findUnique({ where: { shop } });
  if (!row) return false;
  return (
    row.signatureName !== 'Customer Support' ||
    row.brandName !== '' ||
    row.tone !== 'friendly' ||
    row.closingPhrase !== '' ||
    row.refundPolicy !== ''
  );
}
