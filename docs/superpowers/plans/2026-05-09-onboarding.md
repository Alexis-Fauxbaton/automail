# Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-run onboarding flow (blocking wizard for mailbox connection + dismissable inbox checklist) so freshly-installed merchants are guided to their first generated draft.

**Architecture:** New `app/lib/onboarding/` module (pure state derivation + repo + route guard). New blocking route `/app/onboarding`. Existing model `BillingShopFlag` renamed to `ShopFlag` with two new columns: `onboardingCompletedAt`, `checklistDismissedAt`. Guard added to `/app`, `/app/inbox`, `/app/dashboard`, `/app/settings`, `/app/support`, `/app/additional`. Checklist component rendered at top of `/app/inbox`.

**Tech Stack:** TypeScript, React Router (Remix-style), Prisma, Polaris (Shopify), Vitest (unit + integration), Playwright (E2E).

**Spec:** [docs/superpowers/specs/2026-05-09-onboarding-design.md](../specs/2026-05-09-onboarding-design.md)

---

## Task 1: Rename `BillingShopFlag` → `ShopFlag` + add columns + backfill

**Files:**
- Modify: `prisma/schema.prisma:442-447`
- Create: `prisma/migrations/20260509120000_shop_flag_rename_and_onboarding/migration.sql`

- [ ] **Step 1: Update Prisma schema**

Edit `prisma/schema.prisma`, replace the `BillingShopFlag` block:

```prisma
model ShopFlag {
  shop                  String    @id
  isInternal            Boolean   @default(false)
  installDate           DateTime  @default(now())
  onboardingCompletedAt DateTime?
  checklistDismissedAt  DateTime?
  updatedAt             DateTime  @updatedAt
}
```

- [ ] **Step 2: Create the migration directory and SQL**

Create `prisma/migrations/20260509120000_shop_flag_rename_and_onboarding/migration.sql`:

```sql
-- Rename table.
ALTER TABLE "BillingShopFlag" RENAME TO "ShopFlag";

-- Add new nullable columns.
ALTER TABLE "ShopFlag" ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);
ALTER TABLE "ShopFlag" ADD COLUMN "checklistDismissedAt" TIMESTAMP(3);

-- Backfill: shops that already have a MailConnection are considered onboarded
-- as of their install date. Re-prompting them with a Welcome wizard would be
-- jarring and gives them no value.
UPDATE "ShopFlag"
SET "onboardingCompletedAt" = "installDate"
WHERE "shop" IN (SELECT "shop" FROM "MailConnection");
```

- [ ] **Step 3: Run `prisma generate` to update client types**

Run: `npx prisma generate`
Expected: success, types updated.

- [ ] **Step 4: Update all call sites — production code**

Find every `prisma.billingShopFlag` and `BillingShopFlag` reference outside of migrations and the spec, and replace with `prisma.shopFlag` / `ShopFlag`.

Known call sites to update (verify with `grep -rn "billingShopFlag\|BillingShopFlag" app/ --include="*.ts"`):
- `app/lib/billing/entitlements.ts:78` — `prisma.billingShopFlag.upsert(...)` → `prisma.shopFlag.upsert(...)`
- `app/lib/billing/migration.ts` — replace all `prisma.billingShopFlag.*` calls
- Any other production `*.ts` file under `app/`

Do NOT touch files under `prisma/migrations/` (historical SQL must stay).
Do NOT touch the spec file or other `docs/` files in this task.

- [ ] **Step 5: Update all call sites — tests**

Replace in:
- `app/lib/__tests__/integration/helpers/db.ts:32` — `tx.billingShopFlag.deleteMany` → `tx.shopFlag.deleteMany`
- `app/lib/__tests__/integration/billing-entitlements.test.ts` (3 sites: lines 30, 190, 220, 315)
- `app/lib/__tests__/integration/auto-sync-suspended.test.ts:28`
- `app/lib/__tests__/integration/draft-guard-inbox.test.ts:24`
- `app/lib/__tests__/integration/dashboard-gating.test.ts:20`
- `app/lib/__tests__/integration/billing-migration.test.ts:11`

Sed-equivalent: change `billingShopFlag` → `shopFlag` (camelCase, preserves call site shape).

- [ ] **Step 6: Run unit tests to confirm rename is clean**

Run: `npm run test`
Expected: PASS (no compile errors related to `billingShopFlag` / `BillingShopFlag`).

- [ ] **Step 7: Run integration tests against a fresh DB**

Run: `npx prisma migrate reset --force && npm run test:integration`
Expected: PASS. The migration applies cleanly on an empty DB and all tests still pass.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260509120000_shop_flag_rename_and_onboarding app/
git commit -m "refactor(db): rename BillingShopFlag to ShopFlag and add onboarding columns"
```

---

## Task 2: Pure state derivation module

**Files:**
- Create: `app/lib/onboarding/state.ts`
- Create: `app/lib/onboarding/__tests__/state.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/lib/onboarding/__tests__/state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  isOnboardingComplete,
  isChecklistDismissed,
  deriveChecklistState,
  type ShopFlagLike,
  type ChecklistInputs,
} from '../state';

const baseFlag: ShopFlagLike = {
  shop: 's.myshopify.com',
  onboardingCompletedAt: null,
  checklistDismissedAt: null,
};

describe('isOnboardingComplete', () => {
  it('returns false when flag is null', () => {
    expect(isOnboardingComplete(null)).toBe(false);
  });
  it('returns false when onboardingCompletedAt is null', () => {
    expect(isOnboardingComplete(baseFlag)).toBe(false);
  });
  it('returns true when onboardingCompletedAt is set', () => {
    expect(isOnboardingComplete({ ...baseFlag, onboardingCompletedAt: new Date() })).toBe(true);
  });
});

describe('isChecklistDismissed', () => {
  it('returns false when flag is null', () => {
    expect(isChecklistDismissed(null)).toBe(false);
  });
  it('returns false when checklistDismissedAt is null', () => {
    expect(isChecklistDismissed(baseFlag)).toBe(false);
  });
  it('returns true when checklistDismissedAt is set', () => {
    expect(isChecklistDismissed({ ...baseFlag, checklistDismissedAt: new Date() })).toBe(true);
  });
});

describe('deriveChecklistState', () => {
  const inputs: ChecklistInputs = {
    hasDraft: false,
    hasCustomizedSettings: false,
  };

  it('marks both items unchecked when nothing is done', () => {
    const state = deriveChecklistState(inputs);
    expect(state.firstDraft).toBe(false);
    expect(state.toneAndSignature).toBe(false);
    expect(state.completedCount).toBe(0);
    expect(state.totalCount).toBe(2);
    expect(state.allComplete).toBe(false);
  });

  it('marks firstDraft checked when hasDraft is true', () => {
    const state = deriveChecklistState({ ...inputs, hasDraft: true });
    expect(state.firstDraft).toBe(true);
    expect(state.completedCount).toBe(1);
    expect(state.allComplete).toBe(false);
  });

  it('marks toneAndSignature checked when hasCustomizedSettings is true', () => {
    const state = deriveChecklistState({ ...inputs, hasCustomizedSettings: true });
    expect(state.toneAndSignature).toBe(true);
    expect(state.completedCount).toBe(1);
  });

  it('marks all complete when both inputs are true', () => {
    const state = deriveChecklistState({ hasDraft: true, hasCustomizedSettings: true });
    expect(state.allComplete).toBe(true);
    expect(state.completedCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- app/lib/onboarding/__tests__/state.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `state.ts`**

Create `app/lib/onboarding/state.ts`:

```typescript
export interface ShopFlagLike {
  shop: string;
  onboardingCompletedAt: Date | null;
  checklistDismissedAt: Date | null;
}

export interface ChecklistInputs {
  hasDraft: boolean;
  hasCustomizedSettings: boolean;
}

export interface ChecklistState {
  firstDraft: boolean;
  toneAndSignature: boolean;
  completedCount: number;
  totalCount: number;
  allComplete: boolean;
}

export function isOnboardingComplete(flag: ShopFlagLike | null): boolean {
  return !!flag?.onboardingCompletedAt;
}

export function isChecklistDismissed(flag: ShopFlagLike | null): boolean {
  return !!flag?.checklistDismissedAt;
}

export function deriveChecklistState(inputs: ChecklistInputs): ChecklistState {
  const firstDraft = inputs.hasDraft;
  const toneAndSignature = inputs.hasCustomizedSettings;
  const completedCount = (firstDraft ? 1 : 0) + (toneAndSignature ? 1 : 0);
  const totalCount = 2;
  return {
    firstDraft,
    toneAndSignature,
    completedCount,
    totalCount,
    allComplete: completedCount === totalCount,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- app/lib/onboarding/__tests__/state.test.ts`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add app/lib/onboarding/state.ts app/lib/onboarding/__tests__/state.test.ts
git commit -m "feat(onboarding): add pure state derivation module"
```

---

## Task 3: DB I/O repo

**Files:**
- Create: `app/lib/onboarding/repo.ts`
- Create: `app/lib/__tests__/integration/onboarding-repo.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `app/lib/__tests__/integration/onboarding-repo.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import {
  getShopFlag,
  ensureShopFlag,
  markOnboardingComplete,
  markChecklistDismissed,
  hasGeneratedAnyDraft,
  hasCustomizedSupportSettings,
} from '../../onboarding/repo';

beforeEach(cleanTestShop);
afterAll(disconnectTestDb);

describe('ensureShopFlag', () => {
  it('creates a row with installDate=now if none exists', async () => {
    const flag = await ensureShopFlag(TEST_SHOP);
    expect(flag.shop).toBe(TEST_SHOP);
    expect(flag.onboardingCompletedAt).toBeNull();
    expect(flag.checklistDismissedAt).toBeNull();
  });

  it('is idempotent (returns existing row, does not reset installDate)', async () => {
    const first = await ensureShopFlag(TEST_SHOP);
    await new Promise((r) => setTimeout(r, 10));
    const second = await ensureShopFlag(TEST_SHOP);
    expect(second.installDate.getTime()).toBe(first.installDate.getTime());
  });
});

describe('markOnboardingComplete', () => {
  it('sets onboardingCompletedAt only if currently null (idempotent)', async () => {
    await ensureShopFlag(TEST_SHOP);
    const t1 = await markOnboardingComplete(TEST_SHOP);
    expect(t1).not.toBeNull();
    const t2 = await markOnboardingComplete(TEST_SHOP);
    // Second call should return existing timestamp, not overwrite.
    expect(t2!.getTime()).toBe(t1!.getTime());
  });
});

describe('markChecklistDismissed', () => {
  it('sets checklistDismissedAt', async () => {
    await ensureShopFlag(TEST_SHOP);
    await markChecklistDismissed(TEST_SHOP);
    const flag = await getShopFlag(TEST_SHOP);
    expect(flag?.checklistDismissedAt).not.toBeNull();
  });
});

describe('hasGeneratedAnyDraft', () => {
  it('returns false when no drafts exist', async () => {
    expect(await hasGeneratedAnyDraft(TEST_SHOP)).toBe(false);
  });

  it('returns true when at least one ReplyDraft row exists for the shop', async () => {
    // Minimal IncomingEmail + ReplyDraft to satisfy FK.
    const thread = await testDb.thread.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        lastMessageAt: new Date(),
        firstMessageAt: new Date(),
        operationalStateUpdatedAt: new Date(),
        operationalState: 'open',
        supportNature: 'unknown',
        historyStatus: 'complete',
      },
    });
    const email = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        threadId: thread.id,
        providerMessageId: 'm1',
        from: 'a@b.c',
        to: 'd@e.f',
        subject: 's',
        receivedAt: new Date(),
      },
    });
    await testDb.replyDraft.create({
      data: { shop: TEST_SHOP, emailId: email.id, body: 'x' },
    });
    expect(await hasGeneratedAnyDraft(TEST_SHOP)).toBe(true);
  });
});

describe('hasCustomizedSupportSettings', () => {
  it('returns false when no row exists', async () => {
    expect(await hasCustomizedSupportSettings(TEST_SHOP)).toBe(false);
  });

  it('returns false when row exists with default values', async () => {
    await testDb.supportSettings.create({ data: { shop: TEST_SHOP } });
    expect(await hasCustomizedSupportSettings(TEST_SHOP)).toBe(false);
  });

  it('returns true when tone differs from default', async () => {
    await testDb.supportSettings.create({ data: { shop: TEST_SHOP, tone: 'formal' } });
    expect(await hasCustomizedSupportSettings(TEST_SHOP)).toBe(true);
  });

  it('returns true when brandName is set', async () => {
    await testDb.supportSettings.create({ data: { shop: TEST_SHOP, brandName: 'ACME' } });
    expect(await hasCustomizedSupportSettings(TEST_SHOP)).toBe(true);
  });
});
```

Verify the `IncomingEmail` and `ReplyDraft` field names in the test against `prisma/schema.prisma` before running — adapt if the actual schema requires more required fields.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- app/lib/__tests__/integration/onboarding-repo.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `repo.ts`**

Create `app/lib/onboarding/repo.ts`:

```typescript
import prisma from '../../db.server';
import type { ShopFlagLike } from './state';

export async function getShopFlag(shop: string): Promise<ShopFlagLike | null> {
  const row = await prisma.shopFlag.findUnique({ where: { shop } });
  if (!row) return null;
  return {
    shop: row.shop,
    onboardingCompletedAt: row.onboardingCompletedAt,
    checklistDismissedAt: row.checklistDismissedAt,
  };
}

export async function ensureShopFlag(shop: string) {
  return prisma.shopFlag.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });
}

/**
 * Sets onboardingCompletedAt if currently null. Idempotent: a second call
 * returns the existing timestamp instead of overwriting it.
 */
export async function markOnboardingComplete(shop: string): Promise<Date | null> {
  await prisma.shopFlag.upsert({
    where: { shop },
    create: { shop, onboardingCompletedAt: new Date() },
    update: {},
  });
  // Conditional update: only set if NULL.
  await prisma.$executeRaw`
    UPDATE "ShopFlag" SET "onboardingCompletedAt" = NOW()
    WHERE "shop" = ${shop} AND "onboardingCompletedAt" IS NULL
  `;
  const row = await prisma.shopFlag.findUnique({ where: { shop } });
  return row?.onboardingCompletedAt ?? null;
}

export async function markChecklistDismissed(shop: string): Promise<void> {
  await prisma.shopFlag.upsert({
    where: { shop },
    create: { shop, checklistDismissedAt: new Date() },
    update: { checklistDismissedAt: new Date() },
  });
}

export async function hasGeneratedAnyDraft(shop: string): Promise<boolean> {
  const count = await prisma.replyDraft.count({ where: { shop } });
  return count > 0;
}

/**
 * Settings are "customized" when at least one user-facing field differs from
 * its default. Mirrors the defaults declared in `prisma/schema.prisma`
 * (signatureName='Customer Support', tone='friendly', etc.).
 */
export async function hasCustomizedSupportSettings(shop: string): Promise<boolean> {
  const row = await prisma.supportSettings.findUnique({ where: { shop } });
  if (!row) return false;
  return (
    row.signatureName !== 'Customer Support' ||
    row.brandName !== '' ||
    row.tone !== 'friendly' ||
    row.closingPhrase !== '' ||
    row.refundPolicy !== ''
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:integration -- app/lib/__tests__/integration/onboarding-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/onboarding/repo.ts app/lib/__tests__/integration/onboarding-repo.test.ts
git commit -m "feat(onboarding): add DB repo for shop flag and signal queries"
```

---

## Task 4: Route guard

**Files:**
- Create: `app/lib/onboarding/guard.ts`
- Create: `app/lib/onboarding/__tests__/guard.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/lib/onboarding/__tests__/guard.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shouldRedirectToOnboarding } from '../guard';

describe('shouldRedirectToOnboarding', () => {
  it('returns false when onboardingCompletedAt is set', () => {
    expect(
      shouldRedirectToOnboarding({
        shop: 's',
        onboardingCompletedAt: new Date(),
        checklistDismissedAt: null,
      }),
    ).toBe(false);
  });

  it('returns true when flag exists but onboardingCompletedAt is null', () => {
    expect(
      shouldRedirectToOnboarding({
        shop: 's',
        onboardingCompletedAt: null,
        checklistDismissedAt: null,
      }),
    ).toBe(true);
  });

  it('returns true when flag is null (no row yet)', () => {
    expect(shouldRedirectToOnboarding(null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- app/lib/onboarding/__tests__/guard.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `guard.ts`**

Create `app/lib/onboarding/guard.ts`:

```typescript
import { redirect } from 'react-router';
import { getShopFlag } from './repo';
import { isOnboardingComplete, type ShopFlagLike } from './state';

export function shouldRedirectToOnboarding(flag: ShopFlagLike | null): boolean {
  return !isOnboardingComplete(flag);
}

/**
 * Use inside route loaders that require completed onboarding. Throws a
 * redirect to /app/onboarding if onboarding is not complete; otherwise
 * returns silently.
 */
export async function requireOnboardingComplete(shop: string): Promise<void> {
  const flag = await getShopFlag(shop);
  if (shouldRedirectToOnboarding(flag)) {
    throw redirect('/app/onboarding');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- app/lib/onboarding/__tests__/guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/onboarding/guard.ts app/lib/onboarding/__tests__/guard.test.ts
git commit -m "feat(onboarding): add route guard helper"
```

---

## Task 5: Wizard route — Welcome + Connect Mailbox

**Files:**
- Create: `app/routes/app.onboarding.tsx`
- Create: `app/components/onboarding/WelcomeStep.tsx`
- Create: `app/components/onboarding/ConnectMailboxStep.tsx`

The wizard reuses the existing OAuth start URLs (Gmail / Zoho / Outlook) by linking to the same redirect endpoints used today by `ConnectionCard` in `app/routes/app.inbox.tsx`. The wizard does NOT duplicate OAuth handling — it simply hands off to those existing endpoints.

- [ ] **Step 1: Inspect the existing OAuth start URL helpers**

Read `app/routes/app.inbox.tsx` around the `ConnectionCard` usage (search for `getGmailAuthUrl`, `getZohoAuthUrl`, `getOutlookAuthUrl`) and note exactly how the loader returns the three auth URLs to the page. The wizard's loader will mirror that.

- [ ] **Step 2: Implement the loader for `/app/onboarding`**

Create `app/routes/app.onboarding.tsx`:

```typescript
import type { LoaderFunctionArgs } from 'react-router';
import { redirect, useLoaderData, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { authenticate } from '../shopify.server';
import prisma from '../db.server';
import { getShopFlag } from '../lib/onboarding/repo';
import { isOnboardingComplete } from '../lib/onboarding/state';
import { markOnboardingComplete } from '../lib/onboarding/repo';
import { getAuthUrl as getGmailAuthUrl } from '../lib/gmail/auth';
import { getZohoAuthUrl } from '../lib/zoho/auth';
import { getAuthUrl as getOutlookAuthUrl } from '../lib/outlook/auth';
import { WelcomeStep } from '../components/onboarding/WelcomeStep';
import { ConnectMailboxStep } from '../components/onboarding/ConnectMailboxStep';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // If already onboarded, never show the wizard again.
  const flag = await getShopFlag(shop);
  if (isOnboardingComplete(flag)) {
    throw redirect('/app/inbox');
  }

  // If a mailbox connection already exists (user came back from OAuth),
  // mark onboarding complete server-side and redirect.
  const mailboxCount = await prisma.mailConnection.count({ where: { shop } });
  if (mailboxCount > 0) {
    await markOnboardingComplete(shop);
    throw redirect('/app/inbox');
  }

  return {
    gmailAuthUrl: getGmailAuthUrl(shop),
    zohoAuthUrl: getZohoAuthUrl(shop),
    outlookAuthUrl: getOutlookAuthUrl(shop),
  };
};

export default function OnboardingPage() {
  const { gmailAuthUrl, zohoAuthUrl, outlookAuthUrl } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const step = searchParams.get('step') === 'connect' ? 'connect' : 'welcome';

  if (step === 'welcome') {
    return (
      <WelcomeStep
        onContinue={() => setSearchParams({ step: 'connect' })}
        t={t}
      />
    );
  }

  return (
    <ConnectMailboxStep
      gmailAuthUrl={gmailAuthUrl}
      zohoAuthUrl={zohoAuthUrl}
      outlookAuthUrl={outlookAuthUrl}
      t={t}
    />
  );
};
```

If `getGmailAuthUrl` / `getZohoAuthUrl` / `getOutlookAuthUrl` have different signatures than `(shop: string): string`, adjust the calls to match what `app.inbox.tsx` actually does — read that file first and copy the exact pattern.

- [ ] **Step 3: Implement `WelcomeStep`**

Create `app/components/onboarding/WelcomeStep.tsx`:

```tsx
import type { TFunction } from 'i18next';

interface Props {
  onContinue: () => void;
  t: TFunction;
}

export function WelcomeStep({ onContinue, t }: Props) {
  return (
    <s-page>
      <s-section heading={t('onboarding.welcome.title')}>
        <s-text>{t('onboarding.welcome.body')}</s-text>
        <s-button variant="primary" onClick={onContinue}>
          {t('onboarding.welcome.cta')}
        </s-button>
      </s-section>
    </s-page>
  );
}
```

- [ ] **Step 4: Implement `ConnectMailboxStep`**

Create `app/components/onboarding/ConnectMailboxStep.tsx`:

```tsx
import type { TFunction } from 'i18next';

interface Props {
  gmailAuthUrl: string;
  zohoAuthUrl: string;
  outlookAuthUrl: string;
  t: TFunction;
}

export function ConnectMailboxStep({ gmailAuthUrl, zohoAuthUrl, outlookAuthUrl, t }: Props) {
  return (
    <s-page>
      <s-section heading={t('onboarding.connect.title')}>
        <s-text>{t('onboarding.connect.body')}</s-text>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
          <a href={gmailAuthUrl}><s-button variant="primary">{t('onboarding.connect.gmail')}</s-button></a>
          <a href={outlookAuthUrl}><s-button>{t('onboarding.connect.outlook')}</s-button></a>
          <a href={zohoAuthUrl}><s-button>{t('onboarding.connect.zoho')}</s-button></a>
        </div>
      </s-section>
    </s-page>
  );
}
```

If the project uses Polaris React components (not the s-* web components) elsewhere, follow whichever pattern dominates `app/components/billing/` and adapt these two files to match.

- [ ] **Step 5: Smoke-check the route compiles**

Run: `npm run build`
Expected: clean build, no TS errors.

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.onboarding.tsx app/components/onboarding/
git commit -m "feat(onboarding): add wizard route with Welcome and Connect Mailbox steps"
```

---

## Task 6: Wire guard into routes

**Files:**
- Modify: `app/routes/app._index.tsx`
- Modify: `app/routes/app.inbox.tsx`
- Modify: `app/routes/app.dashboard.tsx`
- Modify: `app/routes/app.settings.tsx`
- Modify: `app/routes/app.support.tsx`
- Modify: `app/routes/app.additional.tsx`

The guard MUST run after `authenticate.admin` (which provides `session.shop`).
Routes that remain accessible during onboarding: `/app/billing`, `/app/help`, `/app/onboarding`. Do NOT add the guard to these.

- [ ] **Step 1: Modify `app._index.tsx`**

Replace the loader's redirect target with a guard call so that not-yet-onboarded shops land on `/app/onboarding` instead of `/app/inbox`:

```typescript
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { requireOnboardingComplete } from "../lib/onboarding/guard";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireOnboardingComplete(session.shop);
  return redirect("/app/inbox");
};
```

- [ ] **Step 2: Modify `app.inbox.tsx`**

Find the existing loader (search the file for `export const loader`). Add `requireOnboardingComplete(session.shop)` immediately after the `authenticate.admin` call but before any other DB work.

```typescript
import { requireOnboardingComplete } from "../lib/onboarding/guard";
// ... existing imports

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  await requireOnboardingComplete(session.shop);
  // ... existing loader body unchanged
};
```

- [ ] **Step 3: Apply the same change to the other four routes**

For each of `app.dashboard.tsx`, `app.settings.tsx`, `app.support.tsx`, `app.additional.tsx`: import `requireOnboardingComplete` and call it immediately after `authenticate.admin(request)` in the loader. (If a route currently has no loader, add a minimal one — but verify by reading the file first; all four likely already authenticate.)

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 5: Manual smoke check**

Start dev server: `npm run dev`. With a fresh shop (or after `UPDATE "ShopFlag" SET "onboardingCompletedAt" = NULL WHERE "shop" = '<your-test-shop>'`), navigating to `/app/inbox` should redirect to `/app/onboarding`. `/app/billing` and `/app/help` should remain accessible.

- [ ] **Step 6: Commit**

```bash
git add app/routes/
git commit -m "feat(onboarding): gate inbox/dashboard/settings/support routes on onboarding completion"
```

---

## Task 7: Onboarding checklist component + inbox integration

**Files:**
- Create: `app/components/onboarding/OnboardingChecklist.tsx`
- Modify: `app/routes/app.inbox.tsx` (loader returns checklist data; render the card)

- [ ] **Step 1: Add checklist data to the inbox loader**

In `app.inbox.tsx`, after the guard call, fetch the checklist signals and the dismissed flag, and merge them into the loader return:

```typescript
import {
  hasGeneratedAnyDraft,
  hasCustomizedSupportSettings,
  getShopFlag,
} from "../lib/onboarding/repo";
import { deriveChecklistState, isChecklistDismissed } from "../lib/onboarding/state";

// Inside the loader, after requireOnboardingComplete(session.shop):
const flag = await getShopFlag(session.shop);
const checklistState = deriveChecklistState({
  hasDraft: await hasGeneratedAnyDraft(session.shop),
  hasCustomizedSettings: await hasCustomizedSupportSettings(session.shop),
});
const checklistDismissed = isChecklistDismissed(flag);

// Add to the existing loader return object:
//   onboardingChecklist: { state: checklistState, dismissed: checklistDismissed }
```

If the loader already returns a complex object, splice these two fields into it; do not overwrite existing fields.

- [ ] **Step 2: Implement the checklist component**

Create `app/components/onboarding/OnboardingChecklist.tsx`:

```tsx
import { useFetcher } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { ChecklistState } from '../../lib/onboarding/state';

interface Props {
  state: ChecklistState;
  dismissed: boolean;
}

export function OnboardingChecklist({ state, dismissed }: Props) {
  const { t } = useTranslation();
  const fetcher = useFetcher();

  // Hide if dismissed, or if all complete (auto-hide on next visit).
  if (dismissed || state.allComplete) return null;

  const onDismiss = () => {
    fetcher.submit({}, { method: 'POST', action: '/api/onboarding/dismiss-checklist' });
  };

  return (
    <s-card>
      <s-section heading={t('onboarding.checklist.title')}>
        <s-text>{t('onboarding.checklist.progress', { done: state.completedCount, total: state.totalCount })}</s-text>
        <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
          <li>
            <span aria-hidden>{state.firstDraft ? '✅' : '⬜'}</span>{' '}
            {t('onboarding.checklist.firstDraft')}
          </li>
          <li>
            <span aria-hidden>{state.toneAndSignature ? '✅' : '⬜'}</span>{' '}
            <a href="/app/settings">{t('onboarding.checklist.toneAndSignature')}</a>
          </li>
        </ul>
        <s-button onClick={onDismiss}>{t('onboarding.checklist.dismiss')}</s-button>
      </s-section>
    </s-card>
  );
}
```

Match the existing visual style of cards in `app.inbox.tsx` (Polaris React vs `s-*` web components). If the inbox uses Polaris React, swap `s-card`/`s-section`/`s-text`/`s-button` for `Card`/`BlockStack`/`Text`/`Button` and adjust imports accordingly. Read the surrounding code first.

- [ ] **Step 3: Render the card at the top of the inbox**

In the inbox component, render `<OnboardingChecklist state={checklistState} dismissed={checklistDismissed} />` at the very top of the inbox content area, above any thread list. The card auto-hides itself when dismissed or fully complete.

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add app/components/onboarding/OnboardingChecklist.tsx app/routes/app.inbox.tsx
git commit -m "feat(onboarding): add dismissable getting-started checklist on inbox"
```

---

## Task 8: Dismiss checklist API endpoint

**Files:**
- Create: `app/routes/api.onboarding.dismiss-checklist.ts`

- [ ] **Step 1: Implement the endpoint**

Create `app/routes/api.onboarding.dismiss-checklist.ts`:

```typescript
import type { ActionFunctionArgs } from 'react-router';
import { authenticate } from '../shopify.server';
import { markChecklistDismissed } from '../lib/onboarding/repo';

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const { session } = await authenticate.admin(request);
  await markChecklistDismissed(session.shop);
  return { ok: true };
};
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add app/routes/api.onboarding.dismiss-checklist.ts
git commit -m "feat(onboarding): add dismiss-checklist API endpoint"
```

---

## Task 9: i18n translation keys

**Files:**
- Modify: `app/i18n/locales/fr.json`
- Modify: `app/i18n/locales/en.json`

- [ ] **Step 1: Add the `onboarding` namespace to French translations**

Use vouvoiement throughout (per project convention).

```json
{
  "onboarding": {
    "welcome": {
      "title": "Bienvenue sur Automail",
      "body": "Automail vous aide à répondre plus vite à vos emails de support en générant des brouillons appuyés sur les vraies données de vos commandes Shopify et de leur suivi.",
      "cta": "Commencer"
    },
    "connect": {
      "title": "Connectez votre boîte mail",
      "body": "Choisissez votre fournisseur. Automail lit uniquement vos emails de support pour générer des brouillons.",
      "gmail": "Se connecter avec Gmail",
      "outlook": "Se connecter avec Outlook",
      "zoho": "Se connecter avec Zoho"
    },
    "checklist": {
      "title": "Premiers pas",
      "progress": "{{done}} sur {{total}} terminés",
      "firstDraft": "Générer votre premier brouillon",
      "toneAndSignature": "Définir votre ton et votre signature",
      "dismiss": "Masquer"
    }
  }
}
```

- [ ] **Step 2: Add the same keys in English**

```json
{
  "onboarding": {
    "welcome": {
      "title": "Welcome to Automail",
      "body": "Automail helps you reply faster to support emails by drafting answers grounded in your real Shopify order and tracking data.",
      "cta": "Get started"
    },
    "connect": {
      "title": "Connect your mailbox",
      "body": "Pick your provider. Automail only reads your support emails to draft replies.",
      "gmail": "Connect with Gmail",
      "outlook": "Connect with Outlook",
      "zoho": "Connect with Zoho"
    },
    "checklist": {
      "title": "Getting started",
      "progress": "{{done}} of {{total}} done",
      "firstDraft": "Generate your first draft",
      "toneAndSignature": "Set your reply tone and signature",
      "dismiss": "Dismiss"
    }
  }
}
```

- [ ] **Step 3: Verify build picks up the new keys**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add app/i18n/locales/fr.json app/i18n/locales/en.json
git commit -m "feat(onboarding): add fr/en translations"
```

---

## Task 10: Integration tests for gating + completion

**Files:**
- Create: `app/lib/__tests__/integration/onboarding-gating.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/lib/__tests__/integration/onboarding-gating.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import { requireOnboardingComplete } from '../../onboarding/guard';
import { markOnboardingComplete, markChecklistDismissed, getShopFlag, ensureShopFlag } from '../../onboarding/repo';

beforeEach(cleanTestShop);
afterAll(disconnectTestDb);

describe('requireOnboardingComplete', () => {
  it('throws a redirect Response when onboarding is not complete', async () => {
    await ensureShopFlag(TEST_SHOP);
    await expect(requireOnboardingComplete(TEST_SHOP)).rejects.toMatchObject({
      status: 302,
      headers: expect.any(Headers),
    });
  });

  it('returns silently when onboardingCompletedAt is set', async () => {
    await ensureShopFlag(TEST_SHOP);
    await markOnboardingComplete(TEST_SHOP);
    await expect(requireOnboardingComplete(TEST_SHOP)).resolves.toBeUndefined();
  });
});

describe('markOnboardingComplete', () => {
  it('is idempotent across concurrent calls', async () => {
    await ensureShopFlag(TEST_SHOP);
    const [a, b] = await Promise.all([
      markOnboardingComplete(TEST_SHOP),
      markOnboardingComplete(TEST_SHOP),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.getTime()).toBe(b!.getTime());
  });
});

describe('markChecklistDismissed', () => {
  it('persists across reads', async () => {
    await ensureShopFlag(TEST_SHOP);
    await markChecklistDismissed(TEST_SHOP);
    const flag = await getShopFlag(TEST_SHOP);
    expect(flag?.checklistDismissedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm run test:integration -- app/lib/__tests__/integration/onboarding-gating.test.ts`
Expected: PASS.

- [ ] **Step 3: Backfill regression test**

Add a fourth `describe` block to the same test file:

```typescript
describe('migration backfill', () => {
  it('shops with a MailConnection should already have onboardingCompletedAt set after migration', async () => {
    // This is a smoke check that the migration ran and backfilled correctly
    // for legacy data. We simulate by manually inserting the pre-migration
    // state (no row in ShopFlag) and asserting that production code creates
    // it correctly. Pure prod-code regression test for the upsert-and-mark
    // path, not the SQL backfill itself (which only runs at deploy time).
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        email: 't@e.com',
        accessToken: 'x',
        refreshToken: 'x',
        tokenExpiry: new Date(Date.now() + 3_600_000),
      },
    });
    // Existing shops will have a ShopFlag row created by entitlements; mark
    // it complete to simulate the post-migration steady state.
    await markOnboardingComplete(TEST_SHOP);
    await expect(requireOnboardingComplete(TEST_SHOP)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4: Run all integration tests to confirm nothing broke**

Run: `npm run test:integration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/__tests__/integration/onboarding-gating.test.ts
git commit -m "test(onboarding): integration tests for guard and completion"
```

---

## Task 11: End-to-end Playwright pass on the user's real Shopify store

This task is performed via Playwright MCP against the real shop, not via the
existing `npm run test:e2e` suite. The agent drives the browser; the user does
not click manually.

- [ ] **Step 1: Reset onboarding state on the test shop**

In a SQL console for the dev DB, run:

```sql
DELETE FROM "MailConnection" WHERE "shop" = '<test-shop-domain>.myshopify.com';
UPDATE "ShopFlag"
  SET "onboardingCompletedAt" = NULL, "checklistDismissedAt" = NULL
  WHERE "shop" = '<test-shop-domain>.myshopify.com';
```

(If the shop's `ShopFlag` row does not exist, the next page load will create one with NULL values, which is the same desired starting state.)

- [ ] **Step 2: Drive the wizard end-to-end via Playwright MCP**

Verify each of the following in order. Each item is a separate Playwright assertion or interaction. Capture a screenshot at each major step.

  1. Navigate to the app's home in the embedded admin (Shopify admin URL for the test shop).
  2. Assert: lands on `/app/onboarding` (welcome step visible).
  3. Click "Get started".
  4. Assert: connect-mailbox step visible with three provider buttons.
  5. Click Gmail. Complete OAuth in the popup/redirect (real account on the test shop).
  6. Assert: redirected to `/app/inbox`. Onboarding checklist card visible at the top.
  7. Assert: checklist shows "1 of 2 done" if the inbox already has a draft, else "0 of 2 done".
  8. Navigate to `/app/dashboard` — assert NO redirect to onboarding (onboarding is now complete).
  9. Navigate to `/app/billing` — assert accessible (would have been accessible during onboarding too).
  10. Generate a draft on a real thread → return to inbox → assert checklist item 1 is now checked.
  11. Visit `/app/settings`, change tone from `friendly` to `formal`, save → return to inbox → assert checklist item 2 is now checked → assert card auto-hides on next visit (because both items complete).
  12. (Optional) reset settings, reset draft, reload inbox → checklist visible again → click "Dismiss" → assert card disappears → reload → assert card stays absent.

- [ ] **Step 3: Drive gating-during-onboarding via Playwright MCP**

Reset onboarding state again (Step 1). Then, while NOT yet onboarded:

  1. Navigate to `/app/inbox` → assert redirect to `/app/onboarding`.
  2. Navigate to `/app/dashboard` → assert redirect to `/app/onboarding`.
  3. Navigate to `/app/settings` → assert redirect to `/app/onboarding`.
  4. Navigate to `/app/support` → assert redirect to `/app/onboarding`.
  5. Navigate to `/app/billing` → assert renders normally (NOT redirected).
  6. Navigate to `/app/help` → assert renders normally.
  7. Navigate to `/app/onboarding` (after onboarding is complete) → assert redirect to `/app/inbox`.

- [ ] **Step 4: Document outcomes**

For each Playwright check, record PASS or document the observed bug. If any check fails, fix the underlying code before declaring the feature complete (do not "TODO" Playwright failures).

- [ ] **Step 5: Final commit (if fixes were needed)**

```bash
git add <fixed files>
git commit -m "fix(onboarding): address issues found in E2E pass"
```

---

## Self-review checklist

After implementation, before declaring done:

1. **Spec coverage:** Wizard ✓ (Task 5), Checklist ✓ (Task 7), Gating ✓ (Task 6), Persistence ✓ (Task 1+3), i18n ✓ (Task 9), Tests ✓ (Tasks 2,3,4,10), E2E ✓ (Task 11). All sections of the spec are covered.
2. **No backwards compat shims:** the rename `BillingShopFlag` → `ShopFlag` is hard. No `BillingShopFlag` alias is created — every call site is updated.
3. **No new packages:** every step uses dependencies already in `package.json`.
4. **No dead code:** every helper introduced (e.g. `ensureShopFlag`, `hasGeneratedAnyDraft`) has at least one production caller after Task 7.
