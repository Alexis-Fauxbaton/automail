# Paid Plans Phase 3 — Enforcement at Call Sites

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Wire `entitlements` (Phase 1) into actual call sites so quota and feature gating take effect for real merchants. After this phase, generating a draft consumes 1 unit, hitting the cap blocks generation, connecting an extra mailbox is refused on Starter, and the dashboard hides advanced sections for non-Pro plans. This is the first end-to-end testable state of the paid-plans system.

**Architecture:** Each call site that invokes the LLM to produce a draft (initial generation, refine, regenerate) is wrapped in `tryReserveDraft → LLM → releaseDraft on failure`. Each route that reads quota-sensitive features calls `resolveEntitlements` to make permission decisions. Failed reservations return a structured error that the UI catches and displays via the existing `<QuotaExceededModal>`.

**Tech Stack:** TypeScript, React Router 7, Prisma, vitest.

**Reference spec:** [docs/superpowers/specs/2026-05-08-paid-plans-design.md](docs/superpowers/specs/2026-05-08-paid-plans-design.md)
**Phase 1 plan:** [docs/superpowers/plans/2026-05-08-paid-plans-phase-1-foundations.md](docs/superpowers/plans/2026-05-08-paid-plans-phase-1-foundations.md)
**Phase 2 plan:** [docs/superpowers/plans/2026-05-08-paid-plans-phase-2-billing-ui.md](docs/superpowers/plans/2026-05-08-paid-plans-phase-2-billing-ui.md)

---

## File Structure

| File | Modification |
|---|---|
| `app/lib/billing/draft-guard.ts` | Create: helper wrapping any LLM-draft call with reserve/release semantics |
| `app/lib/billing/__tests__/draft-guard.test.ts` | Create: unit tests for the guard |
| `app/lib/support/inbox-actions.ts` | Modify: wrap LLM-draft handlers with the guard |
| `app/routes/app.inbox.tsx` | Modify: handle `quotaExceeded` field in actionData, show modal |
| `app/routes/mail-auth.tsx` | Modify: refuse new mailbox connection when at limit |
| `app/routes/app.dashboard.tsx` | Modify: gate advanced sections, clamp range to plan max |
| `app/lib/__tests__/integration/draft-guard-inbox.test.ts` | Create |
| `app/lib/__tests__/integration/dashboard-gating.test.ts` | Create |
| `app/i18n/locales/en.json` and `fr.json` | Modify: add `billing.mailbox.*` and `billing.dashboard.gated.*` keys |

---

## Task 1: `draft-guard.ts` — wrapper around LLM draft calls

**Files:**
- Create: `app/lib/billing/draft-guard.ts`
- Test: `app/lib/billing/__tests__/draft-guard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/billing/__tests__/draft-guard.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { withDraftQuota } from '../draft-guard';

describe('withDraftQuota', () => {
  it('reserves before generation, returns LLM result on success', async () => {
    const reserveImpl = vi.fn().mockResolvedValueOnce({ ok: true, newCount: 12 });
    const releaseImpl = vi.fn().mockResolvedValueOnce(undefined);
    const generator = vi.fn().mockResolvedValue({ draft: 'hello' });

    const result = await withDraftQuota({
      shop: 'test.myshopify.com',
      limit: 50,
      generator,
      reserveImpl,
      releaseImpl,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ draft: 'hello' });
      expect(result.newCount).toBe(12);
    }
    expect(reserveImpl).toHaveBeenCalledOnce();
    expect(generator).toHaveBeenCalledOnce();
    expect(releaseImpl).not.toHaveBeenCalled();
  });

  it('returns quota_exceeded without calling generator', async () => {
    const reserveImpl = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'quota_exceeded' });
    const releaseImpl = vi.fn();
    const generator = vi.fn();

    const result = await withDraftQuota({
      shop: 'test.myshopify.com',
      limit: 50,
      generator,
      reserveImpl,
      releaseImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('quota_exceeded');
    expect(generator).not.toHaveBeenCalled();
  });

  it('releases the reservation if generator throws', async () => {
    const reserveImpl = vi.fn().mockResolvedValueOnce({ ok: true, newCount: 5 });
    const releaseImpl = vi.fn().mockResolvedValueOnce(undefined);
    const generator = vi.fn().mockRejectedValue(new Error('LLM down'));

    const result = await withDraftQuota({
      shop: 'test.myshopify.com',
      limit: 50,
      generator,
      reserveImpl,
      releaseImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('generator_failed');
    expect(releaseImpl).toHaveBeenCalledOnce();
  });

  it('still returns failure if release itself throws (best-effort)', async () => {
    const reserveImpl = vi.fn().mockResolvedValueOnce({ ok: true, newCount: 5 });
    const releaseImpl = vi.fn().mockRejectedValueOnce(new Error('DB down'));
    const generator = vi.fn().mockRejectedValue(new Error('LLM down'));

    const result = await withDraftQuota({
      shop: 'test.myshopify.com',
      limit: 50,
      generator,
      reserveImpl,
      releaseImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('generator_failed');
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run app/lib/billing/__tests__/draft-guard.test.ts`
Expected: FAIL — `Cannot find module '../draft-guard'`.

- [ ] **Step 3: Implement `draft-guard.ts`**

Create `app/lib/billing/draft-guard.ts`:

```typescript
/**
 * Standardized wrapper around any LLM call that produces a billable draft.
 *
 * Pattern:
 *   1. Reserve 1 unit (atomic CAS via tryReserveDraft).
 *      - If quota exceeded → return structured error, no LLM call.
 *   2. Run the generator.
 *      - On success → return value + new count.
 *      - On failure → release the reservation, return structured error.
 *
 * Caller (route action / inbox-actions handler) translates the structured
 * error into HTTP/UI:
 *   - quota_exceeded → 402 + modal "Quota reached"
 *   - generator_failed → 500 + retry / error toast
 *
 * The reserveImpl / releaseImpl injections are for testing; production
 * callers omit them and the defaults are used.
 */

import {
  tryReserveDraft as defaultReserve,
  releaseDraft as defaultRelease,
} from "./usage";

export type DraftGuardResult<T> =
  | { ok: true; value: T; newCount: number }
  | { ok: false; reason: 'quota_exceeded' | 'generator_failed'; error?: unknown };

interface ReserveImpl {
  (input: { shop: string; limit: number; now?: Date }):
    Promise<{ ok: true; newCount: number } | { ok: false; reason: 'quota_exceeded' }>;
}
interface ReleaseImpl {
  (input: { shop: string; now?: Date }): Promise<void>;
}

export async function withDraftQuota<T>(input: {
  shop: string;
  limit: number;
  generator: () => Promise<T>;
  reserveImpl?: ReserveImpl;
  releaseImpl?: ReleaseImpl;
}): Promise<DraftGuardResult<T>> {
  const reserve = input.reserveImpl ?? defaultReserve;
  const release = input.releaseImpl ?? defaultRelease;

  const reserveResult = await reserve({ shop: input.shop, limit: input.limit });
  if (!reserveResult.ok) {
    return { ok: false, reason: 'quota_exceeded' };
  }

  try {
    const value = await input.generator();
    return { ok: true, value, newCount: reserveResult.newCount };
  } catch (err) {
    try {
      await release({ shop: input.shop });
    } catch (releaseErr) {
      console.error(`[billing] release after failed generator failed for ${input.shop}:`, releaseErr);
    }
    return { ok: false, reason: 'generator_failed', error: err };
  }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run app/lib/billing/__tests__/draft-guard.test.ts`
Expected: PASS — 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add app/lib/billing/draft-guard.ts app/lib/billing/__tests__/draft-guard.test.ts
git commit -m "feat(billing): draft generation guard (reserve/release wrapper)"
```

---

## Task 2: Wire the guard into `inbox-actions.ts`

The two LLM-generating handlers in this file are the ones calling `redraftEmail` (initial draft + regenerate) and `refineDraft` (refine). Wrap their callers with the guard.

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`
- Create: `app/lib/__tests__/integration/draft-guard-inbox.test.ts`

- [ ] **Step 1: Read the current file**

Run Grep on `app/lib/support/inbox-actions.ts` for `redraftEmail` and `refineDraft` to find the handlers (typically `handleRedraft` and `handleRefine`, but adapt to actual names).

- [ ] **Step 2: Add imports at the top of `inbox-actions.ts`**

```typescript
import { withDraftQuota } from "../billing/draft-guard";
import { resolveEntitlements } from "../billing/entitlements";
```

- [ ] **Step 3: Wrap each LLM-generating handler with the guard**

For each handler that ends up calling `redraftEmail` or `refineDraft`, transform the body. Example for `handleRedraft`:

```typescript
export async function handleRedraft(params: { shop: string; emailId: string; admin: AdminGraphqlClient }) {
  // ... existing pre-checks (email exists, etc.) ...

  const ent = await resolveEntitlements({ shop: params.shop, admin: params.admin });
  if (!ent.canGenerateDraft) {
    return {
      redrafted: false,
      quotaExceeded: true,
      quotaStatus: { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit },
    };
  }

  const guarded = await withDraftQuota({
    shop: params.shop,
    limit: ent.quotaStatus.limit,
    generator: () => redraftEmail(params.emailId, params.admin, params.shop),
  });

  if (!guarded.ok) {
    if (guarded.reason === 'quota_exceeded') {
      return {
        redrafted: false,
        quotaExceeded: true,
        quotaStatus: { used: ent.quotaStatus.used + 1, limit: ent.quotaStatus.limit },
      };
    }
    throw guarded.error ?? new Error('Draft generation failed');
  }

  return {
    redrafted: true,
    ...guarded.value,
    quotaStatus: { used: guarded.newCount, limit: ent.quotaStatus.limit },
  };
}
```

Apply the equivalent transformation to the refine handler. The two-step pattern (informational `canGenerateDraft` check + atomic `withDraftQuota`) lets the UI distinguish "you were already at limit before clicking" from "you hit the limit on this very click".

- [ ] **Step 4: Add an integration test**

Create `app/lib/__tests__/integration/draft-guard-inbox.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
});

vi.mock('../../gmail/pipeline', () => ({
  redraftEmail: vi.fn().mockResolvedValue({ draft: 'mocked draft text' }),
}));

describe('handleRedraft — quota enforcement', () => {
  it('refuses when shop is at quota cap on Starter', async () => {
    await testDb.billingShopFlag.create({
      data: { shop: TEST_SHOP, installDate: new Date(Date.now() - 30 * 86400000) },
    });
    const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await testDb.billingUsage.create({
      data: { shop: TEST_SHOP, periodStart, draftsCount: 50 },
    });

    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
            ],
          },
        },
      }),
    });

    const { handleRedraft } = await import('../../support/inbox-actions');
    const result = await handleRedraft({
      shop: TEST_SHOP,
      emailId: 'fake-email-id',
      admin: { graphql: adminGraphql } as any,
    });

    expect((result as any).redrafted).toBe(false);
    expect((result as any).quotaExceeded).toBe(true);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm run test:integration -- draft-guard-inbox`
Expected: PASS — 1 test passing.

Run: `npm run test:integration -- reply-draft` (existing tests if any)
Expected: still passing. If any existing test fails because the response shape changed (added `quotaStatus` field), update assertions accordingly.

- [ ] **Step 6: Commit**

```bash
git add app/lib/support/inbox-actions.ts app/lib/__tests__/integration/draft-guard-inbox.test.ts
git commit -m "feat(billing): enforce quota in inbox actions (redraft, refine)"
```

---

## Task 3: Surface quota errors in the inbox UI

The inbox component receives the action response and needs to show the modal when `quotaExceeded` is true.

**Files:**
- Modify: `app/routes/app.inbox.tsx`

- [ ] **Step 1: Add imports**

```typescript
import { useState, useEffect } from "react";
import { QuotaExceededModal } from "../components/billing/QuotaExceededModal";
```

- [ ] **Step 2: Add state in the inbox component**

Inside the inbox component (find where `actionData` is consumed):

```typescript
const [quotaModal, setQuotaModal] = useState<{
  open: boolean;
  used: number;
  limit: number;
  variant: 'exceeded' | 'just_used_last';
}>({ open: false, used: 0, limit: 0, variant: 'exceeded' });

useEffect(() => {
  const data = (actionData as any) ?? null;
  if (!data) return;
  if (data.quotaExceeded) {
    setQuotaModal({
      open: true,
      used: data.quotaStatus?.used ?? 0,
      limit: data.quotaStatus?.limit ?? 0,
      variant: 'exceeded',
    });
  } else if (data.quotaStatus && data.quotaStatus.used === data.quotaStatus.limit) {
    setQuotaModal({
      open: true,
      used: data.quotaStatus.used,
      limit: data.quotaStatus.limit,
      variant: 'just_used_last',
    });
  }
}, [actionData]);
```

- [ ] **Step 3: Mount the modal in JSX**

At the bottom of the component's return:

```tsx
<QuotaExceededModal
  open={quotaModal.open}
  onClose={() => setQuotaModal({ ...quotaModal, open: false })}
  variant={quotaModal.variant}
  used={quotaModal.used}
  limit={quotaModal.limit}
/>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no new errors related to the modal.

- [ ] **Step 5: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat(billing): show QuotaExceededModal on inbox draft actions"
```

---

## Task 4: Mailbox limit enforcement in `mail-auth.tsx`

`mail-auth.tsx` initiates OAuth for Gmail/Outlook/Zoho. Block initiation if `canConnectMailbox` is false.

**Files:**
- Modify: `app/routes/mail-auth.tsx`
- Modify: `app/i18n/locales/en.json` and `fr.json`

- [ ] **Step 1: Read the current action**

Read `app/routes/mail-auth.tsx` to identify the action handler that initiates OAuth (typically a redirect or fetch to the provider's auth URL).

- [ ] **Step 2: Add the entitlement check at the top of the action**

```typescript
import { resolveEntitlements } from "../lib/billing/entitlements";

// Inside the action, after authenticate.admin:
const ent = await resolveEntitlements({ shop: session.shop, admin });
if (!ent.canConnectMailbox) {
  return data(
    {
      error: "mailbox_limit_reached",
      mailboxStatus: ent.mailboxStatus,
    },
    { status: 403 }
  );
}
```

- [ ] **Step 3: Surface the error in the page component**

Find where `actionData` is rendered. Add a conditional block:

```tsx
{actionData && 'error' in actionData && actionData.error === 'mailbox_limit_reached' && (
  <div role="alert" style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 6 }}>
    {t('billing.mailbox.limitReached', {
      used: actionData.mailboxStatus.used,
      limit: actionData.mailboxStatus.limit,
    })}
    {' '}
    <a href="/app/billing">{t('billing.upgradeCta')}</a>
  </div>
)}
```

- [ ] **Step 4: Add i18n keys**

In `app/i18n/locales/en.json`, in the `billing` namespace:

```json
"mailbox": {
  "limitReached": "Mailbox limit reached ({{used}}/{{limit}}). Upgrade to connect more."
}
```

In `app/i18n/locales/fr.json`:

```json
"mailbox": {
  "limitReached": "Limite de boîtes mail atteinte ({{used}}/{{limit}}). Passe à Pro pour en ajouter."
}
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add app/routes/mail-auth.tsx app/i18n/locales/
git commit -m "feat(billing): enforce mailbox limit at OAuth initiation"
```

---

## Task 5: Dashboard gating in `app.dashboard.tsx`

Starter limits the dashboard to:
- 7-day max range (clamp regardless of `?range=` param)
- KPIs only — strip heatmap, alerts, reopened, intent breakdown details, period-over-period comparisons

**Files:**
- Modify: `app/routes/app.dashboard.tsx`
- Create: `app/lib/__tests__/integration/dashboard-gating.test.ts`
- Modify: `app/i18n/locales/en.json` and `fr.json`

- [ ] **Step 1: Read the current loader**

Read `app/routes/app.dashboard.tsx` to identify:
- Where `range` is parsed (`7d`, `30d`, `90d`)
- Which fields are fetched conditionally (heatmap, alerts, reopenedThreads, comparisons)

- [ ] **Step 2: Update the loader**

Add at the top of the loader (after `authenticate.admin`):

```typescript
import { resolveEntitlements } from "../lib/billing/entitlements";

// inside the loader:
const ent = await resolveEntitlements({ shop, admin });

const url = new URL(request.url);
let range = url.searchParams.get("range") ?? "30d";
const maxDays = ent.dashboardMaxRangeDays;
const requestedDays = parseRangeDays(range);
if (requestedDays > maxDays) {
  range = maxDays === 7 ? "7d" : `${maxDays}d`;
}

// existing code to fetch KPIs (always fetched) ...

// Conditionally skip the advanced data sources.
const heatmap = ent.canViewAdvancedDashboard ? await getHeatmap(shop, start, end) : null;
const alerts = ent.canViewAdvancedDashboard ? await getAlerts(...) : [];
const reopenedThreads = ent.canViewAdvancedDashboard ? await getReopenedThreads(...) : [];
const topIntentsAll = ent.canViewAdvancedDashboard
  ? await getTopIntentsWithPerf(shop, start, end, 8)
  : await getTopIntentsWithPerf(shop, start, end, 3);

// (Skip prevPeriod / comparison metrics if not advanced — guard those calls similarly.)

return {
  // ... existing fields ...
  isAdvancedDashboard: ent.canViewAdvancedDashboard,
  heatmap,
  alerts,
  reopenedThreads,
  topIntentsAll,
  rangeMaxDays: maxDays,
};
```

Add the helper at the bottom of the file:

```typescript
function parseRangeDays(range: string): number {
  const match = /^(\d+)d$/.exec(range);
  if (!match) return 30;
  return parseInt(match[1], 10);
}
```

- [ ] **Step 3: Update the JSX to hide advanced sections when `!isAdvancedDashboard`**

Wherever the JSX renders heatmap, alerts, reopened, or comparisons, wrap with:

```tsx
{isAdvancedDashboard ? (
  <HeatmapSection data={heatmap} />
) : (
  <PlanGatePlaceholder feature="heatmap" />
)}
```

Add a small inline component at the bottom of the file:

```tsx
function PlanGatePlaceholder({ feature }: { feature: string }) {
  const { t } = useTranslation();
  return (
    <div style={{
      border: '1px dashed #d1d5db',
      borderRadius: 6,
      padding: '20px',
      textAlign: 'center',
      color: '#6b7280',
    }}>
      <p>{t(`billing.dashboard.gated.${feature}`, t('billing.dashboard.gated.default'))}</p>
      <a href="/app/billing" style={{ fontWeight: 600 }}>{t('billing.upgradeCta')}</a>
    </div>
  );
}
```

- [ ] **Step 4: Add i18n keys**

In `app/i18n/locales/en.json`, inside the `billing` namespace:

```json
"dashboard": {
  "gated": {
    "default": "Available on Pro",
    "heatmap": "Activity heatmap is available on Pro",
    "alerts": "Anomaly alerts are available on Pro",
    "reopened": "Reopened threads insight is available on Pro",
    "comparison": "Period-over-period comparison is available on Pro"
  }
}
```

In `fr.json`:

```json
"dashboard": {
  "gated": {
    "default": "Disponible sur Pro",
    "heatmap": "La heatmap d'activité est disponible sur Pro",
    "alerts": "Les alertes d'anomalies sont disponibles sur Pro",
    "reopened": "Les threads rouverts sont disponibles sur Pro",
    "comparison": "La comparaison période vs période est disponible sur Pro"
  }
}
```

- [ ] **Step 5: Add the integration test**

Create `app/lib/__tests__/integration/dashboard-gating.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
});

vi.mock('../../../shopify.server', () => ({
  authenticate: { admin: vi.fn() },
}));

describe('dashboard loader — Starter gating', () => {
  it('strips advanced data and clamps range to 7d', async () => {
    await testDb.billingShopFlag.create({
      data: { shop: TEST_SHOP, installDate: new Date(Date.now() - 30 * 86400000) },
    });

    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              { id: 'gid://1', name: 'starter', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
            ],
          },
        },
      }),
    });

    const { authenticate } = await import('../../../shopify.server');
    (authenticate.admin as any).mockResolvedValue({
      session: { shop: TEST_SHOP },
      admin: { graphql: adminGraphql },
    });

    const { loader } = await import('../../../routes/app.dashboard');
    const result = await loader({
      request: new Request('https://x/app/dashboard?range=90d'),
    } as any);

    const response = result instanceof Response ? await result.json() : result;
    expect(response.isAdvancedDashboard).toBe(false);
    expect(response.heatmap).toBeNull();
    expect(response.alerts).toEqual([]);
    expect(response.rangeMaxDays).toBe(7);
  });
});
```

- [ ] **Step 6: Run test**

Run: `npm run test:integration -- dashboard-gating`
Expected: PASS — 1 test passing.

- [ ] **Step 7: Commit**

```bash
git add app/routes/app.dashboard.tsx app/i18n/locales/ app/lib/__tests__/integration/dashboard-gating.test.ts
git commit -m "feat(billing): gate dashboard advanced features and clamp range for Starter"
```

---

## Task 6: Final test run + manual smoke test

- [ ] **Step 1: Run all tests**

```bash
npm test
npm run test:integration
```

Expected: all unit tests passing, all integration tests passing (existing + ~6 new ones added in Phase 3).

- [ ] **Step 2: Manual smoke test on dev shop**

Start the app locally and exercise the full lifecycle:

1. **Trial flow**: install on a fresh dev shop. Trial banner shows "14 days left", top bar counter shows "Trial — 14 days left".
2. **Subscribe Starter** via `/app/billing` → Shopify confirmation → return → counter shows "0 / 50 drafts".
3. **Generate 1 draft** in inbox → counter goes to "1 / 50".
4. **Hit quota**: manually set `draftsCount=49` in DB, generate 1 → "50 / 50", "just used last" modal appears.
5. **Try another generation** → quota exceeded modal.
6. **Connect a 2nd mailbox on Starter** → 403 + error UI ("Mailbox limit reached").
7. **Switch to Pro** via billing page → counter limit jumps to 500, modal disappears, advanced dashboard sections appear.
8. **Schedule downgrade** Pro → Starter via billing page → notice on billing page, plan stays Pro until effectiveAt.
9. **View dashboard with `?range=90d` on Starter** → backend reports `rangeMaxDays=7`, advanced sections show placeholder.

- [ ] **Step 3: Final commit if needed**

If any tweaks were needed during smoke test, commit them with a clear message.

---

## Phase 3 wrap-up

- [ ] **Step 1: Final code review**

Dispatch a code-quality reviewer subagent that reads:

- `app/lib/billing/draft-guard.ts`
- `app/lib/support/inbox-actions.ts` (changed sections)
- `app/routes/app.inbox.tsx` (modal integration)
- `app/routes/mail-auth.tsx` (mailbox check)
- `app/routes/app.dashboard.tsx` (gating)

Looking for: race conditions, missing release-on-failure paths, places where quota_exceeded could silently fall through, multi-tenant `shop` scoping leaks, magic numbers, missing i18n keys.

- [ ] **Step 2: Confirm Phase 3 is done**

Phase 3 done means:
- Drafts consume quota on every LLM-generation action
- Quota exceeded blocks new generation with a modal
- Mailbox limit blocks OAuth for new connections
- Dashboard gating works for Starter
- The full lifecycle (trial → starter → pro → downgrade) is testable end-to-end

---

## Out of scope for Phase 3

- **Phase 4:** auto-sync suspend/resume + 48h zone catch-up + folder "À analyser" UI.
- **Phase 5:** migration of existing shops to trial, autoDraft UI cleanup in `app.settings.tsx`, privacy policy update, App Listing prep.

## Self-review notes

- Spec coverage: draft quota enforcement (Tasks 1, 2, 3), mailbox limit (Task 4), dashboard gating (Task 5). ✅
- Type consistency: `Entitlements`, `QuotaStatus`, `DraftGuardResult` all consistent with Phase 1.
- Tests cover: guard logic (unit), inbox quota refusal (integration), dashboard Starter gating (integration); existing reply-draft tests remain green after the response-shape extension.
- The "informational `canGenerateDraft` check before reserve" pattern is documented in Task 2 — not redundant, as it produces a cleaner UI response when the shop was *already* over quota before clicking.
- Manual smoke test in Task 6 step 2 is the first end-to-end testable state and is essential before declaring Phase 3 done.
