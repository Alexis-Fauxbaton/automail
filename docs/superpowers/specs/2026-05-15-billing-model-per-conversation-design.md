# Billing model — per analyzed support conversation

**Date:** 2026-05-15
**Status:** Approved by user, ready for implementation plan

## Problem

Two related issues with the current billing model:

1. **Per-AI-draft billing creates incentive misalignment.** Each click on
   "Generate draft", "Regenerate draft" or "Refine with AI" consumes one
   quota unit. Users learn to avoid the AI features to preserve quota,
   defeating the product's value proposition. Power users who refine 3-5
   times per draft burn through Starter's 50/month cap in ~10
   conversations.

2. **Manual drafting is impossible without bypass concerns.** The
   merchant can't write a reply by hand without first triggering AI
   generation (otherwise the `DraftBlock` UI doesn't render). Adding
   manual drafting today would let users skip billing entirely.

The unifying issue: **we bill the wrong event**. The expensive work is
the Tier 3 analysis (Shopify order search + 17track + LLM intent
parser + LLM draft generation), which runs once per thread at sync
time. Refines and regenerations are cheap LLM-only operations. Billing
each operation creates friction without protecting margin.

## Goal

Switch the metered unit from "AI draft generated" to "support
**conversation** analyzed". One conversation = one thread where Tier 3
completed at least once. Refines, regenerations, manual drafting, and
all subsequent operations are free within that conversation.

Side benefits:
- Manual drafting becomes trivial to add later (no billing impact).
- Pricing language aligns with how merchants think (Zendesk / Front
  conventions: "conversations" not "drafts").
- Margin protection improves because the quota fires at the
  upstream-cost event, not at the user-facing event.

## Non-goals

- Changing plan prices ($9 Starter / $49 Pro stay).
- Changing mailbox limits (1 / 3 stay).
- Changing trial duration (14 days stay).
- Adding seat-based pricing or usage overage (deferred — could be
  layered later if the per-conversation model proves limiting).
- Implementing manual drafting in this spec (separate spec, will land
  after this).

## Design

### Schema changes

Two changes to `prisma/schema.prisma`:

1. **`Thread.analyzedAt: DateTime?`** — set to `now()` when Tier 3
   completes successfully for the first time on this thread. Indexed
   for the migration backfill and for the per-period aggregation
   query.

2. **`BillingUsage.draftsCount: Int @default(0)`** is renamed to
   **`analyzedThreadsCount: Int @default(0)`**. Semantics shift from
   "AI drafts generated this period" to "support conversations Tier-3
   analyzed for the first time this period". The unique constraint
   `(shop, periodStart)` stays.

Migration order:
1. Add `Thread.analyzedAt` (nullable, no default).
2. Backfill: `UPDATE "Thread" SET "analyzedAt" = "createdAt" WHERE
   EXISTS (SELECT 1 FROM "IncomingEmail" WHERE
   "IncomingEmail"."canonicalThreadId" = "Thread"."id" AND
   "IncomingEmail"."analysisResult" IS NOT NULL)`. This treats every
   existing thread that already has an analyzed email as "already paid
   for" — no retroactive consumption.
3. Rename `BillingUsage.draftsCount` → `analyzedThreadsCount`. Prisma
   migration uses `ALTER TABLE ... RENAME COLUMN`. Data is preserved
   but semantically reset to zero in the next step.
4. Reset existing `BillingUsage` rows for the current period:
   `UPDATE "BillingUsage" SET "analyzedThreadsCount" = 0 WHERE
   "periodStart" >= date_trunc('month', NOW())`. Old periods stay
   as historical record (they won't ever be queried for entitlement
   checks).

Migration is wrapped in a single Prisma migration file so it's atomic.

### Plan definitions

`app/lib/billing/plans.ts` — rename field, keep numbers:

```ts
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
  trial:   { ..., analyzedThreadsPerMonth: Infinity, ... },
  starter: { ..., analyzedThreadsPerMonth: 50,       ... },
  pro:     { ..., analyzedThreadsPerMonth: 500,      ... },
};
```

### Counter increment site

The single place where `analyzedThreadsCount` is incremented is at the
**end of a successful Tier 3 pipeline**, gated by an "is this the
first analysis for this thread?" check.

Concretely: a new helper `markThreadAnalyzedIfFirst(threadId, shop)`
in `app/lib/billing/usage.ts`:

```ts
export async function markThreadAnalyzedIfFirst(
  threadId: string,
  shop: string,
): Promise<{ counted: boolean; alreadyAnalyzed: boolean }> {
  // Atomic-ish: only update if analyzedAt is still null.
  const result = await prisma.thread.updateMany({
    where: { id: threadId, shop, analyzedAt: null },
    data: { analyzedAt: new Date() },
  });
  if (result.count === 0) {
    return { counted: false, alreadyAnalyzed: true };
  }
  // Increment usage for the current period.
  await incrementUsage(shop, 1);
  return { counted: true, alreadyAnalyzed: false };
}
```

This helper is called from exactly three places (the three sites that
can successfully complete Tier 3 on a thread):

1. `app/lib/gmail/pipeline.ts:classifyAndDraft` — after Tier 3
   analysis stores `analysisResult` and sets
   `processingStatus = "analyzed"` on the email row.
2. `app/lib/gmail/pipeline.ts:reanalyzeEmail` — after the same
   `analyzeSupportEmail` + persist step.
3. Any future caller that runs Tier 3 directly (today none; placeholder
   for `handleUpdateClassification` reset path which already does it
   via `refreshThreadAnalysis({reclassifyIntent: true})` but only on
   explicit reset).

`refreshThreadAnalysis` with `{reclassifyIntent: false}` (the Shopify +
17track-only path) does NOT count — no first-time-LLM-analysis is
happening, just data refresh.

### Quota guard sites — what changes

**Removed quota consumption** from:
- `handleRefine` (in `inbox-actions.ts`): no longer wraps `refineDraft`
  in `withDraftQuota`. The call is now unconditional within
  `canGenerateDraft` (which itself still checks `isSyncSuspended`).
- `handleRedraft`: same — no `withDraftQuota` wrap.
- The unified `handleGenerateDraft` follows the same logic (no quota
  consumption beyond the entitlements pre-check).

**Quota check stays** at:
- `handleReanalyze` — when user clicks "Generate draft" on an
  unanalyzed email (no `analysisResult` yet, which means Tier 3 will
  actually run). Pre-check `canGenerateDraft`. Tier 3 will then call
  `markThreadAnalyzedIfFirst` which performs the actual consumption.
- Auto-sync `classifyAndDraft` — Tier 3 itself. The function should
  read the current entitlement state and abort gracefully if
  `isSyncSuspended`. This is already what auto-sync does at the job
  level via `runJob`'s entitlement gate (which short-circuits the whole
  job). So no extra guard needed here.

### Auto-analysis on re-classification

When a thread moves from a "non-support" stance to a "support" stance
without the user clicking Generate draft (today's behaviour is: the
thread sits there with no analysis), we need to catch up. Otherwise
the merchant has to manually click Generate on every misclassified
thread, which is friction we don't want.

Two trigger sites that can flip a thread to a support-y state:
- `handleMoveThread` — moving to `waiting_merchant` /
  `waiting_customer` (already forces `supportNature: confirmed_support`).
- `handleUpdateClassification` — explicit user override of the
  classifier (already touches `supportNature`).

After either of these mutates `Thread.supportNature` to a support-y
value, **enqueue a `SyncJob` of a new kind `analyze_thread`** with
`params: { threadId }`. The auto-sync loop picks it up at the next
tick (~60 s, no user-visible delay) and runs Tier 3 on the thread's
anchor email with `skipDraft: true` — the same lightweight analysis
auto-sync already performs on fresh support emails.

The Tier 3 path then triggers `markThreadAnalyzedIfFirst`, which sets
`analyzedAt` and increments `analyzedThreadsCount`. Subsequent user
clicks on "Generate draft" go through `redraftEmail` (free) since the
analysis is already there.

Guardrails:
- Only enqueue if `Thread.analyzedAt` is null (no duplicate work / no
  double charge).
- Only enqueue if `supportNature` actually moved to a support-y value
  in this call (no enqueue on idempotent no-op).
- The job uses the existing per-shop concurrency lock so it can't
  interfere with a running periodic sync.

Adding the new kind: extend `SyncJobKind` type +
`auto-sync.ts:runJob` switch + a `runAnalyzeThreadJob(threadId)` helper
that loads the thread, picks the anchor email, and calls
`analyzeSupportEmail` with `skipDraft: true` then
`markThreadAnalyzedIfFirst`.

### Entitlement / suspension logic

No change. `isSyncSuspended` is already computed as `quotaStatus.level
=== 'exceeded'` in `buildPaidEntitlements`. When the new counter hits
the cap:
- Auto-sync skips the job (no Pass 1 / Pass 2 / Pass 3 for that shop).
- Inbox UI shows `SyncSuspendedBanner`.
- User-action handlers (`handleReanalyze` etc.) return
  `quotaExceeded: true`.

The 48h catch-up logic (`isWithin48hZone`) keeps working unchanged:
- After upgrade or period reset, fresh emails (< 48h) get auto-analyzed
  by the resumed sync — each first analysis consumes 1 unit.
- Older emails stay in `ingested` state with no `analysisResult`. User
  clicks "Generate draft" → `handleReanalyze` → 1 unit consumed when
  Tier 3 succeeds.

### i18n updates

Replace "draft" terminology with "conversation" in user-facing strings.
Tracked keys (both `en.json` and `fr.json`):

- `inbox.quotaStatus`: "Drafts: X / Y" → "Conversations: X / Y"
- `inbox.quotaBanner`: "You're at X / Y drafts" → "X / Y conversations
  analyzed"
- `inbox.quotaModal.title`: "Draft quota exceeded" → "Conversation
  quota exceeded"
- `inbox.quotaModal.body`: "You've used your monthly drafts" → "You've
  analyzed all the support conversations in your current plan"
- `billing.plan.starter`: "50 drafts/month" → "50 conversations/month"
- `billing.plan.pro`: "500 drafts/month" → "500 conversations/month"

Internal/backend log strings keep their existing terminology to avoid
churn in log searches — only the user-facing surface changes.

### Existing-shop migration

Strategy: **reset current period, communicate softly**.

1. Migration sets all current `BillingUsage` rows' `analyzedThreadsCount`
   to 0. Shops effectively get a fresh quota for the current period
   under the new model.
2. Operator sends a one-time email to all active paying shops:
   > "Hi, we've updated how we count usage. Starting [date], we count
   > one unit per *conversation analyzed* (instead of per AI draft
   > generated). Refining and regenerating drafts inside the same
   > conversation is now included free. Your existing plan is
   > unchanged. Most shops will see their quota stretch further."
3. No price change, no plan change.

This is friendly and avoids the perception of a sudden price hike.

## Pricing math & assumptions

This section is intentionally explicit so it can be shared with
external advisors / pricing review.

### Cost per conversation (LLM, end-to-end)

| Operation | Typical cost (USD) | Frequency |
|---|---|---|
| Tier 3 first analysis (auto-sync, `skipDraft: true`) | $0.005 | 1× per conversation |
| LLM parser inside Tier 3 (intent + identifiers) | included in above | – |
| Shopify Admin GraphQL (order search) | $0 | included |
| 17track lookup (free tier, 100/mo) | $0 | included |
| Crawler context (conditional, ~30 % of threads) | $0.002 | 0–1× |
| Draft generation on demand (`redraftEmail` path) | $0.003 | 1× per draft click |
| Refine (LLM rewrite from user prompt) | $0.003 | 0–N× per conversation |
| Regenerate (`handleRedraft` after merge) | $0.003 | 0–N× per conversation |

Per-conversation totals across user-behaviour buckets:

| User profile | Cost / conv |
|---|---|
| Light (analyse only, no draft click) | $0.005 |
| Medium (analyse + 1 draft + 0 refines) | $0.008 |
| Active (analyse + 1 draft + 2 refines + 1 regen) | $0.017 |
| Power (analyse + 1 draft + 5 refines + 2 regens) | $0.026 |
| Pathological abuse (analyse + 20 refines) | $0.065 |

### Revenue per conversation

- Starter $9 / 50 = **$0.18 / conversation**
- Pro $49 / 500 = **$0.098 / conversation**

### Gross margin

| Plan × Profile | Margin |
|---|---|
| Starter × Light | 97 % |
| Starter × Active | 91 % |
| Starter × Power | 86 % |
| Starter × Pathological | 64 % |
| Pro × Light | 95 % |
| Pro × Active | 83 % |
| Pro × Power | 74 % |
| Pro × Pathological | 34 % |

### Volume assumption per shop

| Shop revenue / month | Orders ($60 AOV) | Support contact rate | Real support threads | Noise (×1.5) | Total conversations |
|---|---|---|---|---|---|
| $5 000 | 80 | 10 % | 8 | 12 | **12** |
| $10 000 | 165 | 10 % | 17 | 25 | **25** |
| $25 000 | 415 | 10 % | 42 | 63 | **63** |
| $50 000 | 830 | 10 % | 83 | 125 | **125** |
| $100 000 | 1 665 | 10 % | 167 | 250 | **250** |

- Sub-$10k shops fit Starter (50) with margin.
- $10k–$25k shops sit at Starter cap; some need Pro.
- $25k+ shops should upgrade to Pro (500).
- $100k+ shops use ~50 % of Pro's cap; comfortable.

### Sensitivity to OpenAI price changes

If OpenAI raises pricing 2× (today's gpt-4o $2.50/M input, $10/M
output):
- Cost / Power profile: $0.026 → $0.052.
- Starter margin: 86 % → 71 %. Still healthy.
- Pro margin: 74 % → 47 %. Tighter; reconsider caps if this happens.

### Break-even per conversation

Below which cost we are unprofitable on a shop:
- Starter: $0.18 (any conversation costing more loses money on that
  unit, but quota cap protects volume).
- Pro: $0.098 (same logic).

Even the Power profile sits well below both. No realistic single-shop
scenario flips negative on a steady-state basis.

## Edge cases

- **Thread classified as `probable_non_client` at Tier 2** — Tier 3
  doesn't run → `analyzedAt` stays null → 0 quota consumed. If the
  merchant later moves the thread to a support state or overrides the
  classification, a `analyze_thread` SyncJob is enqueued (see
  "Auto-analysis on re-classification" above), Tier 3 runs at the next
  tick with `skipDraft: true` → 1 unit consumed. No user click required
  to trigger this; the draft is still gated behind the merchant's
  explicit "Generate draft" click.
- **Re-sync (handleResync deletes all `IncomingEmail` rows)** — the
  `Thread` row survives with its `analyzedAt` already set. The
  subsequent Tier 3 pass on re-ingested messages calls
  `markThreadAnalyzedIfFirst` but finds `analyzedAt != null` and skips
  the increment. No double-billing on resync.
- **Thread tombstoned by GDPR `customers/redact`** — the Thread row is
  kept with `redactedAt` set; `analyzedAt` is preserved. Already paid.
  No refund.
- **Thread merged (canonical thread consolidation)** — both source
  threads have `analyzedAt`. The merger keeps the canonical thread's
  `analyzedAt`. The other thread row's analyzedAt is moot (it gets
  deleted via cascade). No partial refund.
- **Tier 3 fails mid-run** — `analysisResult` is not stored,
  `markThreadAnalyzedIfFirst` is not called → `analyzedAt` stays null
  → no quota consumed. Retry on next sync may succeed and consume.
- **Concurrent Tier 3 attempts on the same thread (auto-sync race)** —
  `markThreadAnalyzedIfFirst` uses `updateMany WHERE analyzedAt IS
  NULL` which is atomic at the SQL level. Whichever transaction wins
  the row update consumes 1 unit; the other sees `count: 0` and treats
  it as "already analyzed".
- **`incrementUsage` race for the current period** — handled by Prisma
  `upsert` keyed on `(shop, periodStart)` with `update: { count:
  increment 1 }`. Postgres serialises the increment.

## Monitoring (abuse + product signals)

Lightweight, no in-code blocking:

- Metric `llm_calls_total{call_site}` already exists. Surface in
  `/app/metrics` a "Refine rate per shop" row that shows refines per
  conversation per shop over the last 24 h.
- Alert (operator manual review for now): if any shop's refine rate
  exceeds 10× the median across all shops for 2 consecutive days, flag
  it for manual contact.
- No automatic refine-count cap on the user. We trust humans.

## Test plan

Unit tests:
- `markThreadAnalyzedIfFirst` — first call counts; second call no-ops;
  shop mismatch no-ops.
- Plan definitions — `analyzedThreadsPerMonth` field present and
  numerically correct.
- Quota computation — `computeQuotaStatus(used, limit)` unchanged in
  logic but tests rename the field in fixtures.

Integration tests:
- Auto-sync Tier 3 on a fresh thread → `Thread.analyzedAt` set,
  `BillingUsage.analyzedThreadsCount` += 1.
- Auto-sync Tier 3 on a thread with `analyzedAt != null` → no
  increment.
- `handleRefine` after auto-sync analysis → 0 quota consumed,
  `analyzedThreadsCount` unchanged.
- `handleReanalyze` on unanalyzed thread → Tier 3 runs → 1 unit
  consumed.
- `handleReanalyze` on already-analyzed thread → 0 unit consumed.
- Migration test (separate file): apply migration to a seeded DB
  containing threads with `analysisResult`; verify `analyzedAt` is
  backfilled to `createdAt`.

Migration test:
- Pre-migration: seed Thread + IncomingEmail with analysisResult, run
  migration script, assert post-migration `analyzedAt == createdAt`.

Manual smoke (after merge):
- Fresh shop: sync 5 support emails → counter = 5.
- Click Refine 3× on one of them → counter still = 5.
- Re-sync the same shop → counter still = 5.
- Force quota to 50 → next sync gets suspended → SyncSuspendedBanner
  shown → upgrade Plan → suspension lifts → catch-up runs.

## Risks

- **Existing customers see a change in counter label** ("drafts" →
  "conversations"). Mitigated by the soft-comm email.
- **A few migration edge cases on shops with very old `BillingUsage`
  rows** — they'll have non-zero `draftsCount` after rename. Reset
  script in migration handles current period; older periods become
  historical and don't affect entitlements.
- **The new model is more generous than the old one for power users**
  (refines no longer consume quota). Some power users currently on Pro
  may need to downgrade to Starter; their effective revenue drops.
  Acceptable: the new model better matches value, and shop count is
  still small.

## Out of scope (acknowledged)

- **Manual drafting feature** — adds a "Write manually" affordance to
  the unanalyzed-thread UI. Will land in a follow-up spec after this
  billing change ships. Conceptually trivial once billing decouples
  from drafts.
- **Soft overage / usage charges** — not added now. The current
  hard-block model with upgrade prompt is sufficient at MVP volumes.
- **Per-seat pricing** — not added now. Stays a possibility for the
  endgame when the app has 50+ shops and we have data on segment
  spread.
- **Refine-count cap** — explicit refines/regens per conversation
  limit. Not added. Trust humans + alert on anomalies.
- **Pricing experiments (A/B different caps)** — operator decision,
  not in this spec.

## Acceptance criteria

1. New `Thread.analyzedAt` column exists, populated on Tier 3 success.
2. Renamed `BillingUsage.analyzedThreadsCount` column exists.
3. `Plans.analyzedThreadsPerMonth` exposed with values 50 / 500 /
   Infinity.
4. Auto-sync Tier 3 on a new thread increments the counter by exactly
   1; re-sync on the same thread does not increment.
5. `handleRefine` and `handleRedraft` do NOT consume quota (only the
   pre-check on `canGenerateDraft` remains).
6. `handleReanalyze` (user-clicks "Generate draft" on unanalyzed
   thread) consumes 1 unit on Tier 3 success.
7. When the cap is hit, `isSyncSuspended` flips true; auto-sync skips
   jobs; UI shows the existing banner; user actions return
   `quotaExceeded`.
8. Migration backfills `Thread.analyzedAt` from existing data; resets
   current-period `analyzedThreadsCount` to 0.
9. i18n strings updated in both `en.json` and `fr.json`.
10. Moving a thread from `non_support` to a support stance enqueues an
    `analyze_thread` SyncJob; auto-sync runs Tier 3 with
    `skipDraft: true` and consumes 1 unit on first analysis.
11. All new tests pass; existing tests still pass after the renaming.
