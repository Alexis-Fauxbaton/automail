/**
 * Scheduled plan changes (downgrades).
 *
 * Upgrades are immediate via Shopify Billing (replacementBehavior=STANDARD)
 * and don't use this module. Downgrades are deferred to the end of the
 * current paid period; we record the intent and a job applies it.
 *
 * Invariant: at most one pending (uncancelled, unapplied) change per shop.
 * Scheduling a new one cancels any existing pending one.
 */

import prisma from '../../db.server';

export interface ScheduledChange {
  id: string;
  shop: string;
  fromPlan: string;
  toPlan: string;
  effectiveAt: Date;
  createdAt: Date;
  appliedAt: Date | null;
  cancelledAt: Date | null;
}

export async function scheduleDowngrade(input: {
  shop: string;
  fromPlan: string;
  toPlan: string;
  effectiveAt: Date;
}): Promise<ScheduledChange> {
  return prisma.$transaction(async (tx) => {
    // Cancel any existing pending change for this shop.
    await tx.billingScheduledChange.updateMany({
      where: {
        shop: input.shop,
        appliedAt: null,
        cancelledAt: null,
      },
      data: { cancelledAt: new Date() },
    });

    return tx.billingScheduledChange.create({
      data: {
        shop: input.shop,
        fromPlan: input.fromPlan,
        toPlan: input.toPlan,
        effectiveAt: input.effectiveAt,
      },
    });
  });
}

export async function cancelScheduledChange(shop: string): Promise<void> {
  await prisma.billingScheduledChange.updateMany({
    where: { shop, appliedAt: null, cancelledAt: null },
    data: { cancelledAt: new Date() },
  });
}

export async function getPendingChange(shop: string): Promise<ScheduledChange | null> {
  return prisma.billingScheduledChange.findFirst({
    where: { shop, appliedAt: null, cancelledAt: null },
    orderBy: { createdAt: 'desc' },
  });
}

export async function listDueChanges(now: Date = new Date()): Promise<ScheduledChange[]> {
  return prisma.billingScheduledChange.findMany({
    where: {
      appliedAt: null,
      cancelledAt: null,
      effectiveAt: { lte: now },
    },
    orderBy: { effectiveAt: 'asc' },
  });
}

export async function markApplied(id: string): Promise<void> {
  await prisma.billingScheduledChange.update({
    where: { id },
    data: { appliedAt: new Date() },
  });
}
