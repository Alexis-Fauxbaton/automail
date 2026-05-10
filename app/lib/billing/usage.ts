/**
 * Atomic billing usage counter.
 *
 * One row per (shop, periodStart). periodStart is always 00:00:00 UTC of
 * the 1st of the current month. tryReserveDraft uses a Postgres-side
 * compare-and-swap (raw SQL) to avoid race conditions when two requests
 * arrive at limit-1 simultaneously.
 */

import prisma from '../../db.server';

export interface BillingUsage {
  shop: string;
  periodStart: Date;
  count: number;
}

export type ReserveResult =
  | { ok: true; newCount: number }
  | { ok: false; reason: 'quota_exceeded' };

/** Returns 00:00:00 UTC of the 1st of the month containing `now`. */
export function getCurrentPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * Attempts to reserve 1 draft unit for the given shop in the current period.
 *
 * Strategy:
 *   1. Upsert a row at count=0 if none exists (idempotent).
 *   2. Conditional UPDATE that increments only if count < limit.
 *   3. If the UPDATE affected 0 rows, the limit was reached → quota_exceeded.
 *
 * This avoids the read-then-write race where two concurrent reserves at
 * limit-1 could both pass the check and both increment.
 */
export async function tryReserveDraft(input: {
  shop: string;
  limit: number;
  now?: Date;
}): Promise<ReserveResult> {
  const periodStart = getCurrentPeriodStart(input.now);

  // Step 1: Ensure the row exists (no increment).
  await prisma.billingUsage.upsert({
    where: { shop_periodStart: { shop: input.shop, periodStart } },
    create: { shop: input.shop, periodStart, draftsCount: 0 },
    update: {},
  });

  // Step 2: Conditional increment via raw SQL to make the limit check
  // and the increment atomic in a single statement.
  // `Number.isFinite(limit)` guards against Infinity (trial plan).
  const effectiveLimit = Number.isFinite(input.limit) ? input.limit : Number.MAX_SAFE_INTEGER;

  const updated = await prisma.$executeRaw`
    UPDATE "BillingUsage"
    SET "draftsCount" = "draftsCount" + 1, "updatedAt" = NOW()
    WHERE "shop" = ${input.shop}
      AND "periodStart" = ${periodStart}
      AND "draftsCount" < ${effectiveLimit}
  `;

  if (updated === 0) {
    return { ok: false, reason: 'quota_exceeded' };
  }

  // Re-fetch new count for the response.
  const row = await prisma.billingUsage.findUnique({
    where: { shop_periodStart: { shop: input.shop, periodStart } },
  });
  return { ok: true, newCount: row?.draftsCount ?? 0 };
}

/**
 * Decrements the counter (best-effort). Used when LLM generation fails
 * after a successful reserve. Clamps to 0 — never goes negative.
 */
export async function releaseDraft(input: { shop: string; now?: Date }): Promise<void> {
  const periodStart = getCurrentPeriodStart(input.now);

  await prisma.$executeRaw`
    UPDATE "BillingUsage"
    SET "draftsCount" = GREATEST("draftsCount" - 1, 0), "updatedAt" = NOW()
    WHERE "shop" = ${input.shop}
      AND "periodStart" = ${periodStart}
  `;
}

/** Reads the current usage for a shop. Returns count=0 if no row exists yet. */
export async function getUsage(shop: string, now: Date = new Date()): Promise<BillingUsage> {
  const periodStart = getCurrentPeriodStart(now);
  const row = await prisma.billingUsage.findUnique({
    where: { shop_periodStart: { shop, periodStart } },
  });
  return {
    shop,
    periodStart,
    count: row?.draftsCount ?? 0,
  };
}
