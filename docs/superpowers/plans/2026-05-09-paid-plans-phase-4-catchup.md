# Paid Plans Phase 4 — Sync suspend/resume + 48h catch-up

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** When a shop's quota is exhausted (paid_active 100%) or trial is expired, suspend `auto-sync` to stop pulling new emails. When the shop recovers (upgrade or month reset), resume sync with a 48-hour zone rule: messages received within the last 48h trigger full analysis (intent + identifiers + tracking, but no draft) so the inbox is immediately useful; older messages are imported untreated and surface in a "Pending" view for explicit user analysis.

**Architecture:**
- `entitlements.ts` exposes a derived `isSyncSuspended` boolean.
- `auto-sync.ts` reads `isSyncSuspended` per shop and skips `enqueueJob`.
- `pipeline.ts` consults a `48h zone` helper at processing time and downgrades the work for older messages.
- `app.inbox.tsx` shows a `Sync suspendue` banner + a filter for "À analyser" (existing bucket already covers this conceptually; we add explicit signage).

**Reference spec:** [docs/superpowers/specs/2026-05-08-paid-plans-design.md](docs/superpowers/specs/2026-05-08-paid-plans-design.md)

**Note on existing app behavior already aligned with the spec:**
- Auto-sync already skips draft generation (`skipDraft: true` in `pipeline.ts`); drafts come from explicit user clicks. So no auto-burn risk — quota is consumed only on click.
- The inbox already separates threads with/without draft, so the spec's "Pending / À analyser" idea is largely the existing "À traiter" bucket. We refine the wording and add gating.

What this phase truly adds: **suspend/resume**, **48h zone**, and **clear UI signaling**.

---

## File Structure

| File | Modification |
|---|---|
| `app/lib/billing/entitlements.ts` | Add `isSyncSuspended` derived flag to `Entitlements` |
| `app/lib/billing/__tests__/entitlements.test.ts` (existing integration) | Extend tests for `isSyncSuspended` truth table |
| `app/lib/mail/auto-sync.ts` | Skip `enqueueJob` when shop's `isSyncSuspended` is true |
| `app/lib/__tests__/integration/auto-sync-suspended.test.ts` | Create — verify suspended shops are not enqueued |
| `app/lib/billing/catchup.ts` | Create — pure helper `isWithin48hZone(receivedAt, now)` and a downgrade helper for pipeline |
| `app/lib/billing/__tests__/catchup.test.ts` | Create — unit tests for the helper |
| `app/lib/gmail/pipeline.ts` | When processing an incoming email older than 48h, skip Tier 2 + Tier 3 (analyze=false flag) — only Tier 1 prefilter runs |
| `app/routes/app.inbox.tsx` | Loader: read `isSyncSuspended` from root context, render a `<SyncSuspendedBanner>` above the inbox list |
| `app/components/billing/SyncSuspendedBanner.tsx` | Create — orange banner "Sync suspendue — upgrade ou attendez le reset" |
| `app/i18n/locales/en.json` + `fr.json` | Add `billing.syncSuspended.*` keys |

---

## Task 1: Extend `Entitlements` with `isSyncSuspended`

**Files:**
- Modify: `app/lib/billing/entitlements.ts`
- Modify: `app/lib/__tests__/integration/billing-entitlements.test.ts`

A shop is "sync suspended" when:
- `state === 'trial_expired'`, OR
- `state === 'paid_active'` AND `quotaStatus.level === 'exceeded'`

Otherwise (`trial_active`, `paid_active` with quota OK, or `internal`), sync runs normally.

- [ ] **Step 1: Add `isSyncSuspended` to the Entitlements interface**

In `app/lib/billing/entitlements.ts`, find the `Entitlements` interface and add the field:

```typescript
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
  dashboardMaxRangeDays: number;
}
```

- [ ] **Step 2: Set `isSyncSuspended` in each builder**

In the same file, update each `build*Entitlements` function:

- `buildInternalEntitlements`: `isSyncSuspended: false`
- `buildPaidEntitlements`: `isSyncSuspended: quotaStatus.level === 'exceeded'`
- `buildTrialActiveEntitlements`: `isSyncSuspended: false`
- `buildTrialExpiredEntitlements`: `isSyncSuspended: true`

Apply the field next to the existing return-record fields. Order doesn't matter — match alphabetical or existing convention.

- [ ] **Step 3: Add tests in `billing-entitlements.test.ts`**

Append after the existing `describe` blocks:

```typescript
describe('resolveEntitlements — isSyncSuspended', () => {
  it('false during trial_active', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 2 * DAY_MS));
    const ent = await resolveEntitlements({ shop: TEST_SHOP, admin: makeAdmin([]) as any, now });
    expect(ent.isSyncSuspended).toBe(false);
  });

  it('true when trial_expired', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    const ent = await resolveEntitlements({ shop: TEST_SHOP, admin: makeAdmin([]) as any, now });
    expect(ent.isSyncSuspended).toBe(true);
  });

  it('false on paid_active with quota OK', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart: new Date('2026-05-01T00:00:00Z'), draftsCount: 10 },
    });
    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([
        { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
      ]) as any,
      now,
    });
    expect(ent.isSyncSuspended).toBe(false);
  });

  it('true on paid_active with quota exceeded', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await setInstallDate(TEST_SHOP, new Date(now.getTime() - 30 * DAY_MS));
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart: new Date('2026-05-01T00:00:00Z'), draftsCount: 50 },
    });
    const ent = await resolveEntitlements({
      shop: TEST_SHOP,
      admin: makeAdmin([
        { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
      ]) as any,
      now,
    });
    expect(ent.isSyncSuspended).toBe(true);
  });

  it('false for internal (bypass)', async () => {
    const now = new Date('2026-05-08T12:00:00Z');
    await testDb.billingShopFlag.create({
      data: { shop: TEST_SHOP, isInternal: true, installDate: new Date(now.getTime() - 30 * DAY_MS) },
    });
    const ent = await resolveEntitlements({ shop: TEST_SHOP, admin: makeAdmin([]) as any, now });
    expect(ent.isSyncSuspended).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests**

```bash
npm run test:integration -- billing-entitlements
```

Expected: PASS — previous tests still green + 5 new tests passing.

- [ ] **Step 5: Commit**

```bash
git add app/lib/billing/entitlements.ts app/lib/__tests__/integration/billing-entitlements.test.ts
git commit -m "feat(billing): add isSyncSuspended derived flag to entitlements"
```

---

## Task 2: 48h zone helper (`catchup.ts`)

**Files:**
- Create: `app/lib/billing/catchup.ts`
- Test: `app/lib/billing/__tests__/catchup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/billing/__tests__/catchup.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isWithin48hZone, ACTIVE_ZONE_HOURS } from '../catchup';

const HOUR_MS = 60 * 60 * 1000;

describe('isWithin48hZone', () => {
  const now = new Date('2026-05-09T12:00:00Z');

  it('true for a message from 1h ago', () => {
    const receivedAt = new Date(now.getTime() - 1 * HOUR_MS);
    expect(isWithin48hZone(receivedAt, now)).toBe(true);
  });

  it('true for a message from 47h ago', () => {
    const receivedAt = new Date(now.getTime() - 47 * HOUR_MS);
    expect(isWithin48hZone(receivedAt, now)).toBe(true);
  });

  it('false at exactly 48h', () => {
    const receivedAt = new Date(now.getTime() - 48 * HOUR_MS);
    expect(isWithin48hZone(receivedAt, now)).toBe(false);
  });

  it('false for a message from 72h ago', () => {
    const receivedAt = new Date(now.getTime() - 72 * HOUR_MS);
    expect(isWithin48hZone(receivedAt, now)).toBe(false);
  });

  it('treats future timestamps as within zone (clock skew safety)', () => {
    const receivedAt = new Date(now.getTime() + 10 * 60 * 1000);
    expect(isWithin48hZone(receivedAt, now)).toBe(true);
  });

  it('exposes ACTIVE_ZONE_HOURS as a constant', () => {
    expect(ACTIVE_ZONE_HOURS).toBe(48);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
npx vitest run app/lib/billing/__tests__/catchup.test.ts
```

Expected: FAIL — `Cannot find module '../catchup'`.

- [ ] **Step 3: Implement `catchup.ts`**

Create `app/lib/billing/catchup.ts`:

```typescript
/**
 * Catch-up helpers — used when auto-sync resumes after a suspend
 * (post-upgrade or post-period-reset).
 *
 * Zone active : messages received in the last 48 hours go through the
 * full analysis pipeline (intent + identifiers + tracking) at import
 * time — no draft generated. This makes the inbox immediately useful
 * without consuming quota.
 *
 * Zone hors-fenêtre : older messages are imported but Tier 2 + Tier 3
 * are skipped. They surface in the "À analyser" / "À traiter" bucket
 * with a "non-analysé" state. Merchant clicks "Generate draft" to
 * trigger the full pipeline + draft = 1 quota unit.
 */

export const ACTIVE_ZONE_HOURS = 48;

const ACTIVE_ZONE_MS = ACTIVE_ZONE_HOURS * 60 * 60 * 1000;

/**
 * True when `receivedAt` falls within the active 48h window relative
 * to `now`. Future timestamps (clock skew) are treated as within zone
 * so they don't get accidentally downgraded.
 */
export function isWithin48hZone(receivedAt: Date, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - receivedAt.getTime();
  return ageMs < ACTIVE_ZONE_MS;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run app/lib/billing/__tests__/catchup.test.ts
```

Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add app/lib/billing/catchup.ts app/lib/billing/__tests__/catchup.test.ts
git commit -m "feat(billing): 48h zone helper for catch-up"
```

---

## Task 3: Suspend `auto-sync` when shop is suspended

**Files:**
- Modify: `app/lib/mail/auto-sync.ts`
- Create: `app/lib/__tests__/integration/auto-sync-suspended.test.ts`

The existing `enqueueDuePeriodicSyncs` already filters by `autoSyncEnabled` and active session. We add a billing entitlement check.

- [ ] **Step 1: Read the file**

Read `app/lib/mail/auto-sync.ts` to confirm the structure of `enqueueDuePeriodicSyncs`. The check should happen inside the for-loop over connections, before the `enqueueJob` call.

- [ ] **Step 2: Add the entitlement check**

The check needs an `admin` GraphQL client per shop, but auto-sync runs in a background tick without a request context. Use `unauthenticated.admin(shop)` (already used in `mail-auth.tsx` for similar reasons).

Modify the loop in `enqueueDuePeriodicSyncs` (around line 142):

```typescript
import { unauthenticated } from "../../shopify.server";
import { resolveEntitlements } from "../billing/entitlements";

// Inside the for-loop, after the `if (!due) continue;` line:
try {
  const { admin } = await unauthenticated.admin(c.shop);
  const ent = await resolveEntitlements({ shop: c.shop, admin });
  if (ent.isSyncSuspended) {
    console.log(`[auto-sync] skipping ${c.shop} — sync suspended (state=${ent.state})`);
    continue;
  }
} catch (err) {
  console.error(`[auto-sync] entitlement lookup failed for ${c.shop}:`, err);
  // Fail-open: if entitlements are unreachable, don't block sync. The
  // worst case is one extra periodic tick before the merchant can fix.
}
```

Place this just before `await enqueueJob(c.shop, "sync")...`.

- [ ] **Step 3: Write integration test**

Create `app/lib/__tests__/integration/auto-sync-suspended.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import { __resetCacheForTests } from '../../billing/subscription';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
  __resetCacheForTests();
});

vi.mock('../../../shopify.server', () => ({
  unauthenticated: {
    admin: vi.fn(),
  },
}));

vi.mock('../../mail/job-queue', () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
}));

describe('enqueueDuePeriodicSyncs — entitlement gating', () => {
  it('skips a suspended shop (trial_expired)', async () => {
    await testDb.billingShopFlag.create({
      data: { shop: TEST_SHOP, installDate: new Date(Date.now() - 30 * 86400000) },
    });
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        email: 'a@b.c',
        accessToken: 'x',
        refreshToken: 'x',
        tokenExpiry: new Date(Date.now() + 86400000),
        autoSyncEnabled: true,
        autoSyncIntervalMinutes: 1,
        lastSyncAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    await testDb.session.create({
      data: {
        id: `offline_${TEST_SHOP}`,
        shop: TEST_SHOP,
        state: 'active',
        isOnline: false,
        accessToken: 'x',
      },
    });

    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: { currentAppInstallation: { activeSubscriptions: [] } },
      }),
    });
    const { unauthenticated } = await import('../../../shopify.server');
    (unauthenticated.admin as any).mockResolvedValue({ admin: { graphql: adminGraphql } });

    const { enqueueJob } = await import('../../mail/job-queue');
    const enqueueSpy = enqueueJob as any;

    // Import the auto-sync module fresh and trigger the periodic check.
    // We need to expose `enqueueDuePeriodicSyncs` for testing OR call the
    // top-level start function. Easiest: call the function directly via
    // a named export.
    const autoSync = await import('../../mail/auto-sync');
    if (typeof (autoSync as any).enqueueDuePeriodicSyncs === 'function') {
      await (autoSync as any).enqueueDuePeriodicSyncs();
    } else {
      throw new Error('enqueueDuePeriodicSyncs must be exported for testing');
    }

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('enqueues a healthy shop (trial_active)', async () => {
    await testDb.billingShopFlag.create({
      data: { shop: TEST_SHOP, installDate: new Date(Date.now() - 2 * 86400000) },
    });
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        email: 'a@b.c',
        accessToken: 'x',
        refreshToken: 'x',
        tokenExpiry: new Date(Date.now() + 86400000),
        autoSyncEnabled: true,
        autoSyncIntervalMinutes: 1,
        lastSyncAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    await testDb.session.create({
      data: {
        id: `offline_${TEST_SHOP}`,
        shop: TEST_SHOP,
        state: 'active',
        isOnline: false,
        accessToken: 'x',
      },
    });

    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({ data: { currentAppInstallation: { activeSubscriptions: [] } } }),
    });
    const { unauthenticated } = await import('../../../shopify.server');
    (unauthenticated.admin as any).mockResolvedValue({ admin: { graphql: adminGraphql } });

    const { enqueueJob } = await import('../../mail/job-queue');
    const enqueueSpy = enqueueJob as any;

    const autoSync = await import('../../mail/auto-sync');
    await (autoSync as any).enqueueDuePeriodicSyncs();

    expect(enqueueSpy).toHaveBeenCalledWith(TEST_SHOP, 'sync');
  });
});
```

If `enqueueDuePeriodicSyncs` is not currently exported, also export it:

```typescript
export async function enqueueDuePeriodicSyncs(): Promise<void> { ... }
```

- [ ] **Step 4: Run tests**

```bash
npm run test:integration -- auto-sync-suspended
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add app/lib/mail/auto-sync.ts app/lib/__tests__/integration/auto-sync-suspended.test.ts
git commit -m "feat(billing): suspend auto-sync when shop entitlements indicate suspended state"
```

---

## Task 4: 48h zone wiring in `pipeline.ts`

When auto-sync resumes after a suspend, it pulls all messages since `lastSyncAt`. For older messages (>48h), we skip Tier 2/3 to keep the catch-up cost bounded. They land in the inbox unanalyzed and surface as "À analyser".

**Files:**
- Modify: `app/lib/gmail/pipeline.ts`

- [ ] **Step 1: Read the relevant section of `pipeline.ts`**

Find the function that processes a single incoming email (likely named `processEmail`, `runPipelineForEmail`, or similar). It typically calls Tier 1 prefilter, then Tier 2 LLM classifier, then Tier 3 analysis.

- [ ] **Step 2: Add the 48h gate**

Near the top of the per-email pipeline function, after the Tier 1 prefilter call but before Tier 2, add:

```typescript
import { isWithin48hZone } from "../billing/catchup";

// Inside the per-email pipeline, after Tier 1:
const isFresh = isWithin48hZone(receivedAt);
if (!isFresh) {
  // Catch-up older message: skip Tier 2 + Tier 3.
  // The merchant can trigger explicit analysis from the inbox.
  console.log(`[pipeline] ${shop} email=${emailId} older than 48h, skipping Tier 2/3 (catch-up)`);
  // Persist with minimal state — leave analysisResult null and processingStatus
  // as 'received' or 'pending_analysis' so the inbox UI displays it as
  // "À analyser".
  await prisma.incomingEmail.update({
    where: { id: emailId },
    data: { processingStatus: 'received' },
  });
  return;
}
```

The exact field names (`processingStatus`, `received`, etc.) depend on the existing schema. Inspect the model and use the value that the inbox bucket logic recognizes as "not yet analyzed" (likely the same state as a freshly fetched, not-yet-classified email).

- [ ] **Step 3: Verify a unit test exists**

The 48h logic itself is tested via `catchup.test.ts` (Task 2). The pipeline integration would require a substantial new integration test. For Phase 4 v1, we accept that the wiring is verified by the catch-up helper test + manual smoke test in Task 7. If this proves fragile in production, add an integration test in a follow-up.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep "pipeline.ts" | head -5 || echo "no errors"
```

Expected: no NEW errors. Pre-existing errors in `pipeline.ts` are acceptable.

- [ ] **Step 5: Commit**

```bash
git add app/lib/gmail/pipeline.ts
git commit -m "feat(billing): catch-up — skip Tier 2/3 for emails older than 48h"
```

---

## Task 5: `<SyncSuspendedBanner>` component

**Files:**
- Create: `app/components/billing/SyncSuspendedBanner.tsx`
- Modify: `app/i18n/locales/en.json` and `fr.json`

- [ ] **Step 1: Create the component**

Create `app/components/billing/SyncSuspendedBanner.tsx`:

```typescript
import { useEntitlements } from "../../lib/billing/entitlements-context";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

/**
 * Inbox-level banner shown when auto-sync is paused due to billing state.
 * Distinct from QuotaBanner (which lives at app root): this one explains
 * specifically that incoming mails are NOT being fetched, so the inbox
 * may appear stale.
 */
export function SyncSuspendedBanner() {
  const ent = useEntitlements();
  const { t } = useTranslation();

  if (!ent.isSyncSuspended) return null;

  return (
    <div role="alert" style={{
      background: '#ffedd5',
      color: '#9a3412',
      border: '1px solid #fdba74',
      padding: '10px 14px',
      borderRadius: 6,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      fontSize: 14,
      marginBottom: 12,
    }}>
      <span>{t('billing.syncSuspended.banner')}</span>
      <Link to="/app/billing" style={{ color: 'inherit', fontWeight: 600 }}>
        {t('billing.upgradeCta')}
      </Link>
    </div>
  );
}
```

- [ ] **Step 2: Add i18n keys**

In `app/i18n/locales/en.json`, inside the `billing` namespace:

```json
"syncSuspended": {
  "banner": "Mailbox sync is paused — your quota is exhausted or your trial has ended. Upgrade or wait for the next monthly reset to resume."
}
```

In `app/i18n/locales/fr.json` inside `billing`:

```json
"syncSuspended": {
  "banner": "La synchronisation de votre boîte mail est en pause — votre quota est épuisé ou votre essai est terminé. Passez à un plan supérieur ou attendez le reset mensuel pour reprendre."
}
```

- [ ] **Step 3: Mount the banner in the inbox**

In `app/routes/app.inbox.tsx`, add the import:

```typescript
import { SyncSuspendedBanner } from "../components/billing/SyncSuspendedBanner";
```

Find the JSX that begins the inbox content (the heading "Email inbox" / `<h1>`). Insert the banner just above it, so it appears at the top of the page right under the global trial/quota banner. Example:

```tsx
<SyncSuspendedBanner />
<h1>{t('inbox.title')}</h1>
{/* ... rest of the inbox ... */}
```

If you can't determine the exact insertion point safely from a quick grep, mount it once at the top of the main content `<div>` returned by `InboxPage` (line ~2470).

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "SyncSuspendedBanner|app\\.inbox" | head -5 || echo "no errors"
```

Expected: only pre-existing errors.

- [ ] **Step 5: Commit**

```bash
git add app/components/billing/SyncSuspendedBanner.tsx app/i18n/locales/ app/routes/app.inbox.tsx
git commit -m "feat(billing): SyncSuspendedBanner shown at top of inbox when sync is paused"
```

---

## Task 6: Wire `isSyncSuspended` to root context (loader)

**Files:**
- Modify: `app/routes/app.tsx`

The root loader already passes `entitlements` to the client. We just need to ensure `isSyncSuspended` is part of the serialized payload.

- [ ] **Step 1: Confirm the loader includes `isSyncSuspended`**

Read the loader return in `app/routes/app.tsx`. The `entitlements` object already spreads many fields. Add `isSyncSuspended: ent.isSyncSuspended` to the serialized list (alongside `canGenerateDraft`, `canConnectMailbox`, etc.).

- [ ] **Step 2: Confirm the EntitlementsProvider re-hydrates correctly**

The provider already takes `Entitlements` and re-hydrates Date fields. Adding a boolean is transparent — no extra rehydration needed.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep "app\\.tsx$" | head -5 || echo "no errors"
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.tsx
git commit -m "feat(billing): pass isSyncSuspended through root context"
```

---

## Task 7: Manual smoke test

- [ ] **Step 1: Run all billing tests**

```bash
npm test -- billing
npm run test:integration -- billing
npm run test:integration -- auto-sync-suspended
```

Expected: all green.

- [ ] **Step 2: Manual smoke test on dev shop**

Same procedure as Phase 3 wrap-up:

1. Set `BillingShopFlag.installDate = NOW() - INTERVAL '15 days'` to force `trial_expired`.
2. Reload `/app/inbox`. Verify:
   - Top trial banner shows "Votre essai est terminé. Choisissez un plan…"
   - Below it, the orange `SyncSuspendedBanner` appears with the matching wording
   - Trying "Générer le brouillon" still triggers the quota modal (Phase 3 behavior preserved)
3. Reset to clean state: `installDate = NOW(), isInternal = false`.
4. Verify the orange banner disappears and sync resumes.

(The 48h zone behavior is harder to smoke-test live without a backlog of older messages; the unit tests on `isWithin48hZone` cover the logic.)

---

## Phase 4 wrap-up

- [ ] **Step 1: Final test run**

```bash
npm test
npm run test:integration
```

Expected:
- Unit billing: 25 → ~32 (+~6 from catchup tests)
- Integration billing: 37 → ~44 (+5 entitlements isSyncSuspended + 2 auto-sync-suspended)
- No regressions on existing tests.

- [ ] **Step 2: Optional: dispatch a final code review**

Same template as Phases 1-3. Reviewer should focus on:
- The auto-sync suspend path: does the entitlement lookup add latency or fail noisily?
- Pipeline 48h gate: is `processingStatus = 'received'` the right value?
- Banner placement in inbox: is it above any layout that might cover it?

---

## Out of scope for Phase 4

- **Phase 5:** Migration of existing shops to trial, full `autoDraft` UI cleanup in `app.settings.tsx`, privacy policy update, App Listing prep.

## Self-review notes

- Spec coverage:
  - Auto-sync suspend ✅ Task 3
  - Catch-up 48h zone helper ✅ Task 2
  - Pipeline 48h gate ✅ Task 4
  - UI suspended banner ✅ Task 5
  - Root context wiring ✅ Task 6
- Type consistency: `Entitlements.isSyncSuspended` introduced in Task 1 and consumed in Tasks 3, 5, 6.
- The "À analyser" / "À traiter" folder concept is satisfied by the existing inbox bucket (already shows threads without drafts as "À traiter") — no new tab introduced. If the spec's exact wording is desired, that's a small i18n rename in a follow-up.
- `app_subscriptions/update` webhook (Phase 2) already invalidates the subscription cache, so the post-upgrade resume happens on the next periodic tick (≤5min latency) — acceptable.
