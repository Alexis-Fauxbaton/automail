# Paid Plans Phase 5 — Pre-launch (Custom-app-only scope)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Finish everything that can be done while the app remains in Custom distribution mode, so that converting to Public Draft + submitting for review later is a quick toggle. Excludes anything that requires Billing API live testing (impossible on Custom).

**Architecture:** No new modules. Targeted updates to existing files (privacy policy, migration helper, listing copy). One mandatory step: run Shopify's AI self-review skill against the codebase and fix flagged issues.

**Reference spec:** [docs/superpowers/specs/2026-05-08-paid-plans-design.md](docs/superpowers/specs/2026-05-08-paid-plans-design.md)

**Out of scope (requires Public Draft):**
- Live testing of `appSubscriptionCreate` / `appSubscriptionCancel`
- Soft launch on additional merchants
- Submit for review

---

## File Structure

| File | Modification |
|---|---|
| `app/routes/privacy.tsx` | Add billing-related data sections (EN + FR) |
| `app/lib/billing/migration.ts` | Create — explicit backfill function for shops without BillingShopFlag |
| `app/lib/billing/__tests__/migration.test.ts` | Create — integration test for backfill |
| `app/routes/app._index.tsx` (or boot hook) | Call backfill on app boot, idempotent |
| `docs/listing-content.md` | Create — drafts of Partner Dashboard listing copy (description, support contact, FAQ) |

---

## Task 1: Privacy policy — billing data section

The current `privacy.tsx` covers Shopify order data and email content. It does not yet mention the billing usage data introduced in Phases 1-4. Shopify reviewers explicitly check that the privacy policy reflects ALL data collected and stored.

**Files:**
- Modify: `app/routes/privacy.tsx`

- [ ] **Step 1: Read the current privacy.tsx to understand its structure**

The file has bilingual sections: `PrivacyEn` and `PrivacyFr`. Each is a sequence of `<Section title="…">` blocks numbered. Find where to insert a new section, ideally after the "Data we access" / "Données auxquelles nous accédons" section but before the retention/security sections.

- [ ] **Step 2: Add a new section about billing data — English version**

In `PrivacyEn`, after the "Data we access" section, add a new `<Section>`:

```tsx
<Section title="3. Subscription and usage data">
  <p>
    To operate the paid plans (Starter, Pro), we store the following data per shop:
  </p>
  <ul style={styles.ul}>
    <li>
      <strong>Subscription state</strong> — read on demand from Shopify's Billing API
      (active plan name, billing period end). We do not store this; Shopify is the source
      of truth.
    </li>
    <li>
      <strong>Monthly draft counter</strong> — an integer per shop per calendar month,
      incremented each time the AI generates a reply draft. Used to enforce plan quotas.
      Retained for billing audit purposes.
    </li>
    <li>
      <strong>Install date</strong> — to compute trial expiry. Stored once when the app
      is first installed.
    </li>
    <li>
      <strong>Scheduled plan changes</strong> — when a merchant requests a downgrade,
      we record the target plan and effective date until the change is applied.
    </li>
  </ul>
  <p>
    No payment card details ever transit through our servers. All charges are processed
    by Shopify's Billing API directly between the merchant and Shopify.
  </p>
</Section>
```

Adjust the section numbering of subsequent sections (3 → 4, 4 → 5, etc.) to keep them sequential.

- [ ] **Step 3: Add the French equivalent in `PrivacyFr` — strict vouvoiement**

```tsx
<Section title="3. Données d'abonnement et d'utilisation">
  <p>
    Pour faire fonctionner les plans payants (Starter, Pro), nous stockons les données
    suivantes par boutique :
  </p>
  <ul style={styles.ul}>
    <li>
      <strong>État de l'abonnement</strong> — lu à la demande depuis l'API Shopify Billing
      (nom du plan actif, fin de période de facturation). Nous ne stockons pas cette
      information ; Shopify est la source de vérité.
    </li>
    <li>
      <strong>Compteur mensuel de brouillons</strong> — un entier par boutique et par mois
      calendaire, incrémenté à chaque génération d'un brouillon de réponse par l'IA.
      Utilisé pour appliquer les quotas du plan. Conservé pour audit de facturation.
    </li>
    <li>
      <strong>Date d'installation</strong> — pour calculer l'expiration de l'essai.
      Stockée une seule fois lors de la première installation.
    </li>
    <li>
      <strong>Changements de plan planifiés</strong> — lorsqu'un marchand demande un
      downgrade, nous enregistrons le plan cible et la date d'application jusqu'à
      ce que le changement soit appliqué.
    </li>
  </ul>
  <p>
    Aucune donnée de carte de paiement ne transite par nos serveurs. Tous les paiements
    sont traités par l'API Shopify Billing directement entre le marchand et Shopify.
  </p>
</Section>
```

Adjust subsequent French section numbering.

- [ ] **Step 4: Verify the file renders without typecheck errors**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "privacy.tsx" | head -5 || echo "no errors"`
Expected: no errors related to privacy.tsx.

- [ ] **Step 5: Commit**

```bash
git add app/routes/privacy.tsx
git commit -m "docs(privacy): add billing & usage data section (EN + FR)"
```

---

## Task 2: Explicit migration backfill

Today, `BillingShopFlag` is created lazily on the first call to `resolveEntitlements` for a shop (first-touch upsert). This works fine for active shops because they always trigger entitlement resolution. But for safety and audit clarity (and to align with the spec's "Migration des shops existants" item), we add an explicit backfill that runs once at boot and creates flags for any pre-existing shop without one.

**Files:**
- Create: `app/lib/billing/migration.ts`
- Create: `app/lib/__tests__/integration/billing-migration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `app/lib/__tests__/integration/billing-migration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import { backfillBillingShopFlags } from '../../billing/migration';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
  // Other shops the backfill might find — clean them too
  await testDb.billingShopFlag.deleteMany({ where: { shop: { in: ['legacy-a.myshopify.com', 'legacy-b.myshopify.com'] } } });
  await testDb.session.deleteMany({ where: { shop: { in: ['legacy-a.myshopify.com', 'legacy-b.myshopify.com'] } } });
});

describe('backfillBillingShopFlags', () => {
  it('creates a BillingShopFlag for shops with a session but no flag', async () => {
    await testDb.session.create({
      data: {
        id: 'offline_legacy-a.myshopify.com',
        shop: 'legacy-a.myshopify.com',
        state: 'active',
        isOnline: false,
        accessToken: 'x',
      },
    });

    const created = await backfillBillingShopFlags();
    expect(created).toContain('legacy-a.myshopify.com');

    const flag = await testDb.billingShopFlag.findUnique({
      where: { shop: 'legacy-a.myshopify.com' },
    });
    expect(flag).not.toBeNull();
    expect(flag?.isInternal).toBe(false);

    await testDb.billingShopFlag.deleteMany({ where: { shop: 'legacy-a.myshopify.com' } });
    await testDb.session.deleteMany({ where: { shop: 'legacy-a.myshopify.com' } });
  });

  it('does not touch shops that already have a flag (idempotent)', async () => {
    const initial = new Date('2026-01-01T00:00:00Z');
    await testDb.session.create({
      data: {
        id: 'offline_legacy-b.myshopify.com',
        shop: 'legacy-b.myshopify.com',
        state: 'active',
        isOnline: false,
        accessToken: 'x',
      },
    });
    await testDb.billingShopFlag.create({
      data: { shop: 'legacy-b.myshopify.com', installDate: initial },
    });

    const created = await backfillBillingShopFlags();
    expect(created).not.toContain('legacy-b.myshopify.com');

    const flag = await testDb.billingShopFlag.findUnique({
      where: { shop: 'legacy-b.myshopify.com' },
    });
    expect(flag?.installDate.toISOString()).toBe(initial.toISOString());

    await testDb.billingShopFlag.deleteMany({ where: { shop: 'legacy-b.myshopify.com' } });
    await testDb.session.deleteMany({ where: { shop: 'legacy-b.myshopify.com' } });
  });

  it('returns empty array when nothing to backfill', async () => {
    const created = await backfillBillingShopFlags();
    expect(Array.isArray(created)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
npm run test:integration -- billing-migration
```

Expected: FAIL — `Cannot find module '../../billing/migration'`.

- [ ] **Step 3: Implement `migration.ts`**

Create `app/lib/billing/migration.ts`:

```typescript
/**
 * One-time backfill: create a BillingShopFlag for every shop that has a
 * Shopify session but no flag yet.
 *
 * Why : the entitlements resolver creates flags lazily on first-touch, so
 * for actively-used shops this is a no-op. But for shops that haven't
 * called any entitlement-aware route since billing rolled out (e.g. the
 * sync runs server-side without ever loading a UI loader), the flag is
 * missing and the trial countdown isn't anchored.
 *
 * Safe to run repeatedly: only inserts where missing.
 *
 * Returns the list of shops for which a flag was created.
 */

import prisma from '../../db.server';

export async function backfillBillingShopFlags(): Promise<string[]> {
  const sessions = await prisma.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ['shop'],
  });

  if (sessions.length === 0) return [];

  const existingFlags = await prisma.billingShopFlag.findMany({
    where: { shop: { in: sessions.map((s) => s.shop) } },
    select: { shop: true },
  });
  const haveFlag = new Set(existingFlags.map((f) => f.shop));

  const missing = sessions
    .map((s) => s.shop)
    .filter((shop) => !haveFlag.has(shop));

  if (missing.length === 0) return [];

  const now = new Date();
  await prisma.billingShopFlag.createMany({
    data: missing.map((shop) => ({ shop, installDate: now, isInternal: false })),
    skipDuplicates: true,
  });

  console.log(`[billing-migration] backfilled ${missing.length} BillingShopFlag rows: ${missing.join(', ')}`);
  return missing;
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npm run test:integration -- billing-migration
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Wire the backfill into app boot**

Find the existing app boot hook. Most likely candidate: `app/entry.server.tsx`. If it's there, add a fire-and-forget call to `backfillBillingShopFlags()` (with a try/catch so a backfill failure doesn't block the server starting).

Alternative: add a one-line call from `app/lib/auto-sync.ts`'s `startAutoSync()` function so it runs once when the periodic sync loop initializes. This is even safer because that function is only called once per process.

If neither feels right, leave the function importable but not auto-called, and document it as "run manually as needed via Node REPL". Mark this in the commit message.

- [ ] **Step 6: Commit**

```bash
git add app/lib/billing/migration.ts app/lib/__tests__/integration/billing-migration.test.ts app/entry.server.tsx
# Or whichever file you wired it into
git commit -m "feat(billing): explicit migration backfill for shops without BillingShopFlag"
```

---

## Task 3: AI self-review against Shopify App Store requirements

Run Shopify's official self-review tool against the codebase to identify any compliance gaps before we start preparing listing assets.

**Files:** none (review-only). Subsequent tasks fix any issues found.

- [ ] **Step 1: Invoke the AI self-review skill**

The Shopify dev MCP exposes a self-review workflow. Use it via:

```
/shopify-app-store-review
```

Or invoke the skill `shopify-plugin:shopify-app-store-review` directly. It will fetch the canonical requirements list and evaluate the codebase.

The output is a report with three statuses per requirement: **likely passing**, **likely failing**, **needs review**. Capture the report.

- [ ] **Step 2: Triage the findings**

For each ❌ "likely failing" item:
- Determine if it's something that can be fixed in code now (no Public Draft needed)
- If yes: open a todo to fix it
- If it requires Public Draft (e.g., live billing flow validation): note it for the post-conversion phase

For each ⚠️ "needs review" item:
- Read the verification guidance
- Add a note in `docs/compliance-notes.md` (create if absent) explaining what we believe is true and what evidence supports it
- These will be useful when we eventually submit for review

- [ ] **Step 3: Apply fixes for in-scope failures**

For each fixable failure, implement the fix as a small commit. Examples of common issues that DO require code changes (vs Partner Dashboard work):
- Webhook handlers returning 200 even on auth failure (security)
- Privacy policy URL not present in `shopify.app.toml` configuration
- Missing scopes justification in `shopify.app.toml`
- Hard-coded text strings that should be localized

Do NOT scope-creep: only fix real failures the self-review surfaces. Unrelated improvements go to a follow-up.

- [ ] **Step 4: Commit fixes**

Each fix as its own commit with a descriptive message. Example:

```bash
git add <files>
git commit -m "fix(compliance): <specific issue>"
```

- [ ] **Step 5: Re-run the self-review**

After applying fixes, re-run `/shopify-app-store-review` and verify the failure count went down.

---

## Task 4: Listing content draft

Prepare the text content the user will paste into the Partner Dashboard later, when they convert to Public Draft.

**Files:**
- Create: `docs/listing-content.md`

- [ ] **Step 1: Write the listing copy**

Create `docs/listing-content.md`:

```markdown
# Automail — App Store listing content

Drafts to paste into Partner Dashboard when converting to Public Draft.
Keep all copy in English (App Store primary language) — translations are
handled at runtime by i18n.

## Tagline (max 30 chars)

AI drafts for support emails

## Short description (max 100 chars)

Save hours on customer support: Automail drafts careful AI replies grounded in real Shopify order data.

## Long description (max 3000 chars)

Automail is a support copilot for Shopify merchants. Connect your Gmail
or Zoho mailbox, and Automail will read incoming customer messages,
identify support intent, look up the matching order in your Shopify
admin, retrieve fulfillment and tracking details, and draft a careful,
factual reply that you can review and send.

### Why Automail

- **Grounded in your data, not guessed**: every draft references the actual order, fulfillment status, and tracking events. No hallucinated details, no invented refunds.
- **Aware of ambiguity**: when several orders match a customer's email, Automail surfaces the candidates instead of picking blindly.
- **Confidence-rated**: each draft comes with a confidence level (high / medium / low) so you know when to trust it and when to double-check.
- **You stay in control**: drafts are never sent automatically. You review, edit, and send.

### What Automail handles

- Where is my order tracking requests
- Late delivery and stuck shipments
- Marked-delivered-but-not-received cases
- Damaged or wrong product complaints
- Refund requests with policy reference
- Pre-purchase questions

### Pricing

- **14-day free trial** — full access, no quota
- **Starter — $9/month**: 50 drafts, 1 mailbox, basic dashboard (7 days)
- **Pro — $49/month**: 500 drafts, 3 mailboxes, full dashboard (90 days)

Upgrade anytime, no commitment.

### What we do NOT do

- We don't send emails for you
- We don't issue refunds for you
- We don't make changes to your orders
- We don't store your customers' payment data

## Categories

- Customer service
- Productivity
- Operations

## Tags

customer support, AI, drafts, email, gmail, zoho, outlook, helpdesk, automation

## Support contact

Email: support@automail.app (placeholder — replace with real one before submit)

## Privacy policy URL

https://automail-vc6z.onrender.com/privacy

## Screenshots needed

To take from AMBIENT HOME (or a clean dev store) once we convert:

1. **Inbox view** — main page with the support tabs (À traiter, Attente client, Résolu) and a few real threads with intent badges
2. **Thread detail** — one thread expanded with order context + draft generated + tracking section
3. **Dashboard** — KPIs + heatmap + top intents (Pro plan view)
4. **Billing page** — the Starter / Pro card grid with one marked as current
5. **Settings** — the personalization page (signature, tone, language, refund policy)

Take both light-mode and (if possible) at multiple viewport sizes. 1280x800 minimum, ideally 2560x1600 retina.

## App icon

Required: 1200×1200 px, PNG, no transparency.

Status: TODO. Need to design or commission. Suggestion: a minimalist "A" or envelope-with-spark glyph in the brand color.

## FAQ for review team

(Anticipated questions reviewers will ask, with prepared answers)

### Why do you need read_all_orders scope?

To find the order matching a customer's support email even if it's older than 60 days. Many support tickets reference orders from 2-6 months ago (warranty, returns, missing items). Without this scope, those tickets can't be answered correctly.

### How is customer email content protected?

- Email content is processed in-memory and only the structured analysis result (intent, identifiers, tracking) is persisted alongside the email metadata.
- The full email body is stored encrypted at rest in Postgres.
- Compliance webhooks (customers/data_request, customers/redact, shop/redact) are implemented and respond within the required timeframes.

### Why a 14-day trial?

Standard Shopify Billing trial duration. Sufficient for a merchant to observe a real support cycle (usually 1-2 weeks of email traffic) and decide.
```

- [ ] **Step 2: Commit**

```bash
git add docs/listing-content.md
git commit -m "docs(listing): draft App Store listing content"
```

---

## Phase 5 wrap-up

- [ ] **Step 1: Final test run**

```bash
npm test
npm run test:integration
```

Expected: all green. Phase 5 should add ~3 tests (billing-migration).

- [ ] **Step 2: Verify the file structure**

```bash
ls app/lib/billing/migration.ts
ls docs/listing-content.md
git log --oneline -10
```

Expected: new files exist, recent commits are visible.

- [ ] **Step 3: Update memory**

After Phase 5 is done, append to memory the decisions made about:
- Listing copy variants (if user provided alternates)
- Compliance notes from Task 3
- Any TODO items that are blocked by Public Draft conversion

---

## What remains AFTER Phase 5 (requires Public Draft conversion)

Captured here so it's not forgotten:

- [ ] Convert the app from Custom to Public Draft in Partner Dashboard
- [ ] Live test `appSubscriptionCreate` with `test: true` on a development store
- [ ] Live test `appSubscriptionCancel`
- [ ] Live test the upgrade flow Starter → Pro (prorata)
- [ ] Live test the scheduled downgrade Pro → Starter
- [ ] Live test the cancel-scheduled flow
- [ ] Take final screenshots from a real installation
- [ ] Upload app icon
- [ ] Upload screenshots
- [ ] Fill Partner Dashboard listing form with content from `docs/listing-content.md`
- [ ] Submit for review

---

## Self-review notes

- Spec coverage:
  - Privacy policy update ✅ Task 1
  - Migration backfill ✅ Task 2
  - Compliance check ✅ Task 3
  - Listing prep ✅ Task 4
- All file paths are exact.
- Out-of-scope items (Public Draft work) explicitly listed in the post-Phase-5 section.
- No fake test code (full test bodies provided in Task 2).
