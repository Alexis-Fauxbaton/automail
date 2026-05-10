# Onboarding for new merchants — Design

Date: 2026-05-09
Status: Draft (awaiting user review)

## Context

The app currently has no real onboarding flow. After install, Shopify lands the
merchant on `/app` which redirects to `/app/inbox`. If no mailbox is connected,
`/app/inbox` renders a `ConnectionCard` in place of the inbox content. This is
*de facto* a one-step gate, but it is implicit and offers no welcome, no product
explanation, and no progression beyond mailbox connection.

We are moving toward public Shopify App Store distribution. A proper onboarding
is needed to address four overlapping problems:

1. **Activation** — too many installs likely never reach a first generated draft.
2. **Product comprehension** — new users don't know what the app does or how to use it.
3. **Configuration completeness** — mail, reply tone, and signature need to be set.
4. **App Store readiness** — a clean first-run experience is expected by reviewers.

## Goal

Guide a freshly-installed merchant from "just clicked Install" to "generated my
first useful draft on a real email" with the smallest amount of friction
compatible with the app actually being able to function.

## Non-goals

- No marketing/upsell content during onboarding (no "Choose a plan" step).
  Every install gets an automatic 14-day trial with pro-level features. Plan
  selection is driven separately by the existing trial banner and end-of-trial
  paywall — not by onboarding.
- No spotlight/tour overlays. Polaris doesn't provide them natively and the
  ROI doesn't justify the UI work for MVP.
- No video, no in-app tutorials, no analytics dashboards.
- No optional skip on the mailbox connection step. Without a mailbox, the app
  has nothing to operate on.

## Shape

A hybrid: **blocking wizard for the critical step, persistent checklist for the rest.**

### Blocking wizard — `/app/onboarding`

Two screens, presented in order:

1. **Welcome** — a sober, text-only screen. One short paragraph explaining what
   the app does ("Generate cautious, fact-grounded draft replies to your support
   emails using your real Shopify order and tracking data") and a single
   "Get started" CTA.
2. **Connect mailbox** — Gmail / Zoho / Outlook tiles, each launching the
   existing OAuth flow. Reuses the existing `ConnectionCard` component logic.
   Step is complete when a `MailConnection` row exists for the shop.

Once both steps are complete, `onboardingCompletedAt` is set on the shop's
`ShopFlag` row and the user is redirected to `/app/inbox`.

### Persistent checklist — top of `/app/inbox`

A dismissable Polaris card titled "Getting started" with two items:

3. **Generate your first draft** — checked when the shop has at least one
   `Draft` row (or equivalent existing analysis-result table). Auto-derived,
   no explicit user action required beyond actually generating a draft.
4. **Set your reply tone & signature** — links to `/app/settings`. Auto-derived
   from settings being non-default (tone preference set or signature non-empty).

The card displays progress (e.g. "1 of 2 done") and a "Dismiss" button. Once
dismissed (`checklistDismissedAt` set), it never reappears, regardless of
completion state.

The card also auto-hides when both items are complete *and* the user navigates
away and back (i.e. it disappears on the next inbox visit after completion,
without requiring an explicit dismiss).

## Routing & gating

A new server-side helper `requireOnboardingComplete(request)` runs in route
loaders. It returns one of:

- `complete` — pass through.
- `redirect` — caller should `throw redirect("/app/onboarding")`.

Gating rules:

| Route               | Behavior when `onboardingCompletedAt IS NULL` |
| ------------------- | --------------------------------------------- |
| `/app`              | redirects to `/app/onboarding`                |
| `/app/onboarding`   | renders the wizard                            |
| `/app/billing`      | accessible — merchants may want to read about plans before connecting |
| `/app/help`         | accessible — merchants may want to read docs first |
| `/app/inbox`        | redirects to `/app/onboarding`                |
| `/app/dashboard`    | redirects to `/app/onboarding`                |
| `/app/settings`     | redirects to `/app/onboarding`                |
| `/app/support`      | redirects to `/app/onboarding`                |
| `/app/additional`   | redirects to `/app/onboarding`                |

When `onboardingCompletedAt IS NOT NULL`, `/app/onboarding` redirects to
`/app/inbox` (no way to re-enter the wizard).

## Persistence

Rename existing model `BillingShopFlag` → `ShopFlag`. Two new columns:

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

Migration:

1. `ALTER TABLE "BillingShopFlag" RENAME TO "ShopFlag"` (Postgres) — equivalent
   on the actual provider.
2. Add the two nullable columns.
3. Update all import sites: `import { BillingShopFlag } from ...` and
   `prisma.billingShopFlag.*` calls become `ShopFlag` / `prisma.shopFlag.*`.

Backfill: in the same migration, set
`onboardingCompletedAt = installDate` for every shop that already has a
`MailConnection` row. Reasoning: re-prompting already-onboarded shops with a
"Welcome — connect your mailbox" wizard would be jarring and offers them no
value. The migration runs once at deploy, before any user request hits the
new gating logic.

## Module layout

New files:

- `app/lib/onboarding/state.ts` — pure functions: `isOnboardingComplete(flag)`,
  `isChecklistDismissed(flag)`, derive `ChecklistState` from shop signals.
- `app/lib/onboarding/repo.ts` — DB I/O: `getShopFlag`, `markOnboardingComplete`,
  `markChecklistDismissed`.
- `app/lib/onboarding/guard.ts` — `requireOnboardingComplete(request)` for
  loaders.
- `app/routes/app.onboarding.tsx` — the wizard route (welcome + connect screens
  with internal step state via search params or in-component state).
- `app/routes/api.onboarding.dismiss-checklist.ts` — POST endpoint to set
  `checklistDismissedAt`. (Onboarding completion itself is set server-side
  inside the wizard route's loader — no separate API endpoint needed.)
- `app/components/onboarding/WelcomeStep.tsx`
- `app/components/onboarding/ConnectMailboxStep.tsx` — wraps existing
  `ConnectionCard` with wizard chrome.
- `app/components/onboarding/OnboardingChecklist.tsx` — the inbox card.

Modified files:

- `app/routes/app._index.tsx` — call `requireOnboardingComplete` before redirect.
- `app/routes/app.inbox.tsx` — call guard, render `OnboardingChecklist` at top
  when not dismissed.
- `app/routes/app.dashboard.tsx`, `app.settings.tsx`, `app.support.tsx`,
  `app.additional.tsx` — call guard.
- `prisma/schema.prisma` + new migration.
- All existing call sites of `BillingShopFlag` / `prisma.billingShopFlag.*`.

## Data flow

### First install
1. Shopify install completes → `/app` loader runs.
2. Guard sees `onboardingCompletedAt IS NULL` → redirects to `/app/onboarding`.
3. User reads Welcome → clicks "Get started" → step 2.
4. User picks Gmail/Zoho/Outlook → existing OAuth flow runs.
5. OAuth callback creates `MailConnection`, returns to `/app/onboarding`.
6. On mount, the wizard loader checks: if `MailConnection` exists for this shop
   AND `onboardingCompletedAt IS NULL`, the loader itself sets
   `onboardingCompletedAt` and throws a redirect to `/app/inbox`. (Server-side,
   no client POST needed — avoids a flicker and a race between two tabs.)
7. `/app/inbox` renders normally + shows checklist card with steps 3 & 4.

### Returning before onboarding completion
- User closed the tab during step 2 → next visit lands on `/app/onboarding`,
  resumes at step 2 (Welcome auto-skipped if user already advanced past it —
  step state derived from "do they have a `MailConnection`?" alone is sufficient
  for resume; explicit step-progress storage is overkill).

### Checklist completion / dismiss
- User generates a draft → next inbox load shows item 3 checked.
- User customizes settings → next inbox load shows item 4 checked.
- User clicks "Dismiss" → POST to `/api/onboarding/dismiss-checklist` →
  next render hides the card.
- Both items checked + user navigates away + comes back → card auto-hidden.

## Error handling

- **Mailbox OAuth failure** → existing `ConnectionCard` error UI is reused;
  the wizard stays on step 2 with the error rendered inline.
- **Two concurrent tabs finishing onboarding at the same time** → the wizard
  loader's "set `onboardingCompletedAt` if NULL then redirect" is idempotent
  via a conditional update; the second tab simply sees it already set.
- **Checklist completion data unavailable** (e.g. drafts query fails) → render
  the item as unchecked rather than blocking the page; log the error.

## Internationalization

All new copy goes through `useTranslation`. New translation keys under
`onboarding.*` namespace. French uses vouvoiement throughout, per project
convention.

## Testing

- Unit tests for `app/lib/onboarding/state.ts` (pure derivation logic).
- Unit tests for the guard's redirect decision matrix.
- Integration test: install → land on `/app/onboarding` → mock OAuth success →
  verify redirect to `/app/inbox` and `onboardingCompletedAt` set.
- Integration test: visit `/app/inbox` with mailbox connected but onboarding
  not marked complete → verify redirect to `/app/onboarding`.
- Integration test: dismiss checklist → reload inbox → card absent.
- **End-to-end via Playwright MCP on the user's real Shopify store**, covering
  the full feature surface: fresh-install path lands on `/app/onboarding`;
  Welcome → Connect mailbox; mailbox OAuth completion redirects to
  `/app/inbox`; gating redirects work for `/app/dashboard`, `/app/settings`,
  `/app/support`, `/app/additional`; `/app/billing` and `/app/help` remain
  accessible during onboarding; checklist appears on inbox post-install;
  generating a draft checks item 3; setting tone/signature checks item 4;
  Dismiss hides the card permanently; returning to `/app/onboarding` after
  completion redirects to `/app/inbox`.

## Open questions for implementation phase

- Welcome screen final copy (1-2 sentences). Drafted in implementation, not
  in this spec.
