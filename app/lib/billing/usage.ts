/**
 * Atomic billing usage counter (per-conversation model).
 *
 * One row per (shop, periodStart). periodStart is always 00:00:00 UTC of
 * the 1st of the current month. Under the per-conversation model the
 * single billing write site is `markThreadAnalyzedIfFirst`, which is
 * atomic via `updateMany WHERE analyzedAt IS NULL` (only one concurrent
 * caller wins, the rest short-circuit). The legacy reserve/release
 * helpers were removed once refine / redraft / reanalyze stopped
 * charging per call.
 */

import prisma from '../../db.server';
import {
  billingAnalyzedThreadCountedTotal,
  billingAnalyzedThreadSkippedTotal,
} from "../metrics/definitions";

export interface BillingUsage {
  shop: string;
  periodStart: Date;
  count: number;
}

/** Returns 00:00:00 UTC of the 1st of the month containing `now`. */
export function getCurrentPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
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
    billingAnalyzedThreadSkippedTotal.inc({ shop: shop || "", reason: "invalid_input" });
    return { counted: false, alreadyAnalyzed: false };
  }

  // Atomic per-thread "first analysis" counter (H-8): the conditional
  // UPDATE + counter upsert run in a single transaction so two concurrent
  // analyses on the same thread can never both succeed and double-charge.
  // Postgres serializes the UPDATE on the row; whichever loses the race
  // sees result.count === 0 and skips the upsert.
  return prisma.$transaction(async (tx) => {
    const result = await tx.thread.updateMany({
      where: { id: threadId, shop, analyzedAt: null },
      data: { analyzedAt: new Date() },
    });

    if (result.count === 0) {
      const row = await tx.thread.findUnique({
        where: { id: threadId },
        select: { shop: true, analyzedAt: true },
      });
      if (!row || row.shop !== shop) {
        billingAnalyzedThreadSkippedTotal.inc({ shop, reason: "not_found" });
        return { counted: false, alreadyAnalyzed: false };
      }
      billingAnalyzedThreadSkippedTotal.inc({ shop, reason: "already_analyzed" });
      return { counted: false, alreadyAnalyzed: row.analyzedAt !== null };
    }

    const periodStart = getCurrentPeriodStart();
    await tx.billingUsage.upsert({
      where: { shop_periodStart: { shop, periodStart } },
      create: { shop, periodStart, analyzedThreadsCount: 1 },
      update: { analyzedThreadsCount: { increment: 1 } },
    });

    billingAnalyzedThreadCountedTotal.inc({ shop });
    return { counted: true, alreadyAnalyzed: false };
  });
}
