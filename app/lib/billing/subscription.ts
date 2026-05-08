/**
 * Active plan resolution from Shopify Billing API + 5min memory cache.
 *
 * Source of truth for "what plan is this shop on right now". The cache
 * is invalidated automatically after 5 minutes; manual invalidation is
 * available via `invalidateCache(shop)` (called by the
 * app_subscriptions/update webhook in Phase 2).
 *
 * Trial state is NOT computed here — see `trial.ts` and `entitlements.ts`.
 * This module only reports paid plan presence.
 */

import { getPlan, type PlanId } from './plans';

export type ResolvedPlan =
  | { plan: PlanId; subscriptionId: string; currentPeriodEnd: Date }
  | { plan: 'none'; subscriptionId: null; currentPeriodEnd: null };

interface CacheEntry {
  result: ResolvedPlan;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

interface AdminClient {
  graphql: (query: string, options?: any) => Promise<{ json: () => Promise<any> }>;
}

const QUERY = `#graphql
  query CurrentAppInstallation {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        trialDays
        createdAt
        currentPeriodEnd
      }
    }
  }
`;

export async function resolveActivePlan(input: {
  shop: string;
  admin: AdminClient;
  now?: number;
}): Promise<ResolvedPlan> {
  const now = input.now ?? Date.now();
  const cached = cache.get(input.shop);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const response = await input.admin.graphql(QUERY);
  const body = await response.json();
  const subs = body?.data?.currentAppInstallation?.activeSubscriptions ?? [];

  const active = subs.find((s: any) => s.status === 'ACTIVE');
  let result: ResolvedPlan;

  if (!active) {
    result = { plan: 'none', subscriptionId: null, currentPeriodEnd: null };
  } else {
    const plan = getPlan(active.name);
    if (!plan || plan.id === 'trial') {
      // Unknown plan name or trial — trial isn't a Shopify subscription, so
      // an "active trial" subscription would be a misconfiguration we ignore.
      result = { plan: 'none', subscriptionId: null, currentPeriodEnd: null };
    } else {
      result = {
        plan: plan.id,
        subscriptionId: active.id,
        currentPeriodEnd: new Date(active.currentPeriodEnd),
      };
    }
  }

  cache.set(input.shop, { result, expiresAt: now + CACHE_TTL_MS });
  return result;
}

export function invalidateCache(shop: string): void {
  cache.delete(shop);
}

/** Test-only — resets the in-memory cache. */
export function __resetCacheForTests(): void {
  cache.clear();
}
