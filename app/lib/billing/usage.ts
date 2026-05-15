/**
 * Atomic billing usage counter.
 *
 * One row per (shop, periodStart). periodStart is always 00:00:00 UTC of
 * the 1st of the current month. tryReserveDraft uses a Postgres-side
 * compare-and-swap (raw SQL) to avoid race conditions when two requests
 * arrive at limit-1 simultaneously.
 *
 * NOTE: function names still mention "Draft" for now. A later task in
 * this plan introduces the new helper `markThreadAnalyzedIfFirst`
 * which becomes the only billing write site under the per-conversation
 * model. Until then, callers continue to use tryReserveDraft.
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

export async function tryReserveDraft(input: {
  shop: string;
  limit: number;
  now?: Date;
}): Promise<ReserveResult> {
  const periodStart = getCurrentPeriodStart(input.now);

  await prisma.billingUsage.upsert({
    where: { shop_periodStart: { shop: input.shop, periodStart } },
    create: { shop: input.shop, periodStart, analyzedThreadsCount: 0 },
    update: {},
  });

  const effectiveLimit = Number.isFinite(input.limit) ? input.limit : Number.MAX_SAFE_INTEGER;

  const updated = await prisma.$executeRaw`
    UPDATE "BillingUsage"
    SET "analyzedThreadsCount" = "analyzedThreadsCount" + 1, "updatedAt" = NOW()
    WHERE "shop" = ${input.shop}
      AND "periodStart" = ${periodStart}
      AND "analyzedThreadsCount" < ${effectiveLimit}
  `;

  if (updated === 0) {
    return { ok: false, reason: 'quota_exceeded' };
  }

  const row = await prisma.billingUsage.findUnique({
    where: { shop_periodStart: { shop: input.shop, periodStart } },
  });
  return { ok: true, newCount: row?.analyzedThreadsCount ?? 0 };
}

export async function releaseDraft(input: { shop: string; now?: Date }): Promise<void> {
  const periodStart = getCurrentPeriodStart(input.now);

  await prisma.$executeRaw`
    UPDATE "BillingUsage"
    SET "analyzedThreadsCount" = GREATEST("analyzedThreadsCount" - 1, 0), "updatedAt" = NOW()
    WHERE "shop" = ${input.shop}
      AND "periodStart" = ${periodStart}
  `;
}

export async function getUsage(shop: string, now: Date = new Date()): Promise<BillingUsage> {
  const periodStart = getCurrentPeriodStart(now);
  const row = await prisma.billingUsage.findUnique({
    where: { shop_periodStart: { shop, periodStart } },
  });
  return {
    shop,
    periodStart,
    count: row?.analyzedThreadsCount ?? 0,
  };
}

export interface MarkThreadAnalyzedResult {
  counted: boolean;
  alreadyAnalyzed: boolean;
}

/**
 * Sets `Thread.analyzedAt` and increments the shop's
 * `analyzedThreadsCount` for the current period — but ONLY if this
 * thread has never been analyzed before. The atomicity comes from
 * `updateMany WHERE analyzedAt IS NULL`: only one concurrent caller
 * wins; the rest see `count: 0` and short-circuit.
 *
 * Returns:
 *   { counted: true,  alreadyAnalyzed: false } — increment happened.
 *   { counted: false, alreadyAnalyzed: true  } — thread already analyzed; no-op.
 *   { counted: false, alreadyAnalyzed: false } — thread not found, wrong shop,
 *     or empty id; no-op.
 *
 * Never throws on the happy path. DB errors propagate (caller logs).
 */
export async function markThreadAnalyzedIfFirst(
  threadId: string,
  shop: string,
): Promise<MarkThreadAnalyzedResult> {
  if (!threadId || !shop) {
    return { counted: false, alreadyAnalyzed: false };
  }

  const result = await prisma.thread.updateMany({
    where: { id: threadId, shop, analyzedAt: null },
    data: { analyzedAt: new Date() },
  });

  if (result.count === 0) {
    // Either the thread doesn't exist, the shop doesn't match, or
    // analyzedAt was already set. Distinguish with a single follow-up read.
    const row = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { shop: true, analyzedAt: true },
    });
    if (!row || row.shop !== shop) {
      return { counted: false, alreadyAnalyzed: false };
    }
    return { counted: false, alreadyAnalyzed: row.analyzedAt !== null };
  }

  // Increment the shop's usage counter for the current period.
  const periodStart = getCurrentPeriodStart();
  await prisma.billingUsage.upsert({
    where: { shop_periodStart: { shop, periodStart } },
    create: { shop, periodStart, analyzedThreadsCount: 1 },
    update: { analyzedThreadsCount: { increment: 1 } },
  });

  return { counted: true, alreadyAnalyzed: false };
}
