/**
 * Static catalog of billing plans.
 *
 * Source of truth for plan definitions on the server side. The Shopify
 * Billing API stores prices and trial info; this module mirrors the
 * structural data (limits, features) needed by entitlement checks.
 *
 * Trial is treated here as a "plan" for entitlement purposes (pro-level
 * features, illimited drafts, 14 days). The actual trial countdown lives
 * in `trial.ts`.
 */

export type PlanId = 'trial' | 'starter' | 'pro';

export interface PlanDefinition {
  id: PlanId;
  priceUsd: number;
  draftsPerMonth: number;
  maxMailboxes: number;
  advancedDashboard: boolean;
  dashboardMaxRangeDays: number;
  /** Only set on the trial pseudo-plan. */
  durationDays?: number;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  trial: {
    id: 'trial',
    priceUsd: 0,
    draftsPerMonth: Infinity,
    maxMailboxes: 1,
    advancedDashboard: true,
    dashboardMaxRangeDays: 90,
    durationDays: 14,
  },
  starter: {
    id: 'starter',
    priceUsd: 9,
    draftsPerMonth: 50,
    maxMailboxes: 1,
    advancedDashboard: false,
    dashboardMaxRangeDays: 7,
  },
  pro: {
    id: 'pro',
    priceUsd: 49,
    draftsPerMonth: 500,
    maxMailboxes: 3,
    advancedDashboard: true,
    dashboardMaxRangeDays: 90,
  },
};

export function getPlan(id: string): PlanDefinition | null {
  if (id === 'trial' || id === 'starter' || id === 'pro') {
    return PLANS[id];
  }
  return null;
}
