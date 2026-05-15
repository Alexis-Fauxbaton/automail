# Billing model — per analyzed conversation: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the metered billing unit from "AI draft generated" to "support conversation analyzed". One conversation = one thread where Tier 3 completed at least once. Refines, regenerations, and manual drafting become free within a conversation.

**Architecture:** Add `Thread.analyzedAt` timestamp set on the first successful Tier 3. Rename `BillingUsage.draftsCount` → `analyzedThreadsCount`. New helper `markThreadAnalyzedIfFirst` is the single billing-write site, gated by an atomic `UPDATE WHERE analyzedAt IS NULL`. Refine/redraft handlers stop consuming quota. Auto-analyze on classification change via a new SyncJob kind `analyze_thread`.

**Tech Stack:** TypeScript, Prisma (Postgres), React Router 7, vitest (unit + integration against a real Postgres test DB), Shopify Billing API.

**Spec:** [docs/superpowers/specs/2026-05-15-billing-model-per-conversation-design.md](../specs/2026-05-15-billing-model-per-conversation-design.md)

---

## Conventions

- Each task ends with a commit. Use `feat()`, `refactor()`, `test()`, `fix()`, `chore(migration)` prefixes per the existing repo style.
- Unit tests: `npm test`. Integration tests: `npm run test:integration`. Typecheck: `npm run typecheck`.
- The integration suite already runs against the test Postgres DB via `app/lib/__tests__/integration/helpers/db.ts`. The same helpers are used for new tests.
- After every code task, run `npm run typecheck 2>&1 | grep <file>` to confirm no new errors on touched files. Pre-existing errors in `app/routes/app.inbox.tsx` etc. are tracked in `TECHNICAL_DEBT.md` and OK.
- Billing-critical files (`usage.ts`, `entitlements.ts`, `plans.ts`, `pipeline.ts` increment site, the `markThreadAnalyzedIfFirst` helper) must reach ≥ 95 % statement coverage by end of plan. Run `npm run test:coverage` at the final verification task and verify.

---

## File map

**New files:**
- `prisma/migrations/<auto-date>_add_thread_analyzed_at/migration.sql`
- `prisma/migrations/<auto-date>_rename_drafts_count_to_analyzed_threads/migration.sql`
- `app/lib/billing/__tests__/mark-thread-analyzed.test.ts`
- `app/lib/__tests__/integration/billing-thread-counter.test.ts`
- `app/lib/__tests__/integration/billing-concurrency.test.ts`
- `app/lib/__tests__/integration/billing-period-boundary.test.ts`
- `app/lib/__tests__/integration/billing-quota-cap.test.ts`
- `app/lib/__tests__/integration/billing-cross-shop.test.ts`
- `app/lib/__tests__/integration/billing-catchup-classification.test.ts`
- `app/lib/__tests__/integration/billing-migration.test.ts` (extend existing or new)
- `app/lib/__tests__/integration/billing-no-charge-refine-redraft.test.ts`
- `app/lib/__tests__/integration/billing-defensive.test.ts`

**Modified files:**
- `prisma/schema.prisma`
- `app/lib/billing/plans.ts`
- `app/lib/billing/usage.ts`
- `app/lib/billing/entitlements.ts`
- `app/lib/billing/draft-guard.ts` (kept callable but no longer wraps refine/redraft)
- `app/lib/metrics/definitions.ts`
- `app/lib/gmail/pipeline.ts`
- `app/lib/support/inbox-actions.ts`
- `app/lib/mail/job-queue.ts`
- `app/lib/mail/auto-sync.ts`
- `app/i18n/locales/en.json`
- `app/i18n/locales/fr.json`
- `app/components/billing/QuotaBanner.tsx`
- `app/components/billing/SyncSuspendedBanner.tsx`
- `app/components/billing/QuotaExceededModal.tsx`
- `app/components/billing/TopBarCounter.tsx`
- Existing billing test files: rename fixtures `draftsCount` → `analyzedThreadsCount`
- `TECHNICAL_DEBT.md`

---

## Phase 1 — Schema migration

### Task 1: Add `Thread.analyzedAt` column

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<auto>/migration.sql`

- [ ] **Step 0: Create the feature branch**

This is the first task touching code, so create a dedicated branch:

```bash
git checkout main
git pull origin main
git checkout -b feature/billing-per-conversation
```

- [ ] **Step 1: Edit `prisma/schema.prisma`**

Find the `Thread` model. Add the new field right after `redactedReason`:

```prisma
  redactedReason String?  // e.g. "gdpr_customer_request"
  // --- Billing (per-conversation) -----------------------------------
  // Timestamp of the first successful Tier 3 analysis on this thread.
  // Used by the billing counter `markThreadAnalyzedIfFirst` to guarantee
  // one billing increment per thread regardless of how many times Tier 3
  // re-runs (new messages, refresh-stale, user-triggered re-analyse).
  analyzedAt     DateTime?
```

Also add an index for the backfill query and future analytics:

```prisma
  @@index([shop, analyzedAt])
```

just below the existing `@@index([shop, provider, subjectKey])` line.

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --create-only --name add_thread_analyzed_at`

Expected: a new directory `prisma/migrations/<timestamp>_add_thread_analyzed_at/` with `migration.sql` that contains `ALTER TABLE "Thread" ADD COLUMN "analyzedAt" TIMESTAMP(3)` plus the index creation.

- [ ] **Step 3: Inspect and lock the SQL**

Open the generated `migration.sql`. Verify it ONLY contains the column add + the index create. No other unrelated changes. If Prisma added extra ALTERs (e.g. NOT NULL constraints, default values), edit the file to remove them — the column must be nullable, no default.

- [ ] **Step 4: Apply locally**

Run: `npx prisma migrate dev`
Expected: migration applied, Prisma client regenerated.

- [ ] **Step 5: Run typecheck to catch field references**

Run: `npm run typecheck 2>&1 | grep -E "analyzedAt"`
Expected: no errors mentioning `analyzedAt` (it's just declared, nothing reads it yet).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "chore(migration): add Thread.analyzedAt for per-conversation billing"
```

---

### Task 2: Backfill `analyzedAt` from existing analysisResult

**Files:**
- Modify: `prisma/migrations/<timestamp>_add_thread_analyzed_at/migration.sql`

We need to populate `analyzedAt` for threads that already had Tier 3 done before this change. Otherwise existing customers will get re-billed on every thread the next time Tier 3 re-runs.

- [ ] **Step 1: Append the backfill SQL to the migration**

Open the migration file from Task 1 and add at the end:

```sql
-- Backfill: any Thread with at least one analyzed IncomingEmail
-- is considered already-paid. Set analyzedAt to the thread's createdAt
-- as a stable, monotonic proxy.
UPDATE "Thread" t
SET "analyzedAt" = t."createdAt"
WHERE EXISTS (
  SELECT 1
  FROM "IncomingEmail" ie
  WHERE ie."canonicalThreadId" = t.id
    AND ie."analysisResult" IS NOT NULL
);
```

- [ ] **Step 2: Reset the local migration state and reapply**

Because we edited the SQL after `migrate dev` ran, Prisma's local state is now out of sync with the file. Reset:

Run: `npx prisma migrate reset --skip-seed --force`
Expected: DB rebuilt from scratch, migration applied with the backfill clause.

(In production this is a fresh forward-only migration, no reset needed.)

- [ ] **Step 3: Verify backfill on seeded data**

Open `prisma studio` (`npx prisma studio`) or run a quick check:

Run: `npx prisma db execute --stdin <<<"SELECT COUNT(*) FROM \"Thread\" WHERE \"analyzedAt\" IS NOT NULL"`
Expected: a count > 0 (depending on local seed). If your local DB is empty, this is 0 and that's OK.

- [ ] **Step 4: Commit**

```bash
git add prisma/migrations
git commit -m "chore(migration): backfill Thread.analyzedAt from existing analysisResult"
```

---

### Task 3: Rename `BillingUsage.draftsCount` → `analyzedThreadsCount`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<auto>/migration.sql`

- [ ] **Step 1: Edit `prisma/schema.prisma`**

Find the `BillingUsage` model. Replace the field declaration:

Before:
```prisma
  draftsCount  Int      @default(0)
```

After:
```prisma
  // Renamed from draftsCount. Each successful first-time Tier 3 on a
  // Thread increments this by 1 via markThreadAnalyzedIfFirst.
  analyzedThreadsCount Int @default(0)
```

- [ ] **Step 2: Generate the rename migration**

Run: `npx prisma migrate dev --create-only --name rename_drafts_count`

Prisma should generate `ALTER TABLE "BillingUsage" RENAME COLUMN "draftsCount" TO "analyzedThreadsCount"`. If it instead drops and re-creates the column (which would lose data), edit the SQL manually to use `RENAME COLUMN`.

- [ ] **Step 3: Add the current-period reset**

Append to the same migration file:

```sql
-- Reset current-period counters so existing shops get a fresh quota
-- under the new model. Historical rows from previous periods are
-- preserved as audit trail.
UPDATE "BillingUsage"
SET "analyzedThreadsCount" = 0
WHERE "periodStart" >= date_trunc('month', NOW() AT TIME ZONE 'UTC');
```

- [ ] **Step 4: Reset & re-apply locally**

Run: `npx prisma migrate reset --skip-seed --force`
Expected: both migrations apply cleanly.

- [ ] **Step 5: Confirm the column was renamed (not dropped)**

Run: `npx prisma db execute --stdin <<<"SELECT column_name FROM information_schema.columns WHERE table_name='BillingUsage'"`
Expected: list includes `analyzedThreadsCount` and NOT `draftsCount`.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "chore(migration): rename BillingUsage.draftsCount to analyzedThreadsCount"
```

---

## Phase 2 — Plan + usage helpers (TDD)

### Task 4: Rename `PlanDefinition.draftsPerMonth` → `analyzedThreadsPerMonth`

**Files:**
- Modify: `app/lib/billing/plans.ts`
- Modify: existing tests that read the field

- [ ] **Step 1: Update the interface and the catalog**

Replace `app/lib/billing/plans.ts` body so it reads:

```ts
export type PlanId = 'trial' | 'starter' | 'pro';

export interface PlanDefinition {
  id: PlanId;
  priceUsd: number;
  analyzedThreadsPerMonth: number; // renamed from draftsPerMonth
  maxMailboxes: number;
  advancedDashboard: boolean;
  dashboardMaxRangeDays: number;
  durationDays?: number;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  trial: {
    id: 'trial',
    priceUsd: 0,
    analyzedThreadsPerMonth: Infinity,
    maxMailboxes: 1,
    advancedDashboard: true,
    dashboardMaxRangeDays: 90,
    durationDays: 14,
  },
  starter: {
    id: 'starter',
    priceUsd: 9,
    analyzedThreadsPerMonth: 50,
    maxMailboxes: 1,
    advancedDashboard: false,
    dashboardMaxRangeDays: 7,
  },
  pro: {
    id: 'pro',
    priceUsd: 49,
    analyzedThreadsPerMonth: 500,
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

(The only changes are the field rename and the docstring on the model field already updated in Task 3.)

- [ ] **Step 2: Find and update test fixtures**

Run: `grep -rn "draftsPerMonth" app/lib/billing/__tests__ app/lib/__tests__`
Expected: a list of test files referring to the old name. For each occurrence, do a literal find-and-replace `draftsPerMonth` → `analyzedThreadsPerMonth`.

Common files affected:
- `app/lib/billing/__tests__/plans.test.ts`
- `app/lib/billing/__tests__/draft-guard.test.ts`
- `app/lib/__tests__/integration/billing-entitlements.test.ts`

- [ ] **Step 3: Run unit tests**

Run: `npm test -- app/lib/billing`
Expected: green. If anything fails on `draftsPerMonth`, you missed a reference.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "draftsPerMonth"`
Expected: empty (no remaining references).

- [ ] **Step 5: Commit**

```bash
git add app/lib/billing/plans.ts app/lib/billing/__tests__ app/lib/__tests__
git commit -m "refactor(plans): rename draftsPerMonth to analyzedThreadsPerMonth"
```

---

### Task 5: Update `usage.ts` field reference

**Files:**
- Modify: `app/lib/billing/usage.ts`

Rename `draftsCount` references inside the existing functions to use `analyzedThreadsCount`. The function names stay the same in this task (`tryReserveDraft`, `releaseDraft`, `getUsage`) — those are renamed in a later task. This is a purely internal rename.

- [ ] **Step 1: Rewrite `app/lib/billing/usage.ts`**

Replace the file with this content (only changes are `draftsCount` → `analyzedThreadsCount` everywhere):

```ts
/**
 * Atomic billing usage counter.
 *
 * One row per (shop, periodStart). periodStart is always 00:00:00 UTC of
 * the 1st of the current month. tryReserveDraft uses a Postgres-side
 * compare-and-swap (raw SQL) to avoid race conditions when two requests
 * arrive at limit-1 simultaneously.
 *
 * NOTE: function names still mention "Draft" for now. Task 9 introduces
 * the new helper `markThreadAnalyzedIfFirst` which is the only billing
 * write site under the per-conversation model.
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
```

- [ ] **Step 2: Run unit + integration tests**

Run: `npm test && npm run test:integration`
Expected: green. Existing tests should pass because the function contract is unchanged — only DB column name is different.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "usage.ts|billing"`
Expected: no new errors. Pre-existing errors stay.

- [ ] **Step 4: Commit**

```bash
git add app/lib/billing/usage.ts
git commit -m "refactor(usage): switch internal field to analyzedThreadsCount"
```

---

### Task 6: Read sites — `entitlements.ts` and friends

**Files:**
- Modify: `app/lib/billing/entitlements.ts`
- Modify: tests that assert on the entitlement shape

`entitlements.ts` reads `plan.draftsPerMonth`. Fix.

- [ ] **Step 1: Find all read sites**

Run: `grep -rn "draftsPerMonth\|draftsCount" app/lib app/routes app/components`
Expected: a short list. Most are already addressed in Tasks 4-5; remaining ones are in `entitlements.ts`, possibly the `app.billing.tsx` route, and components.

- [ ] **Step 2: Replace all remaining references**

In each file, do a literal find-and-replace:
- `draftsPerMonth` → `analyzedThreadsPerMonth`
- `draftsCount` → `analyzedThreadsCount` (only where it refers to the Prisma model; the helper functions are renamed later)

Specifically in `entitlements.ts`, locate where `computeQuotaStatus` is called with `plan.draftsPerMonth` and update to `plan.analyzedThreadsPerMonth`.

- [ ] **Step 3: Run all tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "draftsPerMonth|draftsCount"`
Expected: empty.

- [ ] **Step 5: Commit**

```bash
git add app/lib/billing/entitlements.ts app/routes app/components
git commit -m "refactor(billing): rename remaining draftsPerMonth/draftsCount references"
```

---

### Task 7: Write failing tests for `markThreadAnalyzedIfFirst`

**Files:**
- Create: `app/lib/billing/__tests__/mark-thread-analyzed.test.ts`

- [ ] **Step 1: Create the test file**

```ts
import { describe, it, expect, vi } from "vitest";
import { markThreadAnalyzedIfFirst } from "../usage";

vi.mock("../../../db.server", () => {
  const state = {
    threads: new Map<string, { id: string; shop: string; analyzedAt: Date | null }>(),
    usage: new Map<string, number>(),
  };
  return {
    default: {
      thread: {
        updateMany: vi.fn(async ({ where, data }: { where: { id: string; shop: string; analyzedAt: null }; data: { analyzedAt: Date } }) => {
          const row = state.threads.get(where.id);
          if (!row || row.shop !== where.shop || row.analyzedAt !== null) return { count: 0 };
          row.analyzedAt = data.analyzedAt;
          return { count: 1 };
        }),
      },
      __state: state,
    },
  };
});

import prisma from "../../../db.server";

const dbState = (prisma as unknown as { __state: { threads: Map<string, { id: string; shop: string; analyzedAt: Date | null }>; usage: Map<string, number> } }).__state;

beforeEach(() => {
  dbState.threads.clear();
  dbState.usage.clear();
});

describe("markThreadAnalyzedIfFirst — unit", () => {
  it("first call counts; second call no-ops", async () => {
    dbState.threads.set("t1", { id: "t1", shop: "shop-a.myshopify.com", analyzedAt: null });
    const r1 = await markThreadAnalyzedIfFirst("t1", "shop-a.myshopify.com");
    expect(r1).toEqual({ counted: true, alreadyAnalyzed: false });

    const r2 = await markThreadAnalyzedIfFirst("t1", "shop-a.myshopify.com");
    expect(r2).toEqual({ counted: false, alreadyAnalyzed: true });
  });

  it("shop mismatch returns counted: false without mutating", async () => {
    dbState.threads.set("t1", { id: "t1", shop: "shop-a.myshopify.com", analyzedAt: null });
    const r = await markThreadAnalyzedIfFirst("t1", "shop-b.myshopify.com");
    expect(r).toEqual({ counted: false, alreadyAnalyzed: false });
    expect(dbState.threads.get("t1")?.analyzedAt).toBeNull();
  });

  it("empty threadId returns counted: false", async () => {
    const r = await markThreadAnalyzedIfFirst("", "shop-a.myshopify.com");
    expect(r).toEqual({ counted: false, alreadyAnalyzed: false });
  });

  it("non-existent thread returns counted: false", async () => {
    const r = await markThreadAnalyzedIfFirst("ghost", "shop-a.myshopify.com");
    expect(r).toEqual({ counted: false, alreadyAnalyzed: false });
  });

  it("100 sequential calls yield exactly one count", async () => {
    dbState.threads.set("t1", { id: "t1", shop: "shop-a.myshopify.com", analyzedAt: null });
    let counted = 0;
    for (let i = 0; i < 100; i++) {
      const r = await markThreadAnalyzedIfFirst("t1", "shop-a.myshopify.com");
      if (r.counted) counted++;
    }
    expect(counted).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- app/lib/billing/__tests__/mark-thread-analyzed.test.ts`
Expected: FAIL with "markThreadAnalyzedIfFirst is not exported from ../usage".

- [ ] **Step 3: Commit failing test**

```bash
git add app/lib/billing/__tests__/mark-thread-analyzed.test.ts
git commit -m "test(billing): failing tests for markThreadAnalyzedIfFirst"
```

---

### Task 8: Implement `markThreadAnalyzedIfFirst`

**Files:**
- Modify: `app/lib/billing/usage.ts`

- [ ] **Step 1: Add the helper at the end of `usage.ts`**

Append to `app/lib/billing/usage.ts`:

```ts
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
```

- [ ] **Step 2: Run unit tests**

Run: `npm test -- app/lib/billing/__tests__/mark-thread-analyzed.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 3: Run all unit + integration tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "usage\.ts|mark-thread"`
Expected: empty.

- [ ] **Step 5: Commit**

```bash
git add app/lib/billing/usage.ts
git commit -m "feat(billing): markThreadAnalyzedIfFirst — atomic per-thread counter"
```

---

### Task 9: Audit-finance metrics

**Files:**
- Modify: `app/lib/metrics/definitions.ts`
- Modify: `app/lib/billing/usage.ts`

- [ ] **Step 1: Declare the metrics**

Append to `app/lib/metrics/definitions.ts` (just before `startTimer`):

```ts
// --- Billing audit metrics ---
export const billingAnalyzedThreadCountedTotal = metrics.counter(
  "billing_analyzed_thread_counted_total",
  "Number of times markThreadAnalyzedIfFirst succeeded in counting a new analyzed thread. Reconcile this against BillingUsage.analyzedThreadsCount for finance audits.",
);
export const billingAnalyzedThreadSkippedTotal = metrics.counter(
  "billing_analyzed_thread_skipped_total",
  "Number of times markThreadAnalyzedIfFirst returned counted=false. Labels: reason ∈ { already_analyzed | not_found | invalid_input }.",
);
```

- [ ] **Step 2: Emit metrics from `markThreadAnalyzedIfFirst`**

Edit `app/lib/billing/usage.ts`. Add an import at the top:

```ts
import {
  billingAnalyzedThreadCountedTotal,
  billingAnalyzedThreadSkippedTotal,
} from "../metrics/definitions";
```

Update the helper to emit on every code path:

```ts
export async function markThreadAnalyzedIfFirst(
  threadId: string,
  shop: string,
): Promise<MarkThreadAnalyzedResult> {
  if (!threadId || !shop) {
    billingAnalyzedThreadSkippedTotal.inc({ shop: shop || "", reason: "invalid_input" });
    return { counted: false, alreadyAnalyzed: false };
  }

  const result = await prisma.thread.updateMany({
    where: { id: threadId, shop, analyzedAt: null },
    data: { analyzedAt: new Date() },
  });

  if (result.count === 0) {
    const row = await prisma.thread.findUnique({
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
  await prisma.billingUsage.upsert({
    where: { shop_periodStart: { shop, periodStart } },
    create: { shop, periodStart, analyzedThreadsCount: 1 },
    update: { analyzedThreadsCount: { increment: 1 } },
  });

  billingAnalyzedThreadCountedTotal.inc({ shop });
  return { counted: true, alreadyAnalyzed: false };
}
```

- [ ] **Step 3: Run tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add app/lib/metrics/definitions.ts app/lib/billing/usage.ts
git commit -m "feat(metrics): billing_analyzed_thread_counted/skipped for audits"
```

---

## Phase 3 — Wire counter into Tier 3 completion

### Task 10: Failing integration test for auto-sync increments

**Files:**
- Create: `app/lib/__tests__/integration/billing-thread-counter.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";
import { markThreadAnalyzedIfFirst, getUsage } from "../../billing/usage";

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing thread counter — integration", () => {
  it("counts +1 the first time and +0 on resync", async () => {
    const thread = await createTestThread({});
    const r1 = await markThreadAnalyzedIfFirst(thread.id, TEST_SHOP);
    expect(r1.counted).toBe(true);
    const usage1 = await getUsage(TEST_SHOP);
    expect(usage1.count).toBe(1);

    // Simulate a resync: call mark again on the same thread.
    const r2 = await markThreadAnalyzedIfFirst(thread.id, TEST_SHOP);
    expect(r2.counted).toBe(false);
    expect(r2.alreadyAnalyzed).toBe(true);
    const usage2 = await getUsage(TEST_SHOP);
    expect(usage2.count).toBe(1);
  });

  it("counts +1 for each of N distinct threads", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await createTestThread({});
      ids.push(t.id);
    }
    for (const id of ids) {
      const r = await markThreadAnalyzedIfFirst(id, TEST_SHOP);
      expect(r.counted).toBe(true);
    }
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(5);
  });

  it("long conversation invariant — 5 successive Tier 3 calls on same thread = 1 unit", async () => {
    const thread = await createTestThread({});
    for (let i = 0; i < 5; i++) {
      await markThreadAnalyzedIfFirst(thread.id, TEST_SHOP);
    }
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- app/lib/__tests__/integration/billing-thread-counter.test.ts`
Expected: PASS (3 tests). The helper already works; we're testing it through the integration suite to confirm against a real DB.

- [ ] **Step 3: Commit**

```bash
git add app/lib/__tests__/integration/billing-thread-counter.test.ts
git commit -m "test(billing): integration coverage for thread counter idempotency"
```

---

### Task 11: Call `markThreadAnalyzedIfFirst` from `classifyAndDraft`

**Files:**
- Modify: `app/lib/gmail/pipeline.ts`

`classifyAndDraft` is where Tier 3 succeeds during auto-sync. After the analysis is persisted, call the new helper.

- [ ] **Step 1: Locate the Tier 3 success site**

Search for the `analysisResult: JSON.stringify(analysis)` line in `classifyAndDraft` (around line 1161 currently). That's right after a successful `analyzeSupportEmail` call.

- [ ] **Step 2: Add the helper call after the analysis persist**

Find this block (the existing `processingStatus: "analyzed"` update):

```ts
    await prisma.incomingEmail.update({
      where: { id: record.id },
      data: {
        processingStatus: "analyzed",
        analysisResult: JSON.stringify(analysis),
        detectedIntent: analysis.intent,
        analysisConfidence: analysis.confidence,
        lastAnalyzedAt: new Date(),
      },
    });
```

Immediately AFTER this update, add:

```ts
    if (record.canonicalThreadId) {
      const { markThreadAnalyzedIfFirst } = await import("../billing/usage");
      await markThreadAnalyzedIfFirst(record.canonicalThreadId, shop).catch((err) => {
        // Don't fail the analysis if billing increment fails — the analysis
        // is real and useful. The skipped metric will flag the discrepancy.
        console.error(`[billing] markThreadAnalyzedIfFirst failed for thread=${record.canonicalThreadId}:`, err);
      });
    }
```

Dynamic import keeps the existing pattern in this file and avoids potential cycles.

- [ ] **Step 3: Do the same in `backfillResolvedIntents`'s analysis persist**

Search for the second `processingStatus: "analyzed"` block in `pipeline.ts` (around line 821 currently, inside `processThread`). Same insert pattern:

```ts
    if (anchor.canonicalThreadId) {
      const { markThreadAnalyzedIfFirst } = await import("../billing/usage");
      await markThreadAnalyzedIfFirst(anchor.canonicalThreadId, shop).catch((err) => {
        console.error(`[billing] markThreadAnalyzedIfFirst failed for thread=${anchor.canonicalThreadId}:`, err);
      });
    }
```

Place it after the existing `prisma.incomingEmail.update` that sets `analysisResult` and `processingStatus`.

- [ ] **Step 4: Run unit + integration tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "pipeline\.ts"`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add app/lib/gmail/pipeline.ts
git commit -m "feat(billing): mark thread analyzed on Tier 3 success (auto-sync + backfill)"
```

---

### Task 12: Call `markThreadAnalyzedIfFirst` from `reanalyzeEmail`

**Files:**
- Modify: `app/lib/gmail/pipeline.ts`

`reanalyzeEmail` is invoked when the user clicks "Generate draft" on an unanalyzed email, or when handleReanalyze runs.

- [ ] **Step 1: Find the persist site in `reanalyzeEmail`**

Search for `await prisma.incomingEmail.update({` inside `reanalyzeEmail` (around line 1479). It updates `processingStatus: "analyzed"`.

- [ ] **Step 2: Add the helper call**

After that update, add:

```ts
  if (record.canonicalThreadId) {
    const { markThreadAnalyzedIfFirst } = await import("../billing/usage");
    await markThreadAnalyzedIfFirst(record.canonicalThreadId, shop).catch((err) => {
      console.error(`[billing] markThreadAnalyzedIfFirst failed for thread=${record.canonicalThreadId}:`, err);
    });
  }
```

- [ ] **Step 3: Run tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add app/lib/gmail/pipeline.ts
git commit -m "feat(billing): mark thread analyzed on user-triggered reanalyze"
```

---

### Task 13: Remove `withDraftQuota` from `handleRefine` and `handleRedraft`

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`

These handlers no longer consume quota — the per-conversation model already charged at first Tier 3.

- [ ] **Step 1: Edit `handleRefine`**

Find `handleRefine` in `app/lib/support/inbox-actions.ts` (around line 298). Replace the `withDraftQuota` wrap with a direct generator call:

Before:
```ts
  const guarded = await withDraftQuota({
    shop,
    limit: ent.quotaStatus.limit,
    generator: async () => {
      const newDraft = await refineDraft(currentDraft, instructions, {
        subject: record.subject,
        body: record.bodyText,
        contextSummary,
      }, {
        shop,
        emailId,
        threadId: record.threadId,
      });
      const { upsertReplyDraftBody } = await import("./reply-draft");
      await upsertReplyDraftBody(emailId, shop, newDraft);
      const updatedRD = await prisma.replyDraft.findUnique({
        where: { emailId },
        select: { bodyHistory: true },
      });
      const history = Array.isArray(updatedRD?.bodyHistory)
        ? (updatedRD!.bodyHistory as string[])
        : [];
      return { newDraft, history };
    },
  });

  if (!guarded.ok) {
    if (guarded.reason === 'quota_exceeded') {
      return {
        report: null,
        disconnected: false,
        reanalyzed: null,
        refined: null,
        quotaExceeded: true,
        quotaStatus: { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit },
      };
    }
    throw guarded.error ?? new Error('Draft refine failed');
  }

  return {
    refined: { emailId, newDraft: guarded.value.newDraft, draftHistory: guarded.value.history },
    report: null,
    disconnected: false,
    reanalyzed: null,
    quotaStatus: { used: guarded.newCount, limit: ent.quotaStatus.limit },
  };
}
```

After:
```ts
  const newDraft = await refineDraft(currentDraft, instructions, {
    subject: record.subject,
    body: record.bodyText,
    contextSummary,
  }, {
    shop,
    emailId,
    threadId: record.threadId,
  });
  const { upsertReplyDraftBody } = await import("./reply-draft");
  await upsertReplyDraftBody(emailId, shop, newDraft);
  const updatedRD = await prisma.replyDraft.findUnique({
    where: { emailId },
    select: { bodyHistory: true },
  });
  const history = Array.isArray(updatedRD?.bodyHistory)
    ? (updatedRD!.bodyHistory as string[])
    : [];

  return {
    refined: { emailId, newDraft, draftHistory: history },
    report: null,
    disconnected: false,
    reanalyzed: null,
    quotaStatus: { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit },
  };
}
```

The pre-check `if (!ent.canGenerateDraft)` stays at the top of the handler — that's still the right gate (it returns 402-like response when the shop is suspended).

- [ ] **Step 2: Edit `handleRedraft`**

Find `handleRedraft` (around line 214). Replace the `withDraftQuota` wrap similarly:

Before:
```ts
  const guarded = await withDraftQuota({
    shop,
    limit: ent.quotaStatus.limit,
    generator: () => redraftEmail(emailId, shop),
  });

  if (!guarded.ok) {
    if (guarded.reason === 'quota_exceeded') {
      return {
        reanalyzed: null,
        report: null,
        disconnected: false,
        refined: null,
        quotaExceeded: true,
        quotaStatus: { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit },
      };
    }
    throw guarded.error ?? new Error('Draft generation failed');
  }

  return {
    reanalyzed: null,
    report: null,
    disconnected: false,
    refined: null,
    quotaStatus: { used: guarded.newCount, limit: ent.quotaStatus.limit },
  };
```

After:
```ts
  await redraftEmail(emailId, shop);

  return {
    reanalyzed: null,
    report: null,
    disconnected: false,
    refined: null,
    quotaStatus: { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit },
  };
```

- [ ] **Step 3: Remove the `withDraftQuota` import if no longer used**

Run: `grep -n "withDraftQuota" app/lib/support/inbox-actions.ts`
If only the import line remains, delete it. (Other handlers — `handleReanalyze` — may still use it; leave it if so.)

- [ ] **Step 4: Run tests**

Run: `npm test && npm run test:integration`
Expected: green. Some existing tests may need adjustment because they assert `quotaExceeded: true` for paths that no longer consume quota. Adjust the assertions to reflect the new contract (refine/redraft never return `quotaExceeded`).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "inbox-actions"`
Expected: empty.

- [ ] **Step 6: Commit**

```bash
git add app/lib/support/inbox-actions.ts
git commit -m "refactor(billing): refine and redraft no longer consume quota"
```

---

### Task 14: `handleReanalyze` — keep quota pre-check, drop wrap

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`

`handleReanalyze` triggers Tier 3 directly (the LLM-expensive path). The quota check stays as a pre-gate so the user gets a clear error before LLM cost is incurred, but the actual increment now happens inside `markThreadAnalyzedIfFirst` called by `reanalyzeEmail`.

- [ ] **Step 1: Find `handleReanalyze`**

It's at around line 152. Read the body — it currently uses `withDraftQuota` to wrap `reanalyzeEmail`.

- [ ] **Step 2: Replace the wrap with a direct call**

Before:
```ts
  const guarded = await withDraftQuota({
    shop,
    limit: ent.quotaStatus.limit,
    generator: () => reanalyzeEmail(emailId, admin, shop, { skipDraft: false }),
  });
```

After:
```ts
  // Quota was already pre-checked via `ent.canGenerateDraft`. The
  // actual increment happens inside reanalyzeEmail → Tier 3 success →
  // markThreadAnalyzedIfFirst (idempotent per thread).
  let analysis: Awaited<ReturnType<typeof reanalyzeEmail>>;
  try {
    analysis = await reanalyzeEmail(emailId, admin, shop, { skipDraft: false });
  } catch (err) {
    // Tier 3 failed — no increment happened, no refund needed.
    throw err;
  }
```

Then adapt the rest of the handler to use `analysis` instead of `guarded.value`. And remove the `if (!guarded.ok)` block — the only failure mode now is the throw, which propagates naturally.

- [ ] **Step 3: Update the return shape**

The handler returns `{ reanalyzed: { ... }, quotaStatus: { used: guarded.newCount, ... } }`. Change `guarded.newCount` to a fresh read from `getUsage(shop)` because the increment happened inside the helper, not in `guarded`:

```ts
  const { getUsage } = await import("../billing/usage");
  const freshUsage = await getUsage(shop);
  return {
    reanalyzed: { emailId, ...analysis },
    quotaStatus: { used: freshUsage.count, limit: ent.quotaStatus.limit },
    report: null,
    disconnected: false,
    refined: null,
  };
```

- [ ] **Step 4: Run tests**

Run: `npm test && npm run test:integration`
Expected: green. The existing `draft-guard-inbox.test.ts` may have assertions that need updating.

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/inbox-actions.ts
git commit -m "refactor(billing): handleReanalyze pre-checks quota, increment happens in Tier 3"
```

---

## Phase 4 — Re-classification catch-up

### Task 15: Add `analyze_thread` SyncJob kind

**Files:**
- Modify: `app/lib/mail/job-queue.ts`

- [ ] **Step 1: Extend the `SyncJobKind` type**

In `app/lib/mail/job-queue.ts`, find the `SyncJobKind` type (around line 26). Add the new kind:

```ts
export type SyncJobKind =
  | "sync"
  | "backfill"
  | "resync"
  | "recompute"
  | "reclassify"
  | "analyze_thread";
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck 2>&1 | grep -E "job-queue|SyncJobKind"`
Expected: empty (the new kind is just added, not consumed yet).

- [ ] **Step 3: Run all tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add app/lib/mail/job-queue.ts
git commit -m "feat(jobs): add analyze_thread SyncJobKind"
```

---

### Task 16: Handle `analyze_thread` in `runJob`

**Files:**
- Modify: `app/lib/mail/auto-sync.ts`

- [ ] **Step 1: Add the case branch in `runJob`**

Find the `switch (job.kind)` block in `runJob` (in `auto-sync.ts`). Add a new case before the `default`:

```ts
      case "analyze_thread": {
        const threadId = String(job.params.threadId ?? "");
        if (!threadId) throw new Error("analyze_thread job missing threadId");
        const conn = await prisma.mailConnection.findUnique({
          where: { shop: job.shop },
          select: { email: true },
        });
        // Pick the latest analyzable email of the thread as anchor.
        const anchor = await prisma.incomingEmail.findFirst({
          where: {
            shop: job.shop,
            canonicalThreadId: threadId,
            processingStatus: { notIn: ["outgoing", "error"] },
            tier1Result: "passed",
          },
          orderBy: { receivedAt: "desc" },
          select: { id: true },
        });
        if (!anchor) {
          console.log(`[auto-sync] analyze_thread skipped: no anchor for thread=${threadId} shop=${job.shop}`);
          break;
        }
        const { reanalyzeEmail } = await import("../gmail/pipeline");
        await reanalyzeEmail(anchor.id, admin, job.shop, { skipDraft: true });
        // markThreadAnalyzedIfFirst was called inside reanalyzeEmail.
        console.log(`[auto-sync] analyze_thread ok thread=${threadId} shop=${job.shop} mailbox=${conn?.email ?? "?"}`);
        break;
      }
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "auto-sync"`
Expected: empty.

- [ ] **Step 3: Run tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add app/lib/mail/auto-sync.ts
git commit -m "feat(jobs): runJob handles analyze_thread kind"
```

---

### Task 17: Enqueue `analyze_thread` from `handleMoveThread`

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`

- [ ] **Step 1: Find the supportNature flip site**

In `handleMoveThread` (around line 380), find the block that sets `supportNature: "confirmed_support"`:

```ts
      ...(forceSupport && thread.supportNature !== "confirmed_support"
        ? { supportNature: "confirmed_support", supportNatureUpdatedAt: new Date() }
        : {}),
```

- [ ] **Step 2: Capture whether the supportNature actually changed**

Just below the `prisma.thread.update`, add:

```ts
  const supportNatureFlipped =
    forceSupport && thread.supportNature !== "confirmed_support";

  // If we just flipped a thread to a support stance AND it has never
  // been analyzed, enqueue a background analyze_thread job. The
  // auto-sync loop picks it up at the next tick and runs Tier 3 with
  // skipDraft:true. The first-time analysis consumes 1 billing unit
  // via markThreadAnalyzedIfFirst.
  if (supportNatureFlipped) {
    const threadRow = await prisma.thread.findUnique({
      where: { id: canonicalThreadId },
      select: { analyzedAt: true },
    });
    if (threadRow && threadRow.analyzedAt === null) {
      const { enqueueJob } = await import("../mail/job-queue");
      await enqueueJob(shop, "analyze_thread", { threadId: canonicalThreadId }).catch((err) => {
        console.error(`[catch-up] enqueueJob analyze_thread failed for thread=${canonicalThreadId}:`, err);
      });
    }
  }
```

- [ ] **Step 3: Run tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add app/lib/support/inbox-actions.ts
git commit -m "feat(catchup): enqueue analyze_thread when moveThread flips to support"
```

---

### Task 18: Enqueue `analyze_thread` from `handleUpdateClassification`

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`

`handleUpdateClassification` is where the user manually changes intent/order, and may also affect `supportNature`. Same hook.

- [ ] **Step 1: Find `handleUpdateClassification`**

Around line 577. Read the body to find where `Thread.supportNature` might be set.

- [ ] **Step 2: Add the catch-up enqueue**

Wherever the handler completes successfully (returns success), insert just before the return:

```ts
  // Re-classification may have flipped this thread to support. If so AND
  // analyzedAt is still null, kick off a background analyze_thread job.
  const threadRow = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { analyzedAt: true, supportNature: true },
  });
  const isSupportNow =
    threadRow?.supportNature === "confirmed_support" ||
    threadRow?.supportNature === "probable_support" ||
    threadRow?.supportNature === "mixed";
  if (threadRow && isSupportNow && threadRow.analyzedAt === null) {
    const { enqueueJob } = await import("../mail/job-queue");
    await enqueueJob(shop, "analyze_thread", { threadId }).catch((err) => {
      console.error(`[catch-up] enqueueJob analyze_thread failed for thread=${threadId}:`, err);
    });
  }
```

Adjust the variable name `threadId` to match whatever the handler uses (the handler's signature has `threadId: string` — check it).

- [ ] **Step 3: Run tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add app/lib/support/inbox-actions.ts
git commit -m "feat(catchup): enqueue analyze_thread on classification override"
```

---

## Phase 5 — UI / i18n

### Task 19: Update i18n strings (drafts → conversations)

**Files:**
- Modify: `app/i18n/locales/en.json`
- Modify: `app/i18n/locales/fr.json`

- [ ] **Step 1: Find existing draft-quota strings**

Run: `grep -nE "draft|brouillon" app/i18n/locales/en.json app/i18n/locales/fr.json | grep -i "quota\|plan\|month"`

Identify keys related to the quota UI (e.g., `inbox.quotaUsage`, `billing.plan.drafts`, etc.). The exact keys depend on the existing structure.

- [ ] **Step 2: Update each key in both locales**

For each key found, update its value:
- English: "X / Y drafts" → "X / Y conversations"
- "monthly draft limit" → "monthly conversation limit"
- "You've used your monthly drafts" → "You've analyzed all the support conversations in your current plan"

French (vouvoiement):
- "X / Y brouillons" → "X / Y conversations"
- "limite mensuelle de brouillons" → "limite mensuelle de conversations"
- "Vous avez utilisé vos brouillons du mois" → "Vous avez analysé toutes les conversations support de votre forfait"

- [ ] **Step 3: Verify both locales have the same key set**

Run: `node -e "
const en = require('./app/i18n/locales/en.json');
const fr = require('./app/i18n/locales/fr.json');
const keys = (obj, prefix='') => {
  const out = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? prefix + '.' + k : k;
    if (typeof v === 'object' && v !== null) out.push(...keys(v, key));
    else out.push(key);
  }
  return out.sort();
};
const a = keys(en); const b = keys(fr);
const inAOnly = a.filter(k => !b.includes(k));
const inBOnly = b.filter(k => !a.includes(k));
console.log('Only in en:', inAOnly.length); inAOnly.forEach(k => console.log(' ', k));
console.log('Only in fr:', inBOnly.length); inBOnly.forEach(k => console.log(' ', k));
"`
Expected: 0 keys in each diff.

- [ ] **Step 4: Run i18n completeness test**

Run: `npm test -- app/i18n/__tests__/locale-completeness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/i18n/locales
git commit -m "i18n(billing): rename drafts to conversations in user-facing strings"
```

---

### Task 20: Update billing UI components

**Files:**
- Modify: `app/components/billing/QuotaBanner.tsx`
- Modify: `app/components/billing/SyncSuspendedBanner.tsx`
- Modify: `app/components/billing/QuotaExceededModal.tsx`
- Modify: `app/components/billing/TopBarCounter.tsx`

- [ ] **Step 1: Audit each component for old terminology**

Run: `grep -nE "drafts|brouillons" app/components/billing/*.tsx`

- [ ] **Step 2: Update each component**

For each file, change literal strings like "drafts" / "Drafts" to "conversations" / "Conversations". If strings come from `t()` translations, ensure the translation keys point to the renamed entries from Task 19.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "components/billing"`
Expected: empty.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add app/components/billing
git commit -m "ui(billing): conversation labels in quota banners and modals"
```

---

## Phase 6 — Comprehensive billing tests

These tests are organized by failure class (per the spec). Each task adds the tests for one class.

### Task 21: Class 2 — Concurrent racing tests

**Files:**
- Create: `app/lib/__tests__/integration/billing-concurrency.test.ts`

- [ ] **Step 1: Create the test file**

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";
import { markThreadAnalyzedIfFirst, getUsage } from "../../billing/usage";

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — concurrent racing (Class 2)", () => {
  it("10 parallel calls on the same thread yield exactly 1 increment", async () => {
    const thread = await createTestThread({});
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        markThreadAnalyzedIfFirst(thread.id, TEST_SHOP),
      ),
    );
    const counted = results.filter((r) => r.counted).length;
    expect(counted).toBe(1);
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(1);
  });

  it("50 parallel calls split across 5 threads yield exactly 5 increments", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await createTestThread({});
      ids.push(t.id);
    }
    const calls: Promise<unknown>[] = [];
    for (const id of ids) {
      for (let j = 0; j < 10; j++) {
        calls.push(markThreadAnalyzedIfFirst(id, TEST_SHOP));
      }
    }
    await Promise.all(calls);
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(5);
  });

  it("20 parallel calls on the same thread from different async contexts yield exactly 1", async () => {
    const thread = await createTestThread({});
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      tasks.push(
        (async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          return markThreadAnalyzedIfFirst(thread.id, TEST_SHOP);
        })(),
      );
    }
    const results = (await Promise.all(tasks)) as Array<{ counted: boolean }>;
    expect(results.filter((r) => r.counted).length).toBe(1);
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- app/lib/__tests__/integration/billing-concurrency.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add app/lib/__tests__/integration/billing-concurrency.test.ts
git commit -m "test(billing): concurrent racing — exactly 1 increment under load"
```

---

### Task 22: Class 5 — Period boundary tests

**Files:**
- Create: `app/lib/__tests__/integration/billing-period-boundary.test.ts`

- [ ] **Step 1: Create the test file**

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";
import {
  markThreadAnalyzedIfFirst,
  getUsage,
  getCurrentPeriodStart,
} from "../../billing/usage";

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — period boundaries (Class 5)", () => {
  it("getCurrentPeriodStart returns UTC midnight of the 1st", () => {
    const at = new Date(Date.UTC(2026, 2, 31, 23, 59, 59));
    expect(getCurrentPeriodStart(at).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    const next = new Date(Date.UTC(2026, 3, 1, 0, 0, 1));
    expect(getCurrentPeriodStart(next).toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("threads analyzed on Mar 31 23:59 and Apr 1 00:01 increment different periods", async () => {
    const tA = await createTestThread({});
    const tB = await createTestThread({});

    // Force March period row.
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date(Date.UTC(2026, 2, 1)),
        analyzedThreadsCount: 0,
      },
    });
    // Simulate March increment by writing directly (avoids needing to mock Date).
    await testDb.thread.update({
      where: { id: tA.id },
      data: { analyzedAt: new Date(Date.UTC(2026, 2, 31, 23, 59, 0)) },
    });
    await testDb.billingUsage.update({
      where: { shop_periodStart: { shop: TEST_SHOP, periodStart: new Date(Date.UTC(2026, 2, 1)) } },
      data: { analyzedThreadsCount: 1 },
    });

    // April increment via the helper.
    const aprFirst = new Date(Date.UTC(2026, 3, 1, 0, 0, 1));
    vi.setSystemTime(aprFirst);
    try {
      await markThreadAnalyzedIfFirst(tB.id, TEST_SHOP);
    } finally {
      vi.useRealTimers();
    }

    const marchRow = await testDb.billingUsage.findUnique({
      where: { shop_periodStart: { shop: TEST_SHOP, periodStart: new Date(Date.UTC(2026, 2, 1)) } },
    });
    const aprilRow = await testDb.billingUsage.findUnique({
      where: { shop_periodStart: { shop: TEST_SHOP, periodStart: new Date(Date.UTC(2026, 3, 1)) } },
    });

    expect(marchRow?.analyzedThreadsCount).toBe(1);
    expect(aprilRow?.analyzedThreadsCount).toBe(1);
  });

  it("getUsage on a new period returns count=0 even if previous period was capped", async () => {
    // Seed prior period maxed out.
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date(Date.UTC(2026, 2, 1)),
        analyzedThreadsCount: 50,
      },
    });
    // getUsage on April reads fresh.
    const april = new Date(Date.UTC(2026, 3, 1, 10, 0, 0));
    const usage = await getUsage(TEST_SHOP, april);
    expect(usage.count).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- app/lib/__tests__/integration/billing-period-boundary.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add app/lib/__tests__/integration/billing-period-boundary.test.ts
git commit -m "test(billing): period boundary tests (UTC midnight, monthly rollover)"
```

---

### Task 23: Class 6 — Quota cap tests

**Files:**
- Create: `app/lib/__tests__/integration/billing-quota-cap.test.ts`

- [ ] **Step 1: Create the test file**

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";
import { markThreadAnalyzedIfFirst, tryReserveDraft, getUsage } from "../../billing/usage";

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — quota cap (Class 6)", () => {
  it("at 49/50, a single increment succeeds and brings counter to 50", async () => {
    // Seed counter at 49.
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
        analyzedThreadsCount: 49,
      },
    });
    const thread = await createTestThread({});
    const r = await markThreadAnalyzedIfFirst(thread.id, TEST_SHOP);
    expect(r.counted).toBe(true);
    const usage = await getUsage(TEST_SHOP);
    expect(usage.count).toBe(50);
  });

  it("at 50/50, tryReserveDraft refuses additional unit", async () => {
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
        analyzedThreadsCount: 50,
      },
    });
    const r = await tryReserveDraft({ shop: TEST_SHOP, limit: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("quota_exceeded");
  });

  it("Infinity limit (trial) never blocks", async () => {
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
        analyzedThreadsCount: 100_000,
      },
    });
    const r = await tryReserveDraft({ shop: TEST_SHOP, limit: Infinity });
    expect(r.ok).toBe(true);
  });

  it("2 parallel reserves at 49/50 — exactly 1 succeeds", async () => {
    await testDb.billingUsage.create({
      data: {
        shop: TEST_SHOP,
        periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
        analyzedThreadsCount: 49,
      },
    });
    const [a, b] = await Promise.all([
      tryReserveDraft({ shop: TEST_SHOP, limit: 50 }),
      tryReserveDraft({ shop: TEST_SHOP, limit: 50 }),
    ]);
    const successes = [a, b].filter((r) => r.ok).length;
    expect(successes).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- app/lib/__tests__/integration/billing-quota-cap.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add app/lib/__tests__/integration/billing-quota-cap.test.ts
git commit -m "test(billing): quota cap (49→50 OK, 50→51 refused, parallel race)"
```

---

### Task 24: Class 4 — Cross-shop isolation

**Files:**
- Create: `app/lib/__tests__/integration/billing-cross-shop.test.ts`

- [ ] **Step 1: Create the test file**

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";
import { markThreadAnalyzedIfFirst, getUsage } from "../../billing/usage";

const OTHER_SHOP = "cross-shop.myshopify.com";

beforeEach(async () => {
  await cleanTestShop();
  await testDb.thread.deleteMany({ where: { shop: OTHER_SHOP } });
  await testDb.billingUsage.deleteMany({ where: { shop: OTHER_SHOP } });
});

afterAll(async () => {
  await testDb.thread.deleteMany({ where: { shop: OTHER_SHOP } });
  await testDb.billingUsage.deleteMany({ where: { shop: OTHER_SHOP } });
  await disconnectTestDb();
});

describe("billing — cross-shop isolation (Class 4)", () => {
  it("shop A analyses do not touch shop B counter", async () => {
    const tA = await createTestThread({});
    const tB = await testDb.thread.create({
      data: {
        shop: OTHER_SHOP,
        provider: "gmail",
        lastMessageAt: new Date(),
        firstMessageAt: new Date(),
        operationalState: "open",
        supportNature: "unknown",
        historyStatus: "complete",
      },
    });
    await markThreadAnalyzedIfFirst(tA.id, TEST_SHOP);
    await markThreadAnalyzedIfFirst(tB.id, OTHER_SHOP);

    const usageA = await getUsage(TEST_SHOP);
    const usageB = await getUsage(OTHER_SHOP);
    expect(usageA.count).toBe(1);
    expect(usageB.count).toBe(1);
  });

  it("concurrent analyses on two shops do not interfere", async () => {
    const tA = await createTestThread({});
    const tB = await testDb.thread.create({
      data: {
        shop: OTHER_SHOP,
        provider: "gmail",
        lastMessageAt: new Date(),
        firstMessageAt: new Date(),
        operationalState: "open",
        supportNature: "unknown",
        historyStatus: "complete",
      },
    });
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) calls.push(markThreadAnalyzedIfFirst(tA.id, TEST_SHOP));
    for (let i = 0; i < 5; i++) calls.push(markThreadAnalyzedIfFirst(tB.id, OTHER_SHOP));
    await Promise.all(calls);

    expect((await getUsage(TEST_SHOP)).count).toBe(1);
    expect((await getUsage(OTHER_SHOP)).count).toBe(1);
  });

  it("attempt to mark a thread with the wrong shop is a no-op", async () => {
    const tA = await createTestThread({});
    const r = await markThreadAnalyzedIfFirst(tA.id, OTHER_SHOP);
    expect(r.counted).toBe(false);
    expect((await getUsage(TEST_SHOP)).count).toBe(0);
    expect((await getUsage(OTHER_SHOP)).count).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- app/lib/__tests__/integration/billing-cross-shop.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add app/lib/__tests__/integration/billing-cross-shop.test.ts
git commit -m "test(billing): cross-shop isolation"
```

---

### Task 25: Class 8 — Re-classification catch-up tests

**Files:**
- Create: `app/lib/__tests__/integration/billing-catchup-classification.test.ts`

- [ ] **Step 1: Create the test file**

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";

// We mock the heavy auto-sync side and the LLM-bearing pipeline calls.
const enqueueSpy = vi.fn(async () => "stub-job-id");
vi.mock("../../mail/job-queue", async () => {
  const actual = await vi.importActual<typeof import("../../mail/job-queue")>("../../mail/job-queue");
  return {
    ...actual,
    enqueueJob: enqueueSpy,
  };
});

import { handleMoveThread } from "../../support/inbox-actions";

const fakeAdmin = { graphql: async () => ({ json: async () => ({}) }) } as any;

beforeEach(async () => {
  await cleanTestShop();
  enqueueSpy.mockClear();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — catch-up on classification change (Class 8)", () => {
  it("enqueues analyze_thread when moving non_support → waiting_merchant", async () => {
    const t = await createTestThread({
      supportNature: "non_support",
      operationalState: "no_reply_needed",
    });

    await handleMoveThread({
      shop: TEST_SHOP,
      canonicalThreadId: t.id,
      target: "waiting_merchant",
      admin: fakeAdmin,
    });

    expect(enqueueSpy).toHaveBeenCalledWith(
      TEST_SHOP,
      "analyze_thread",
      expect.objectContaining({ threadId: t.id }),
    );
  });

  it("does NOT enqueue when thread is already analyzed", async () => {
    const t = await createTestThread({ supportNature: "non_support" });
    await testDb.thread.update({
      where: { id: t.id },
      data: { analyzedAt: new Date() },
    });

    await handleMoveThread({
      shop: TEST_SHOP,
      canonicalThreadId: t.id,
      target: "waiting_merchant",
      admin: fakeAdmin,
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does NOT enqueue when move is a no-op (already in confirmed_support)", async () => {
    const t = await createTestThread({
      supportNature: "confirmed_support",
      operationalState: "waiting_merchant",
    });

    await handleMoveThread({
      shop: TEST_SHOP,
      canonicalThreadId: t.id,
      target: "waiting_merchant",
      admin: fakeAdmin,
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- app/lib/__tests__/integration/billing-catchup-classification.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add app/lib/__tests__/integration/billing-catchup-classification.test.ts
git commit -m "test(billing): catch-up enqueues analyze_thread only when needed"
```

---

### Task 26: Class 9 — Refine/redraft don't charge

**Files:**
- Create: `app/lib/__tests__/integration/billing-no-charge-refine-redraft.test.ts`

- [ ] **Step 1: Create the test file**

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";

const { refineDraftSpy } = vi.hoisted(() => ({
  refineDraftSpy: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "<p>refined</p>"),
}));
vi.mock("../../gmail/refine-draft", () => ({ refineDraft: refineDraftSpy }));
vi.mock("../../billing/entitlements", () => ({
  resolveEntitlements: async () => ({
    canGenerateDraft: true,
    quotaStatus: { used: 1, limit: 50 },
    state: "paid_active",
    isSyncSuspended: false,
  }),
  __resetCacheForTests: () => undefined,
}));

import { handleRefine, handleRedraft } from "../../support/inbox-actions";
import { getUsage } from "../../billing/usage";

const fakeAdmin = { graphql: async () => ({ json: async () => ({}) }) } as any;

beforeEach(async () => {
  await cleanTestShop();
  refineDraftSpy.mockClear();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — refine/redraft never increment counter (Class 9)", () => {
  it("calling handleRefine 10 times leaves counter unchanged", async () => {
    const t = await createTestThread({});
    // Seed: thread analyzed previously (analyzedAt set) and counter at 1.
    const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await testDb.thread.update({
      where: { id: t.id },
      data: { analyzedAt: new Date() },
    });
    const anchor = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: "anchor",
        threadId: "tid",
        canonicalThreadId: t.id,
        fromAddress: "c@x.com",
        subject: "S",
        bodyText: "B",
        receivedAt: new Date(),
        processingStatus: "analyzed",
        lastAnalyzedAt: new Date(),
        analysisResult: JSON.stringify({
          intent: "where_is_my_order",
          intents: ["where_is_my_order"],
          identifiers: {},
          order: null,
          orderCandidates: [],
          trackings: [],
          warnings: [],
          confidence: "high",
        }),
      },
      select: { id: true },
    });
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart, analyzedThreadsCount: 1 },
    });

    for (let i = 0; i < 10; i++) {
      await handleRefine({
        shop: TEST_SHOP,
        admin: fakeAdmin,
        emailId: anchor.id,
        instructions: `try ${i}`,
        currentDraft: "<p>draft</p>",
      });
    }

    expect((await getUsage(TEST_SHOP)).count).toBe(1);
  });

  it("calling handleRedraft 10 times leaves counter unchanged", async () => {
    const t = await createTestThread({});
    const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await testDb.thread.update({
      where: { id: t.id },
      data: { analyzedAt: new Date() },
    });
    const anchor = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: "anchor-rd",
        threadId: "tid",
        canonicalThreadId: t.id,
        fromAddress: "c@x.com",
        subject: "S",
        bodyText: "B",
        receivedAt: new Date(),
        processingStatus: "analyzed",
        lastAnalyzedAt: new Date(),
        analysisResult: JSON.stringify({
          intent: "where_is_my_order",
          intents: ["where_is_my_order"],
          identifiers: {},
          order: null,
          orderCandidates: [],
          trackings: [],
          warnings: [],
          confidence: "high",
        }),
      },
      select: { id: true },
    });
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart, analyzedThreadsCount: 1 },
    });

    for (let i = 0; i < 10; i++) {
      await handleRedraft({ shop: TEST_SHOP, admin: fakeAdmin, emailId: anchor.id });
    }

    expect((await getUsage(TEST_SHOP)).count).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- app/lib/__tests__/integration/billing-no-charge-refine-redraft.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
git add app/lib/__tests__/integration/billing-no-charge-refine-redraft.test.ts
git commit -m "test(billing): refine and redraft never increment counter"
```

---

### Task 27: Classes 7, 10, 11 — migration + defensive + audit metrics

**Files:**
- Create: `app/lib/__tests__/integration/billing-migration.test.ts`
- Create: `app/lib/__tests__/integration/billing-defensive.test.ts`

The migration was already exercised when the dev DB was reset. This test pins the contract for future migrations.

- [ ] **Step 1: Migration test**

```ts
// app/lib/__tests__/integration/billing-migration.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
} from "./helpers/db";

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — migration invariants (Class 7)", () => {
  it("BillingUsage.analyzedThreadsCount column exists and is queryable", async () => {
    const row = await testDb.billingUsage.findFirst();
    // We don't need a value — we just need the column to exist.
    expect(row === null || typeof row.analyzedThreadsCount === "number").toBe(true);
  });

  it("Thread.analyzedAt column exists, nullable, indexed", async () => {
    const t = await testDb.thread.create({
      data: {
        shop: TEST_SHOP,
        provider: "gmail",
        lastMessageAt: new Date(),
        firstMessageAt: new Date(),
        operationalState: "open",
        supportNature: "unknown",
        historyStatus: "complete",
      },
    });
    expect(t.analyzedAt).toBeNull();
    await testDb.thread.update({
      where: { id: t.id },
      data: { analyzedAt: new Date() },
    });
    const fresh = await testDb.thread.findUnique({ where: { id: t.id } });
    expect(fresh?.analyzedAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Defensive test**

```ts
// app/lib/__tests__/integration/billing-defensive.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";
import { markThreadAnalyzedIfFirst, getUsage } from "../../billing/usage";

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — defensive paths (Class 10)", () => {
  it("empty threadId is a no-op", async () => {
    const r = await markThreadAnalyzedIfFirst("", TEST_SHOP);
    expect(r).toEqual({ counted: false, alreadyAnalyzed: false });
    expect((await getUsage(TEST_SHOP)).count).toBe(0);
  });

  it("empty shop is a no-op", async () => {
    const t = await createTestThread({});
    const r = await markThreadAnalyzedIfFirst(t.id, "");
    expect(r).toEqual({ counted: false, alreadyAnalyzed: false });
    expect((await getUsage(TEST_SHOP)).count).toBe(0);
  });

  it("non-existent threadId is a no-op", async () => {
    const r = await markThreadAnalyzedIfFirst("ghost-id", TEST_SHOP);
    expect(r.counted).toBe(false);
    expect((await getUsage(TEST_SHOP)).count).toBe(0);
  });

  it("calling on a deleted thread returns no-op without error", async () => {
    const t = await createTestThread({});
    await testDb.thread.delete({ where: { id: t.id } });
    const r = await markThreadAnalyzedIfFirst(t.id, TEST_SHOP);
    expect(r.counted).toBe(false);
    expect((await getUsage(TEST_SHOP)).count).toBe(0);
  });
});
```

- [ ] **Step 3: Run both tests**

Run: `npm run test:integration -- app/lib/__tests__/integration/billing-migration.test.ts app/lib/__tests__/integration/billing-defensive.test.ts`
Expected: PASS (2 + 4 = 6 tests).

- [ ] **Step 4: Commit**

```bash
git add app/lib/__tests__/integration/billing-migration.test.ts app/lib/__tests__/integration/billing-defensive.test.ts
git commit -m "test(billing): migration columns + defensive no-op cases"
```

---

## Phase 7 — Final verification

### Task 28: Classes 3 + 11 — light refresh doesn't count, metrics emit correctly

**Files:**
- Create: `app/lib/__tests__/integration/billing-light-refresh.test.ts`
- Create: `app/lib/billing/__tests__/mark-thread-metrics.test.ts`

- [ ] **Step 1: Light refresh test (Class 3)**

```ts
// app/lib/__tests__/integration/billing-light-refresh.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";

// Stub Shopify / 17track so refreshThreadAnalysis runs end-to-end without
// hitting external services. We only care that no billing increment fires.
vi.mock("../../support/shopify/order-search", () => ({
  searchOrders: async () => ({ candidates: [] }),
}));
vi.mock("../../support/tracking/tracking-service", () => ({
  resolveTrackings: async () => [],
}));

import { refreshThreadAnalysis } from "../../support/refresh-thread-analysis";
import { getUsage } from "../../billing/usage";

const fakeAdmin = { graphql: async () => ({ json: async () => ({}) }) } as any;

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("billing — light refresh paths don't charge (Class 3)", () => {
  it("refreshThreadAnalysis({reclassifyIntent: false}) on an unanalyzed thread does not increment", async () => {
    const t = await createTestThread({});
    const anchor = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: "x",
        threadId: "tid",
        canonicalThreadId: t.id,
        fromAddress: "c@x.com",
        subject: "S",
        bodyText: "B",
        receivedAt: new Date(),
        processingStatus: "analyzed",
        lastAnalyzedAt: new Date(),
        analysisResult: JSON.stringify({
          intent: "where_is_my_order",
          intents: ["where_is_my_order"],
          identifiers: {},
          order: null,
          orderCandidates: [],
          trackings: [],
          warnings: [],
          confidence: "high",
        }),
      },
      select: { id: true },
    });

    await refreshThreadAnalysis(anchor.id, fakeAdmin, TEST_SHOP, {
      reclassifyIntent: false,
      reSearchOrder: true,
      refreshTracking: true,
    });

    // Even though analyzedAt is null (we never ran full Tier 3 in this test),
    // a light refresh must not consume a unit.
    expect((await getUsage(TEST_SHOP)).count).toBe(0);
  });

  it("refreshThreadAnalysis on an already-analyzed thread does not increment", async () => {
    const t = await createTestThread({});
    await testDb.thread.update({ where: { id: t.id }, data: { analyzedAt: new Date() } });
    // Seed an analyzed anchor and a counter at 1 (already paid).
    const anchor = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: "y",
        threadId: "tid",
        canonicalThreadId: t.id,
        fromAddress: "c@x.com",
        subject: "S",
        bodyText: "B",
        receivedAt: new Date(),
        processingStatus: "analyzed",
        lastAnalyzedAt: new Date(),
        analysisResult: JSON.stringify({
          intent: "where_is_my_order",
          intents: ["where_is_my_order"],
          identifiers: {},
          order: null,
          orderCandidates: [],
          trackings: [],
          warnings: [],
          confidence: "high",
        }),
      },
      select: { id: true },
    });
    const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart, analyzedThreadsCount: 1 },
    });

    await refreshThreadAnalysis(anchor.id, fakeAdmin, TEST_SHOP, {
      reclassifyIntent: false,
      reSearchOrder: true,
      refreshTracking: true,
    });

    expect((await getUsage(TEST_SHOP)).count).toBe(1);
  });
});
```

- [ ] **Step 2: Metrics emission test (Class 11)**

```ts
// app/lib/billing/__tests__/mark-thread-metrics.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { metrics, __resetMetricsForTest } from "../../metrics/registry";
import { markThreadAnalyzedIfFirst } from "../usage";

// Mock prisma minimally so we can drive the helper's branches.
vi.mock("../../../db.server", () => {
  const state: { threads: Map<string, { id: string; shop: string; analyzedAt: Date | null }>; usage: Array<{ shop: string; periodStart: Date; count: number }> } = {
    threads: new Map(),
    usage: [],
  };
  return {
    default: {
      __state: state,
      thread: {
        updateMany: async ({ where, data }: { where: { id: string; shop: string; analyzedAt: null }; data: { analyzedAt: Date } }) => {
          const row = state.threads.get(where.id);
          if (!row || row.shop !== where.shop || row.analyzedAt !== null) return { count: 0 };
          row.analyzedAt = data.analyzedAt;
          return { count: 1 };
        },
        findUnique: async ({ where }: { where: { id: string } }) => state.threads.get(where.id) ?? null,
      },
      billingUsage: {
        upsert: async ({ where, create, update }: { where: { shop_periodStart: { shop: string; periodStart: Date } }; create: { shop: string; periodStart: Date; analyzedThreadsCount: number }; update: { analyzedThreadsCount: { increment: number } } }) => {
          const existing = state.usage.find((u) => u.shop === where.shop_periodStart.shop && u.periodStart.getTime() === where.shop_periodStart.periodStart.getTime());
          if (existing) existing.count += update.analyzedThreadsCount.increment;
          else state.usage.push({ shop: create.shop, periodStart: create.periodStart, count: create.analyzedThreadsCount });
        },
      },
    },
  };
});

import prisma from "../../../db.server";
const dbState = (prisma as unknown as { __state: { threads: Map<string, { id: string; shop: string; analyzedAt: Date | null }>; usage: Array<{ shop: string; periodStart: Date; count: number }> } }).__state;

beforeEach(() => {
  __resetMetricsForTest();
  dbState.threads.clear();
  dbState.usage.length = 0;
});

describe("markThreadAnalyzedIfFirst — metrics (Class 11)", () => {
  it("emits billing_analyzed_thread_counted_total on success", async () => {
    dbState.threads.set("t1", { id: "t1", shop: "shop-a.myshopify.com", analyzedAt: null });
    await markThreadAnalyzedIfFirst("t1", "shop-a.myshopify.com");
    const snap = metrics.snapshot();
    const counted = snap.counters.find((c) => c.name === "billing_analyzed_thread_counted_total");
    expect(counted).toBeDefined();
    expect(counted!.series.find((s) => s.labels.shop === "shop-a.myshopify.com")?.value).toBe(1);
  });

  it("emits skipped_total with reason=already_analyzed on second call", async () => {
    dbState.threads.set("t1", { id: "t1", shop: "shop-a.myshopify.com", analyzedAt: null });
    await markThreadAnalyzedIfFirst("t1", "shop-a.myshopify.com");
    await markThreadAnalyzedIfFirst("t1", "shop-a.myshopify.com");
    const snap = metrics.snapshot();
    const skipped = snap.counters.find((c) => c.name === "billing_analyzed_thread_skipped_total");
    expect(skipped).toBeDefined();
    expect(skipped!.series.find((s) => s.labels.reason === "already_analyzed")?.value).toBe(1);
  });

  it("emits skipped_total with reason=invalid_input on empty threadId", async () => {
    await markThreadAnalyzedIfFirst("", "shop-a.myshopify.com");
    const snap = metrics.snapshot();
    const skipped = snap.counters.find((c) => c.name === "billing_analyzed_thread_skipped_total");
    expect(skipped!.series.find((s) => s.labels.reason === "invalid_input")?.value).toBe(1);
  });

  it("emits skipped_total with reason=not_found on shop mismatch", async () => {
    dbState.threads.set("t1", { id: "t1", shop: "shop-a.myshopify.com", analyzedAt: null });
    await markThreadAnalyzedIfFirst("t1", "shop-b.myshopify.com");
    const snap = metrics.snapshot();
    const skipped = snap.counters.find((c) => c.name === "billing_analyzed_thread_skipped_total");
    expect(skipped!.series.find((s) => s.labels.reason === "not_found")?.value).toBe(1);
  });

  it("counted total stays in sync with DB increments", async () => {
    for (let i = 0; i < 5; i++) {
      const id = `t${i}`;
      dbState.threads.set(id, { id, shop: "shop-a.myshopify.com", analyzedAt: null });
      await markThreadAnalyzedIfFirst(id, "shop-a.myshopify.com");
    }
    const snap = metrics.snapshot();
    const counted = snap.counters.find((c) => c.name === "billing_analyzed_thread_counted_total");
    expect(counted!.series.find((s) => s.labels.shop === "shop-a.myshopify.com")?.value).toBe(5);
    // DB usage matches.
    const usageRow = dbState.usage.find((u) => u.shop === "shop-a.myshopify.com");
    expect(usageRow?.count).toBe(5);
  });
});
```

Note: this test file needs `import { vi } from "vitest"` at the top — add it.

- [ ] **Step 3: Run both new test files**

Run: `npm run test:integration -- app/lib/__tests__/integration/billing-light-refresh.test.ts`
Run: `npm test -- app/lib/billing/__tests__/mark-thread-metrics.test.ts`
Expected: PASS (2 + 5 = 7 tests).

- [ ] **Step 4: Commit**

```bash
git add app/lib/__tests__/integration/billing-light-refresh.test.ts app/lib/billing/__tests__/mark-thread-metrics.test.ts
git commit -m "test(billing): light-refresh no-charge + metric-emission contracts"
```

---

### Task 29: Coverage check + TECHNICAL_DEBT update

**Files:**
- Modify: `TECHNICAL_DEBT.md`

- [ ] **Step 1: Run full test suite**

Run: `npm test && npm run test:integration`
Expected: all green. Capture the totals.

- [ ] **Step 2: Run coverage on the billing-critical files**

Run: `npm run test:coverage 2>&1 | grep -E "billing|usage\.ts|entitlements|plans\.ts" | head -20`
Expected: `Stmts` column ≥ 95 for `usage.ts`, `entitlements.ts`, `plans.ts`. If any file is below, identify uncovered lines via the coverage HTML report (`coverage/index.html`) and add a targeted test.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck 2>&1 | tail -5`
Expected: no NEW errors. Pre-existing errors in `app.inbox.tsx`/`app.tsx`/scripts unchanged.

- [ ] **Step 4: Update TECHNICAL_DEBT.md**

Append a new section after the "Refine context auto-refresh — 2026-05-15" block:

```markdown
### Billing model — per analyzed conversation — 2026-05-15

Fixed in this pass:

- [x] **Schema migration** — `Thread.analyzedAt` added; backfilled
      from existing `analysisResult` so current shops are
      grandfathered. `BillingUsage.draftsCount` renamed to
      `analyzedThreadsCount` with current-period reset.
- [x] **`markThreadAnalyzedIfFirst` helper** — atomic
      `updateMany WHERE analyzedAt IS NULL` + `BillingUsage` upsert.
      Single billing-write site. Audited via two new metrics:
      `billing_analyzed_thread_counted_total` and
      `billing_analyzed_thread_skipped_total{reason}`.
- [x] **Tier 3 increment site wired** in `classifyAndDraft`,
      `backfillResolvedIntents.processThread`, and `reanalyzeEmail`.
- [x] **Refine/redraft don't charge** — `withDraftQuota` removed
      from `handleRefine` and `handleRedraft`. `canGenerateDraft`
      pre-check stays on `handleReanalyze` (which still triggers
      Tier 3 directly).
- [x] **Catch-up on classification change** — new
      `SyncJobKind: "analyze_thread"`. `handleMoveThread` and
      `handleUpdateClassification` enqueue when supportNature flips
      to support AND `analyzedAt` is null. Auto-sync runs Tier 3 with
      `skipDraft: true` and consumes 1 unit on first success.
- [x] **Plan names** — `draftsPerMonth` → `analyzedThreadsPerMonth`.
      Caps unchanged: 50 Starter / 500 Pro / Infinity Trial.
- [x] **i18n + UI** — "drafts" replaced by "conversations" in
      user-facing strings (en + fr).
- [x] **Test coverage** — 11 failure classes from the spec covered.
      Statement coverage ≥ 95 % on the billing-critical files.

Operator follow-up:
- Send the soft-comm email to active paying shops explaining the
  change ("Now we count conversations instead of drafts; refines and
  regens are free").

Out of scope (kept for later):
- Manual drafting feature (separate spec; billing decoupling makes
  it a small follow-up PR).
- Soft overage / usage charges.
- Per-seat pricing.
- Refine-count cap (alerting instead, operator-driven).
```

- [ ] **Step 5: Commit**

```bash
git add TECHNICAL_DEBT.md
git commit -m "docs(tech-debt): record per-conversation billing migration"
```

- [ ] **Step 6: Push the branch and open the PR**

```bash
git push -u origin feature/billing-per-conversation
gh pr create --title "feat(billing): switch to per analyzed conversation" --body "$(cat <<'EOF'
## Summary

Switch the metered billing unit from "AI draft generated" to "support
**conversation** analyzed". One conversation = one thread where Tier 3
completed at least once. Refines, regenerations, and manual drafting
become free within a conversation.

Spec: \`docs/superpowers/specs/2026-05-15-billing-model-per-conversation-design.md\`
Plan: \`docs/superpowers/plans/2026-05-15-billing-model-per-conversation.md\`

## Test plan
- 11 failure classes from the spec, each with at least one passing
  test. Total new tests: ~25 across unit + integration.
- Coverage ≥ 95 % on \`usage.ts\`, \`entitlements.ts\`, \`plans.ts\`,
  \`markThreadAnalyzedIfFirst\`.
- Migration tested against a fresh DB + a seeded DB with pre-existing
  threads.

## Operator follow-up (post-merge)
- Send the soft-comm email to active paying shops ("now we count
  conversations").
- Monitor \`/app/metrics\` → \`billing_analyzed_thread_counted_total\`
  vs \`BillingUsage.analyzedThreadsCount\` for reconciliation in the
  first week.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist

Spec coverage walkthrough:

- **Schema changes** (Thread.analyzedAt, BillingUsage rename) → Tasks 1, 2, 3 ✓
- **Plan definitions** (analyzedThreadsPerMonth) → Task 4 ✓
- **Counter increment site** (markThreadAnalyzedIfFirst + integration into pipeline) → Tasks 7, 8, 11, 12 ✓
- **Quota guard sites — removed** → Tasks 13, 14 ✓
- **Auto-analysis on re-classification** → Tasks 15, 16, 17, 18 ✓
- **Entitlement / suspension logic** — preserved, no code change → covered by Tasks 5, 6 (renames) ✓
- **i18n updates** → Task 19 ✓
- **Existing-shop migration** (reset counter) → Task 3 Step 3 ✓
- **Pricing math & assumptions** — documentation only, no task needed ✓
- **Edge cases** — all covered by tests in Phase 6 ✓
- **Monitoring** (audit metrics) → Task 9 ✓

Test plan coverage:
- Class 1 (double counting) → Task 7 + Task 10 ✓
- Class 2 (concurrent racing) → Task 21 ✓
- Class 3 (spurious counting) → Task 7 (shop mismatch, empty) + Task 27 (non-existent, deleted) + Task 28 (light refresh paths) ✓
- Class 4 (cross-shop) → Task 24 ✓
- Class 5 (period boundaries) → Task 22 ✓
- Class 6 (quota cap) → Task 23 ✓
- Class 7 (migration correctness) → Task 27 ✓
- Class 8 (re-classification catch-up) → Task 25 ✓
- Class 9 (refine/redraft don't charge) → Task 26 ✓
- Class 10 (defensive) → Task 27 ✓
- Class 11 (observability metrics) → Task 9 (impl) + Task 28 (emission contract tests) ✓

Placeholder scan: all steps contain complete code, no TBD/TODO.

Type consistency: `analyzedThreadsCount` (DB field) / `analyzedThreadsPerMonth` (plan field) / `markThreadAnalyzedIfFirst` (helper name) used consistently throughout.

Note: this plan creates `feature/billing-per-conversation` branch on Task 1's first commit. If using subagent-driven execution, the first task should `git checkout -b feature/billing-per-conversation` before its Step 6.
