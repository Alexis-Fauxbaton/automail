# Paid Plans Phase 1 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the billing foundation modules (catalog, trial, usage counter, scheduled changes, Shopify subscription reader, entitlements façade) with full unit/integration test coverage. No UI, no enforcement at call sites — that comes in Phase 2 and 3.

**Architecture:** All billing logic lives under `app/lib/billing/`. Source of truth for active plan = Shopify Billing API, cached 5 minutes per shop in memory. Usage counter = atomic Postgres upsert on `BillingUsage(shop, periodStart)`. Entitlements module is the only public façade — all consumers (call sites, UI loaders) call it.

**Tech Stack:** TypeScript, Prisma 6 + Postgres, vitest, Shopify Admin GraphQL Billing API.

**Reference spec:** [docs/superpowers/specs/2026-05-08-paid-plans-design.md](docs/superpowers/specs/2026-05-08-paid-plans-design.md)

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | Add 3 new models, drop `autoDraft` from `SupportSettings` |
| `prisma/migrations/<timestamp>_add_billing_tables/migration.sql` | Generated migration for the schema changes |
| `app/lib/billing/plans.ts` | Static plan catalog (id, price, quotas, features). Pure constants. |
| `app/lib/billing/trial.ts` | Pure functions deriving trial state from installDate. No DB. |
| `app/lib/billing/usage.ts` | Atomic counter ops (`tryReserveDraft`, `releaseDraft`, `getUsage`). Hits DB. |
| `app/lib/billing/scheduled-changes.ts` | CRUD for `BillingScheduledChange` + `applyDuePlanChanges` job. Hits DB. |
| `app/lib/billing/subscription.ts` | Shopify Billing GraphQL fetch + 5min memory cache. |
| `app/lib/billing/entitlements.ts` | Public façade: combines plan + usage + trial → boolean decisions. |
| `app/lib/billing/__tests__/plans.test.ts` | Unit |
| `app/lib/billing/__tests__/trial.test.ts` | Unit |
| `app/lib/billing/__tests__/subscription.test.ts` | Unit (mocked GraphQL) |
| `app/lib/__tests__/integration/billing-usage.test.ts` | Integration (real DB) |
| `app/lib/__tests__/integration/billing-scheduled-changes.test.ts` | Integration |
| `app/lib/__tests__/integration/billing-entitlements.test.ts` | Integration |
| `app/lib/__tests__/integration/helpers/db.ts` | Add billing tables to `cleanTestShop` |

---

## Task 1: Prisma schema — add billing tables, drop autoDraft

**Files:**
- Modify: `prisma/schema.prisma` (add 3 models, drop `autoDraft` field on line 50)
- Create: `prisma/migrations/<timestamp>_add_billing_tables/migration.sql` (generated)

- [ ] **Step 1: Add 3 new models to schema.prisma**

Append to the end of `prisma/schema.prisma`:

```prisma
// Per-shop monthly usage counter for billing quotas.
// One row per (shop, periodStart) — enforced via unique constraint.
// periodStart is always 00:00:00 UTC of the 1st of the month.
model BillingUsage {
  id           String   @id @default(cuid())
  shop         String
  periodStart  DateTime
  draftsCount  Int      @default(0)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([shop, periodStart])
  @@index([shop])
}

// Scheduled plan changes (downgrades). Applied at effectiveAt by a job.
// Upgrades are immediate via Shopify Billing API and don't use this table.
model BillingScheduledChange {
  id           String    @id @default(cuid())
  shop         String
  fromPlan     String
  toPlan       String
  effectiveAt  DateTime
  createdAt    DateTime  @default(now())
  appliedAt    DateTime?
  cancelledAt  DateTime?

  @@index([shop])
  @@index([effectiveAt, appliedAt])
}

// Per-shop billing flags (internal/dev shops bypass entitlement checks).
// installDate is used to compute trial expiry when no Shopify subscription exists yet.
model BillingShopFlag {
  shop        String   @id
  isInternal  Boolean  @default(false)
  installDate DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

- [ ] **Step 2: Drop the `autoDraft` field from `SupportSettings`**

In `prisma/schema.prisma`, in the `SupportSettings` model, delete the line:

```prisma
  autoDraft             Boolean  @default(true)           // auto-generate draft on incoming support email
```

- [ ] **Step 3: Generate the migration**

Run: `npx prisma migrate dev --name add_billing_tables --create-only`
Expected: New folder `prisma/migrations/<timestamp>_add_billing_tables/` containing `migration.sql` with `CREATE TABLE BillingUsage`, `CREATE TABLE BillingScheduledChange`, `CREATE TABLE BillingShopFlag`, and `ALTER TABLE SupportSettings DROP COLUMN autoDraft`.

- [ ] **Step 4: Inspect the migration file for correctness**

Read the generated `migration.sql` and verify:
- 3 `CREATE TABLE` statements with correct columns and indexes
- 1 `ALTER TABLE "SupportSettings" DROP COLUMN "autoDraft"` statement
- `@@unique([shop, periodStart])` translated to `CREATE UNIQUE INDEX "BillingUsage_shop_periodStart_key" ON "BillingUsage"("shop", "periodStart")`

If anything looks wrong, edit the SQL manually before applying.

- [ ] **Step 5: Apply the migration**

Run: `npx prisma migrate dev`
Expected: Migration applied, Prisma client regenerated. No errors.

- [ ] **Step 6: Verify Prisma client has the new types**

Run: `npx tsc --noEmit -p tsconfig.json | grep -i "BillingUsage\\|BillingScheduledChange\\|BillingShopFlag" || echo "no errors"`
Expected: `no errors` (the new models compile).

- [ ] **Step 7: Update integration test cleanup helper**

Modify `app/lib/__tests__/integration/helpers/db.ts`. In the `cleanTestShop` function, inside the `$transaction` block, add these lines BEFORE `await tx.supportSettings.deleteMany`:

```typescript
    await tx.billingUsage.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.billingScheduledChange.deleteMany({ where: { shop: TEST_SHOP } });
    await tx.billingShopFlag.deleteMany({ where: { shop: TEST_SHOP } });
```

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ app/lib/__tests__/integration/helpers/db.ts
git commit -m "feat(billing): add billing tables, drop autoDraft column"
```

---

## Task 2: Plans catalog (`plans.ts`)

**Files:**
- Create: `app/lib/billing/plans.ts`
- Test: `app/lib/billing/__tests__/plans.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/billing/__tests__/plans.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PLANS, getPlan, type PlanId } from '../plans';

describe('plans catalog', () => {
  it('exposes starter and pro plans', () => {
    expect(PLANS.starter).toBeDefined();
    expect(PLANS.pro).toBeDefined();
  });

  it('starter plan has expected limits', () => {
    expect(PLANS.starter.id).toBe('starter');
    expect(PLANS.starter.priceUsd).toBe(9);
    expect(PLANS.starter.draftsPerMonth).toBe(50);
    expect(PLANS.starter.maxMailboxes).toBe(1);
    expect(PLANS.starter.advancedDashboard).toBe(false);
    expect(PLANS.starter.dashboardMaxRangeDays).toBe(7);
  });

  it('pro plan has expected limits', () => {
    expect(PLANS.pro.id).toBe('pro');
    expect(PLANS.pro.priceUsd).toBe(49);
    expect(PLANS.pro.draftsPerMonth).toBe(500);
    expect(PLANS.pro.maxMailboxes).toBe(3);
    expect(PLANS.pro.advancedDashboard).toBe(true);
    expect(PLANS.pro.dashboardMaxRangeDays).toBe(90);
  });

  it('trial plan grants pro-level access for 14 days', () => {
    expect(PLANS.trial.draftsPerMonth).toBe(Infinity);
    expect(PLANS.trial.maxMailboxes).toBe(1);
    expect(PLANS.trial.advancedDashboard).toBe(true);
    expect(PLANS.trial.dashboardMaxRangeDays).toBe(90);
    expect(PLANS.trial.durationDays).toBe(14);
  });

  it('getPlan returns the right entry by id', () => {
    expect(getPlan('starter')).toBe(PLANS.starter);
    expect(getPlan('pro')).toBe(PLANS.pro);
    expect(getPlan('trial')).toBe(PLANS.trial);
  });

  it('getPlan returns null for unknown id', () => {
    // @ts-expect-error — testing runtime fallback for invalid id
    expect(getPlan('enterprise')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run app/lib/billing/__tests__/plans.test.ts`
Expected: FAIL — `Cannot find module '../plans'`.

- [ ] **Step 3: Implement `plans.ts`**

Create `app/lib/billing/plans.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run app/lib/billing/__tests__/plans.test.ts`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add app/lib/billing/plans.ts app/lib/billing/__tests__/plans.test.ts
git commit -m "feat(billing): plans catalog (starter, pro, trial)"
```

---

## Task 3: Trial state derivation (`trial.ts`)

**Files:**
- Create: `app/lib/billing/trial.ts`
- Test: `app/lib/billing/__tests__/trial.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/billing/__tests__/trial.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeTrialState } from '../trial';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('computeTrialState', () => {
  const now = new Date('2026-05-08T12:00:00Z');

  it('returns active with 14 days remaining when install just happened', () => {
    const installDate = new Date(now.getTime() - 1000); // 1 second ago
    const result = computeTrialState({ installDate, now });
    expect(result.status).toBe('active');
    expect(result.daysRemaining).toBe(14);
    expect(result.expiresAt.getTime()).toBe(installDate.getTime() + 14 * DAY_MS);
  });

  it('returns active with 7 days remaining when 7 days passed', () => {
    const installDate = new Date(now.getTime() - 7 * DAY_MS);
    const result = computeTrialState({ installDate, now });
    expect(result.status).toBe('active');
    expect(result.daysRemaining).toBe(7);
  });

  it('returns active with 1 day remaining at day 13', () => {
    const installDate = new Date(now.getTime() - 13 * DAY_MS);
    const result = computeTrialState({ installDate, now });
    expect(result.status).toBe('active');
    expect(result.daysRemaining).toBe(1);
  });

  it('returns expired exactly at 14 days', () => {
    const installDate = new Date(now.getTime() - 14 * DAY_MS);
    const result = computeTrialState({ installDate, now });
    expect(result.status).toBe('expired');
    expect(result.daysRemaining).toBe(0);
  });

  it('returns expired well after 14 days', () => {
    const installDate = new Date(now.getTime() - 30 * DAY_MS);
    const result = computeTrialState({ installDate, now });
    expect(result.status).toBe('expired');
    expect(result.daysRemaining).toBe(0);
  });

  it('rounds daysRemaining up so that "1 day left" displays for any sub-day remainder', () => {
    // 13.5 days passed → 0.5 day remaining → ceil(0.5) = 1
    const installDate = new Date(now.getTime() - 13.5 * DAY_MS);
    const result = computeTrialState({ installDate, now });
    expect(result.daysRemaining).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run app/lib/billing/__tests__/trial.test.ts`
Expected: FAIL — `Cannot find module '../trial'`.

- [ ] **Step 3: Implement `trial.ts`**

Create `app/lib/billing/trial.ts`:

```typescript
/**
 * Trial state derivation. Pure functions — no DB, no network.
 *
 * Trial duration is read from the plans catalog. The caller passes
 * the shop's installDate (looked up from BillingShopFlag) and the
 * current time; we derive whether the trial is still active and how
 * many days remain.
 */

import { PLANS } from './plans';

const DAY_MS = 24 * 60 * 60 * 1000;

export type TrialStatus = 'active' | 'expired';

export interface TrialState {
  status: TrialStatus;
  /** Days remaining (always >= 0). 0 means expired. Sub-day remainders round up. */
  daysRemaining: number;
  /** Exact moment the trial ends. */
  expiresAt: Date;
}

export interface ComputeTrialStateInput {
  installDate: Date;
  now: Date;
}

export function computeTrialState({ installDate, now }: ComputeTrialStateInput): TrialState {
  const durationDays = PLANS.trial.durationDays ?? 14;
  const expiresAt = new Date(installDate.getTime() + durationDays * DAY_MS);
  const remainingMs = expiresAt.getTime() - now.getTime();

  if (remainingMs <= 0) {
    return { status: 'expired', daysRemaining: 0, expiresAt };
  }

  return {
    status: 'active',
    daysRemaining: Math.ceil(remainingMs / DAY_MS),
    expiresAt,
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run app/lib/billing/__tests__/trial.test.ts`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add app/lib/billing/trial.ts app/lib/billing/__tests__/trial.test.ts
git commit -m "feat(billing): trial state derivation"
```

---

## Task 4: Usage counter (`usage.ts`)

**Files:**
- Create: `app/lib/billing/usage.ts`
- Test: `app/lib/__tests__/integration/billing-usage.test.ts` (integration, hits DB)

- [ ] **Step 1: Write the failing integration test**

Create `app/lib/__tests__/integration/billing-usage.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import {
  tryReserveDraft,
  releaseDraft,
  getUsage,
  getCurrentPeriodStart,
} from '../../billing/usage';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
});

describe('getCurrentPeriodStart', () => {
  it('returns the 1st of the current month at 00:00:00 UTC', () => {
    const now = new Date('2026-05-15T13:42:00Z');
    const result = getCurrentPeriodStart(now);
    expect(result.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('handles January correctly', () => {
    const now = new Date('2026-01-31T23:59:59Z');
    const result = getCurrentPeriodStart(now);
    expect(result.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('tryReserveDraft / releaseDraft / getUsage', () => {
  it('first reserve creates a row at count=1', async () => {
    const result = await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newCount).toBe(1);
    }
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(1);
  });

  it('subsequent reserves increment monotonically', async () => {
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    const r3 = await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.newCount).toBe(3);
  });

  it('refuses reserve when limit reached', async () => {
    for (let i = 0; i < 5; i++) {
      await tryReserveDraft({ shop: TEST_SHOP, limit: 5 });
    }
    const r6 = await tryReserveDraft({ shop: TEST_SHOP, limit: 5 });
    expect(r6.ok).toBe(false);
    if (!r6.ok) expect(r6.reason).toBe('quota_exceeded');
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(5); // not incremented past limit
  });

  it('releaseDraft decrements the counter', async () => {
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    await releaseDraft({ shop: TEST_SHOP });
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(1);
  });

  it('releaseDraft never goes below 0', async () => {
    await releaseDraft({ shop: TEST_SHOP });
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(0);
  });

  it('isolates counters across shops', async () => {
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    await tryReserveDraft({ shop: 'other.myshopify.com', limit: 50 });
    await tryReserveDraft({ shop: 'other.myshopify.com', limit: 50 });

    const a = await getUsage(TEST_SHOP);
    const b = await getUsage('other.myshopify.com');
    expect(a.count).toBe(1);
    expect(b.count).toBe(2);

    // Cleanup other shop
    await testDb.billingUsage.deleteMany({ where: { shop: 'other.myshopify.com' } });
  });

  it('rolls over to a new period (different periodStart)', async () => {
    const may = new Date('2026-05-15T12:00:00Z');
    const june = new Date('2026-06-02T12:00:00Z');

    await tryReserveDraft({ shop: TEST_SHOP, limit: 50, now: may });
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50, now: may });
    await tryReserveDraft({ shop: TEST_SHOP, limit: 50, now: june });

    const mayUsage = await getUsage(TEST_SHOP, may);
    const juneUsage = await getUsage(TEST_SHOP, june);
    expect(mayUsage.count).toBe(2);
    expect(juneUsage.count).toBe(1);
  });
});

describe('tryReserveDraft — race conditions', () => {
  it('two concurrent reserves at limit-1 result in one success and one quota_exceeded', async () => {
    // Pre-fill to 49/50
    for (let i = 0; i < 49; i++) {
      await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    }

    const [a, b] = await Promise.all([
      tryReserveDraft({ shop: TEST_SHOP, limit: 50 }),
      tryReserveDraft({ shop: TEST_SHOP, limit: 50 }),
    ]);

    const successes = [a, b].filter((r) => r.ok).length;
    const failures = [a, b].filter((r) => !r.ok).length;
    expect(successes).toBe(1);
    expect(failures).toBe(1);

    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(50); // exactly at limit
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run test:integration -- billing-usage`
Expected: FAIL — `Cannot find module '../../billing/usage'`.

- [ ] **Step 3: Implement `usage.ts`**

Create `app/lib/billing/usage.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run test:integration -- billing-usage`
Expected: PASS — 9 tests passing (including the race condition test).

- [ ] **Step 5: Commit**

```bash
git add app/lib/billing/usage.ts app/lib/__tests__/integration/billing-usage.test.ts
git commit -m "feat(billing): atomic usage counter with race-safe reserve"
```

---

## Task 5: Scheduled plan changes (`scheduled-changes.ts`)

**Files:**
- Create: `app/lib/billing/scheduled-changes.ts`
- Test: `app/lib/__tests__/integration/billing-scheduled-changes.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `app/lib/__tests__/integration/billing-scheduled-changes.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import {
  scheduleDowngrade,
  cancelScheduledChange,
  getPendingChange,
  listDueChanges,
  markApplied,
} from '../../billing/scheduled-changes';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
});

describe('scheduleDowngrade', () => {
  it('creates a pending change row', async () => {
    const effectiveAt = new Date('2026-06-01T00:00:00Z');
    const change = await scheduleDowngrade({
      shop: TEST_SHOP,
      fromPlan: 'pro',
      toPlan: 'starter',
      effectiveAt,
    });

    expect(change.fromPlan).toBe('pro');
    expect(change.toPlan).toBe('starter');
    expect(change.effectiveAt.toISOString()).toBe(effectiveAt.toISOString());
    expect(change.appliedAt).toBeNull();
    expect(change.cancelledAt).toBeNull();
  });

  it('cancels any prior pending change for the same shop before creating a new one', async () => {
    const dateA = new Date('2026-06-01T00:00:00Z');
    const dateB = new Date('2026-07-01T00:00:00Z');

    const a = await scheduleDowngrade({
      shop: TEST_SHOP, fromPlan: 'pro', toPlan: 'starter', effectiveAt: dateA,
    });
    const b = await scheduleDowngrade({
      shop: TEST_SHOP, fromPlan: 'pro', toPlan: 'starter', effectiveAt: dateB,
    });

    const aReloaded = await testDb.billingScheduledChange.findUnique({ where: { id: a.id } });
    expect(aReloaded?.cancelledAt).not.toBeNull();

    const pending = await getPendingChange(TEST_SHOP);
    expect(pending?.id).toBe(b.id);
  });
});

describe('cancelScheduledChange', () => {
  it('marks the pending change as cancelled', async () => {
    const change = await scheduleDowngrade({
      shop: TEST_SHOP, fromPlan: 'pro', toPlan: 'starter',
      effectiveAt: new Date('2026-06-01T00:00:00Z'),
    });

    await cancelScheduledChange(TEST_SHOP);

    const reloaded = await testDb.billingScheduledChange.findUnique({ where: { id: change.id } });
    expect(reloaded?.cancelledAt).not.toBeNull();

    const pending = await getPendingChange(TEST_SHOP);
    expect(pending).toBeNull();
  });
});

describe('getPendingChange', () => {
  it('returns null when nothing is scheduled', async () => {
    const result = await getPendingChange(TEST_SHOP);
    expect(result).toBeNull();
  });

  it('ignores already-applied changes', async () => {
    const change = await scheduleDowngrade({
      shop: TEST_SHOP, fromPlan: 'pro', toPlan: 'starter',
      effectiveAt: new Date('2026-06-01T00:00:00Z'),
    });
    await markApplied(change.id);
    const pending = await getPendingChange(TEST_SHOP);
    expect(pending).toBeNull();
  });
});

describe('listDueChanges', () => {
  it('returns only changes whose effectiveAt is <= now and not yet applied or cancelled', async () => {
    const past = new Date('2026-04-01T00:00:00Z');
    const future = new Date('2026-12-01T00:00:00Z');

    const due = await scheduleDowngrade({
      shop: TEST_SHOP, fromPlan: 'pro', toPlan: 'starter', effectiveAt: past,
    });
    await scheduleDowngrade({
      shop: 'other.myshopify.com', fromPlan: 'pro', toPlan: 'starter', effectiveAt: future,
    });

    const now = new Date('2026-05-08T00:00:00Z');
    const list = await listDueChanges(now);
    expect(list.map((c) => c.id)).toContain(due.id);
    expect(list.map((c) => c.shop)).not.toContain('other.myshopify.com');

    // Cleanup
    await testDb.billingScheduledChange.deleteMany({ where: { shop: 'other.myshopify.com' } });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run test:integration -- billing-scheduled-changes`
Expected: FAIL — `Cannot find module '../../billing/scheduled-changes'`.

- [ ] **Step 3: Implement `scheduled-changes.ts`**

Create `app/lib/billing/scheduled-changes.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run test:integration -- billing-scheduled-changes`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add app/lib/billing/scheduled-changes.ts app/lib/__tests__/integration/billing-scheduled-changes.test.ts
git commit -m "feat(billing): scheduled plan changes (downgrades)"
```

---

## Task 6: Subscription reader with cache (`subscription.ts`)

**Files:**
- Create: `app/lib/billing/subscription.ts`
- Test: `app/lib/billing/__tests__/subscription.test.ts`

The Shopify Admin GraphQL query for current subscription:

```graphql
query CurrentAppInstallation {
  currentAppInstallation {
    activeSubscriptions {
      id
      name
      status
      trialDays
      createdAt
      currentPeriodEnd
      lineItems {
        plan {
          pricingDetails {
            ... on AppRecurringPricing {
              price { amount }
              interval
            }
          }
        }
      }
    }
  }
}
```

`name` is the human-readable plan name we set when creating the subscription (e.g. `"starter"` or `"pro"`). We'll standardize on lowercase plan IDs as the subscription name when we create subscriptions in Phase 2.

- [ ] **Step 1: Write the failing test**

Create `app/lib/billing/__tests__/subscription.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveActivePlan, __resetCacheForTests } from '../subscription';

type FakeAdminClient = {
  graphql: ReturnType<typeof vi.fn>;
};

function makeClient(activeSubscriptions: any[]): FakeAdminClient {
  return {
    graphql: vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          currentAppInstallation: { activeSubscriptions },
        },
      }),
    }),
  };
}

beforeEach(() => {
  __resetCacheForTests();
});

describe('resolveActivePlan', () => {
  it('returns "none" when no active subscriptions', async () => {
    const client = makeClient([]);
    const result = await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(result.plan).toBe('none');
  });

  it('returns "starter" when an active starter subscription exists', async () => {
    const client = makeClient([
      {
        id: 'gid://shopify/AppSubscription/1',
        name: 'starter',
        status: 'ACTIVE',
        trialDays: 14,
        createdAt: '2026-05-01T00:00:00Z',
        currentPeriodEnd: '2026-06-01T00:00:00Z',
      },
    ]);
    const result = await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(result.plan).toBe('starter');
    expect(result.subscriptionId).toBe('gid://shopify/AppSubscription/1');
    expect(result.currentPeriodEnd?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('returns "pro" when an active pro subscription exists', async () => {
    const client = makeClient([
      {
        id: 'gid://shopify/AppSubscription/2',
        name: 'pro',
        status: 'ACTIVE',
        trialDays: 14,
        createdAt: '2026-05-01T00:00:00Z',
        currentPeriodEnd: '2026-06-01T00:00:00Z',
      },
    ]);
    const result = await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(result.plan).toBe('pro');
  });

  it('caches the result for 5 minutes', async () => {
    const client = makeClient([
      { id: 'gid://1', name: 'pro', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
    ]);
    await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(client.graphql).toHaveBeenCalledTimes(1);
  });

  it('isolates cache per shop', async () => {
    const c1 = makeClient([{ id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' }]);
    const c2 = makeClient([{ id: 'gid://2', name: 'pro',     status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' }]);

    const a = await resolveActivePlan({ shop: 'a.myshopify.com', admin: c1 as any });
    const b = await resolveActivePlan({ shop: 'b.myshopify.com', admin: c2 as any });
    expect(a.plan).toBe('starter');
    expect(b.plan).toBe('pro');
  });

  it('ignores subscriptions with status != ACTIVE', async () => {
    const client = makeClient([
      { id: 'gid://1', name: 'pro', status: 'CANCELLED', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
    ]);
    const result = await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(result.plan).toBe('none');
  });

  it('returns "none" with unknown plan name', async () => {
    const client = makeClient([
      { id: 'gid://1', name: 'enterprise', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
    ]);
    const result = await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(result.plan).toBe('none');
  });
});

describe('cache invalidation', () => {
  it('__resetCacheForTests clears the cache', async () => {
    const client = makeClient([
      { id: 'gid://1', name: 'pro', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
    ]);
    await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    __resetCacheForTests();
    await resolveActivePlan({ shop: 'shop1.myshopify.com', admin: client as any });
    expect(client.graphql).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run app/lib/billing/__tests__/subscription.test.ts`
Expected: FAIL — `Cannot find module '../subscription'`.

- [ ] **Step 3: Implement `subscription.ts`**

Create `app/lib/billing/subscription.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run app/lib/billing/__tests__/subscription.test.ts`
Expected: PASS — 8 tests passing.

- [ ] **Step 5: Commit**

```bash
git add app/lib/billing/subscription.ts app/lib/billing/__tests__/subscription.test.ts
git commit -m "feat(billing): subscription reader with 5min cache"
```

---

## Task 7: Entitlements façade (`entitlements.ts`)

This is the only module that consumers (call sites, route loaders) will import. It composes `subscription`, `trial`, `usage`, and `BillingShopFlag` to produce all entitlement decisions.

**Files:**
- Create: `app/lib/billing/entitlements.ts`
- Test: `app/lib/__tests__/integration/billing-entitlements.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `app/lib/__tests__/integration/billing-entitlements.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import {
  resolveEntitlements,
  __resetCacheForTests,
} from '../../billing/entitlements';

const DAY_MS = 24 * 60 * 60 * 1000;

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
  __resetCacheForTests();
});

function makeAdmin(activeSubscriptions: any[]) {
  return {
    graphql: vi.fn().mockResolvedValue({
      json: async () => ({
        data: { currentAppInstallation: { activeSubscriptions } },
      }),
    }),
  };
}

async function setInstallDate(shop: string, installDate: Date) {
  await testDb.billingShopFlag.upsert({
    where: { shop },
    create: { shop, installDate },
    update: { installDate },
  });
}

describe('resolveEntitlements — trial active, no subscription', () => {
  it('grants pro-level access during trial', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 2 * DAY_MS));

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([]) as any,
      now,
    });

    expect(ent.state).toBe('trial_active');
    expect(ent.planId).toBe('trial');
    expect(ent.canGenerateDraft).toBe(true);
    expect(ent.canConnectMailbox).toBe(true);
    expect(ent.canViewAdvancedDashboard).toBe(true);
    expect(ent.trialDaysRemaining).toBe(12);
    expect(ent.quotaStatus.limit).toBe(Infinity);
  });
});

describe('resolveEntitlements — trial expired, no subscription', () => {
  it('blocks all writes', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([]) as any,
      now,
    });

    expect(ent.state).toBe('trial_expired');
    expect(ent.canGenerateDraft).toBe(false);
    expect(ent.canConnectMailbox).toBe(false);
    expect(ent.canViewAdvancedDashboard).toBe(false);
  });
});

describe('resolveEntitlements — starter active', () => {
  it('reports starter limits', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([
        { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
      ]) as any,
      now,
    });

    expect(ent.state).toBe('paid_active');
    expect(ent.planId).toBe('starter');
    expect(ent.quotaStatus.limit).toBe(50);
    expect(ent.canViewAdvancedDashboard).toBe(false);
  });

  it('flags warning at 80%', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date('2026-05-01T00:00:00Z'),
        draftsCount: 40, // 40/50 = 80%
      },
    });

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([
        { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
      ]) as any,
      now,
    });

    expect(ent.quotaStatus.level).toBe('warning');
    expect(ent.canGenerateDraft).toBe(true);
  });

  it('blocks generation at 100%', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date('2026-05-01T00:00:00Z'),
        draftsCount: 50,
      },
    });

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([
        { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
      ]) as any,
      now,
    });

    expect(ent.quotaStatus.level).toBe('exceeded');
    expect(ent.canGenerateDraft).toBe(false);
  });
});

describe('resolveEntitlements — internal flag bypass', () => {
  it('grants pro-level entitlements when isInternal=true regardless of plan', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await testDb.billingShopFlag.create({
      data: { shop: TEST_SHOP, isInternal: true, installDate: new Date(now.getTime() - 30 * DAY_MS) },
    });

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([]) as any, // no subscription, no trial
      now,
    });

    expect(ent.state).toBe('internal');
    expect(ent.canGenerateDraft).toBe(true);
    expect(ent.canConnectMailbox).toBe(true);
    expect(ent.canViewAdvancedDashboard).toBe(true);
  });
});

describe('resolveEntitlements — mailbox quota', () => {
  it('canConnectMailbox=false when starter has 1 mailbox connected', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        email: 'a@example.com',
        accessToken: 'x',
        refreshToken: 'x',
        tokenExpiry: new Date(),
      },
    });

    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([
        { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
      ]) as any,
      now,
    });

    expect(ent.canConnectMailbox).toBe(false);
    expect(ent.mailboxStatus.used).toBe(1);
    expect(ent.mailboxStatus.limit).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run test:integration -- billing-entitlements`
Expected: FAIL — `Cannot find module '../../billing/entitlements'`.

- [ ] **Step 3: Implement `entitlements.ts`**

Create `app/lib/billing/entitlements.ts`:

```typescript
/**
 * Public façade for billing entitlements.
 *
 * Composition:
 *   - subscription.resolveActivePlan → paid plan (or "none")
 *   - trial.computeTrialState        → trial active/expired
 *   - usage.getUsage                 → current period draft count
 *   - mailConnection count           → mailbox usage
 *   - BillingShopFlag.isInternal     → bypass for dev/test shops
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

  const flag = await prisma.billingShopFlag.findUnique({ where: { shop: input.shop } });
  if (!flag) {
    // First-touch: create the row with installDate=now so trial starts ticking.
    await prisma.billingShopFlag.create({ data: { shop: input.shop, installDate: now } });
  }
  const installDate = flag?.installDate ?? now;
  const isInternal = flag?.isInternal ?? false;

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
  const periodStart = getCurrentPeriodStart(input.now);
  return {
    shop: input.shop,
    state: 'trial_active',
    planId: 'trial',
    plan,
    canGenerateDraft: true,
    canConnectMailbox: input.mailboxCount < plan.maxMailboxes,
    canViewAdvancedDashboard: true,
    trialDaysRemaining: input.trialDaysRemaining,
    trialExpiresAt: input.trialExpiresAt,
    quotaStatus: { used: 0, limit: Infinity, pct: 0, level: 'ok', periodStart },
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
  const periodStart = getCurrentPeriodStart(input.now);
  return {
    shop: input.shop,
    state: 'trial_expired',
    planId: null,
    plan: null,
    canGenerateDraft: false,
    canConnectMailbox: false,
    canViewAdvancedDashboard: false,
    trialDaysRemaining: 0,
    trialExpiresAt: input.trialExpiresAt,
    quotaStatus: { used: 0, limit: 0, pct: 0, level: 'exceeded', periodStart },
    mailboxStatus: { used: input.mailboxCount, limit: 0 },
    dashboardMaxRangeDays: 7,
  };
}

// Keep the import bound so tree-shaking doesn't drop the manual cache invalidator.
// (It's used by the app_subscriptions/update webhook in Phase 2.)
void invalidateSubscriptionCache;

/** Test-only — resets the underlying subscription cache. */
export function __resetCacheForTests(): void {
  __resetSubscriptionCacheForTests();
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run test:integration -- billing-entitlements`
Expected: PASS — 7 tests passing.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `npm test`
Expected: All existing tests still pass. The new billing tests run in unit suite. Run `npm run test:integration` separately to confirm.

- [ ] **Step 6: Typecheck the whole project**

Run: `npm run typecheck`
Expected: No errors. The dropped `autoDraft` field should not be referenced anywhere in `app/`. If it is (we'll know from typecheck errors), the cleanup belongs in Phase 5; for now, fix only minimal references to make typecheck pass — typically just removing the field from the `SaveSettingsInput` interface and the loader/action in `app.settings.tsx`.

If typecheck fails on `autoDraft` references that aren't in scope of Phase 1 cleanup, document them in a follow-up note inside this plan and ask before proceeding. Do not silently delete unrelated code.

- [ ] **Step 7: Commit**

```bash
git add app/lib/billing/entitlements.ts app/lib/__tests__/integration/billing-entitlements.test.ts
git commit -m "feat(billing): entitlements façade composing plan/trial/usage/internal flag"
```

---

## Phase 1 Wrap-up

- [ ] **Step 1: Verify all 7 modules compile and tests pass**

Run: `npm run typecheck && npm test && npm run test:integration -- billing-`
Expected: All green. 6 new test files (~40+ test cases).

- [ ] **Step 2: Verify the file structure**

Run (PowerShell): `Get-ChildItem -Recurse app\lib\billing | Select-Object FullName`
Expected output includes:
```
app\lib\billing\plans.ts
app\lib\billing\trial.ts
app\lib\billing\usage.ts
app\lib\billing\subscription.ts
app\lib\billing\scheduled-changes.ts
app\lib\billing\entitlements.ts
app\lib\billing\__tests__\plans.test.ts
app\lib\billing\__tests__\trial.test.ts
app\lib\billing\__tests__\subscription.test.ts
```

And under `app\lib\__tests__\integration\`:
```
billing-usage.test.ts
billing-scheduled-changes.test.ts
billing-entitlements.test.ts
```

- [ ] **Step 3: Confirm the migration applied cleanly**

Run: `npx prisma migrate status`
Expected: `Database schema is up to date!` and the `add_billing_tables` migration listed as applied.

- [ ] **Step 4: Final commit (if anything still uncommitted)**

```bash
git status
# If any uncommitted files, review and commit with a descriptive message
```

---

## Out of scope for Phase 1 (handled in subsequent phases)

- **Phase 2:** Billing UI (`/app/billing` page), `appSubscriptionCreate` route, `appSubscriptionCancel` route, `app_subscriptions/update` webhook, top bar counter component, banners, modals.
- **Phase 3:** Wiring `entitlements.canGenerateDraft` into `api.reply-draft.tsx`, `app.support.tsx`, `refine-draft.ts`. Mailbox limit at `mail-auth.tsx`. Dashboard gating.
- **Phase 4:** `auto-sync.ts` suspend/resume logic, 48h zone catch-up, "À analyser" folder UI.
- **Phase 5:** Migrate existing shops (set `installDate` to now, mark as trial), full `autoDraft` cleanup including UI removal in `app.settings.tsx` and i18n strings, privacy policy update, App Listing prep.

## Self-review notes

- Spec coverage:
  - Plans catalog ✅ Task 2
  - Trial state ✅ Task 3
  - Usage counter atomic ✅ Task 4
  - Scheduled downgrade ✅ Task 5
  - Subscription cache ✅ Task 6
  - Entitlements façade ✅ Task 7
  - Schema for `BillingUsage`, `BillingScheduledChange`, `BillingShopFlag`, drop `autoDraft` ✅ Task 1
  - Internal shop bypass ✅ Task 7
- All test code shown inline.
- All implementation code shown inline.
- Type names consistent across tasks (`PlanId`, `PlanDefinition`, `Entitlements`, `QuotaStatus`).
- No "TBD" / "TODO" placeholders.
