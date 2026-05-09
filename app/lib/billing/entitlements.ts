/**
 * Public façade for billing entitlements.
 *
 * Composition:
 *   - subscription.resolveActivePlan → paid plan (or "none")
 *   - trial.computeTrialState        → trial active/expired
 *   - usage.getUsage                 → current period draft count
 *   - mailConnection count           → mailbox usage
 *   - ShopFlag.isInternal     → bypass for dev/test shops
 *
 * Everything is composed into a single `Entitlements` record consumed by
 * route loaders, action handlers, and UI components. Loaders should call
 * this once per request and pass the result down via React context.
 */

import prisma from '../../db.server';
import { PLANS, type PlanId, type PlanDefinition } from './plans';
import { computeTrialState } from './trial';
import {
  resolveActivePlan,
  invalidateCache as invalidateSubscriptionCache,
  __resetCacheForTests as __resetSubscriptionCacheForTests,
} from './subscription';
import { getUsage, getCurrentPeriodStart } from './usage';

export type EntitlementState =
  | 'trial_active'
  | 'trial_expired'
  | 'paid_active'
  | 'internal';

export type QuotaLevel = 'ok' | 'warning' | 'critical' | 'exceeded';

export interface QuotaStatus {
  used: number;
  limit: number; // Infinity for trial / internal
  pct: number;   // 0-1, capped at 1
  level: QuotaLevel;
  periodStart: Date;
}

export interface MailboxStatus {
  used: number;
  limit: number;
}

export interface Entitlements {
  shop: string;
  state: EntitlementState;
  planId: PlanId | null;
  plan: PlanDefinition | null;
  canGenerateDraft: boolean;
  canConnectMailbox: boolean;
  canViewAdvancedDashboard: boolean;
  /** True when auto-sync should pause for this shop. Derived from state + quota. */
  isSyncSuspended: boolean;
  trialDaysRemaining: number | null;
  trialExpiresAt: Date | null;
  quotaStatus: QuotaStatus;
  mailboxStatus: MailboxStatus;
  /** Maximum dashboard range allowed for this plan. */
  dashboardMaxRangeDays: number;
}

interface AdminClient {
  graphql: (query: string, options?: any) => Promise<{ json: () => Promise<any> }>;
}

interface ResolveInput {
  shop: string;
  admin: AdminClient;
  now?: Date;
}

export async function resolveEntitlements(input: ResolveInput): Promise<Entitlements> {
  const now = input.now ?? new Date();

  const flag = await prisma.shopFlag.upsert({
    where: { shop: input.shop },
    create: { shop: input.shop, installDate: now },
    update: {},
  });
  const installDate = flag.installDate;
  const isInternal = flag.isInternal;

  // Internal bypass — pro-level entitlements with infinite quota.
  if (isInternal) {
    return buildInternalEntitlements(input.shop, now);
  }

  // Paid subscription resolution.
  const active = await resolveActivePlan({ shop: input.shop, admin: input.admin });

  // Trial state (only relevant if no paid plan).
  const trial = computeTrialState({ installDate, now });

  // Mailbox usage (always read).
  const mailboxCount = await prisma.mailConnection.count({ where: { shop: input.shop } });

  if (active.plan !== 'none') {
    return buildPaidEntitlements({
      shop: input.shop,
      planId: active.plan,
      mailboxCount,
      now,
    });
  }

  if (trial.status === 'active') {
    return buildTrialActiveEntitlements({
      shop: input.shop,
      mailboxCount,
      trialDaysRemaining: trial.daysRemaining,
      trialExpiresAt: trial.expiresAt,
      now,
    });
  }

  return buildTrialExpiredEntitlements({
    shop: input.shop,
    mailboxCount,
    trialExpiresAt: trial.expiresAt,
    now,
  });
}

function computeQuotaStatus(used: number, limit: number, periodStart: Date): QuotaStatus {
  if (!Number.isFinite(limit)) {
    return { used, limit, pct: 0, level: 'ok', periodStart };
  }
  const pct = Math.min(used / limit, 1);
  let level: QuotaLevel;
  if (used >= limit) level = 'exceeded';
  else if (pct >= 0.95) level = 'critical';
  else if (pct >= 0.8) level = 'warning';
  else level = 'ok';
  return { used, limit, pct, level, periodStart };
}

function buildInternalEntitlements(shop: string, now: Date): Entitlements {
  const periodStart = getCurrentPeriodStart(now);
  return {
    shop,
    state: 'internal',
    planId: 'pro',
    plan: PLANS.pro,
    canGenerateDraft: true,
    canConnectMailbox: true,
    canViewAdvancedDashboard: true,
    isSyncSuspended: false,
    trialDaysRemaining: null,
    trialExpiresAt: null,
    quotaStatus: { used: 0, limit: Infinity, pct: 0, level: 'ok', periodStart },
    mailboxStatus: { used: 0, limit: Infinity },
    dashboardMaxRangeDays: PLANS.pro.dashboardMaxRangeDays,
  };
}

async function buildPaidEntitlements(input: {
  shop: string;
  planId: PlanId;
  mailboxCount: number;
  now: Date;
}): Promise<Entitlements> {
  const plan = PLANS[input.planId];
  const usage = await getUsage(input.shop, input.now);
  const quotaStatus = computeQuotaStatus(usage.count, plan.draftsPerMonth, usage.periodStart);

  return {
    shop: input.shop,
    state: 'paid_active',
    planId: input.planId,
    plan,
    canGenerateDraft: quotaStatus.level !== 'exceeded',
    canConnectMailbox: input.mailboxCount < plan.maxMailboxes,
    canViewAdvancedDashboard: plan.advancedDashboard,
    isSyncSuspended: quotaStatus.level === 'exceeded',
    trialDaysRemaining: null,
    trialExpiresAt: null,
    quotaStatus,
    mailboxStatus: { used: input.mailboxCount, limit: plan.maxMailboxes },
    dashboardMaxRangeDays: plan.dashboardMaxRangeDays,
  };
}

async function buildTrialActiveEntitlements(input: {
  shop: string;
  mailboxCount: number;
  trialDaysRemaining: number;
  trialExpiresAt: Date;
  now: Date;
}): Promise<Entitlements> {
  const plan = PLANS.trial;
  const usage = await getUsage(input.shop, input.now);
  return {
    shop: input.shop,
    state: 'trial_active',
    planId: 'trial',
    plan,
    canGenerateDraft: true,
    canConnectMailbox: input.mailboxCount < plan.maxMailboxes,
    canViewAdvancedDashboard: true,
    isSyncSuspended: false,
    trialDaysRemaining: input.trialDaysRemaining,
    trialExpiresAt: input.trialExpiresAt,
    quotaStatus: { used: usage.count, limit: Infinity, pct: 0, level: 'ok', periodStart: usage.periodStart },
    mailboxStatus: { used: input.mailboxCount, limit: plan.maxMailboxes },
    dashboardMaxRangeDays: plan.dashboardMaxRangeDays,
  };
}

async function buildTrialExpiredEntitlements(input: {
  shop: string;
  mailboxCount: number;
  trialExpiresAt: Date;
  now: Date;
}): Promise<Entitlements> {
  const usage = await getUsage(input.shop, input.now);
  return {
    shop: input.shop,
    state: 'trial_expired',
    planId: null,
    plan: null,
    canGenerateDraft: false,
    canConnectMailbox: false,
    canViewAdvancedDashboard: false,
    isSyncSuspended: true,
    trialDaysRemaining: 0,
    trialExpiresAt: input.trialExpiresAt,
    quotaStatus: { used: usage.count, limit: 0, pct: 0, level: 'exceeded', periodStart: usage.periodStart },
    mailboxStatus: { used: input.mailboxCount, limit: 0 },
    dashboardMaxRangeDays: PLANS.starter.dashboardMaxRangeDays,
  };
}

// Keep the import bound so tree-shaking doesn't drop the manual cache invalidator.
// (It's used by the app_subscriptions/update webhook in Phase 2.)
void invalidateSubscriptionCache;

/** Test-only — resets the underlying subscription cache. */
export function __resetCacheForTests(): void {
  __resetSubscriptionCacheForTests();
}
