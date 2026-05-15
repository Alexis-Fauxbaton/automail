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

### How many Tier 3 runs per conversation? (clarification)

A single thread can have **multiple** Tier 3 runs over its lifetime:
- 1× when the first customer message arrives.
- 1× each time a follow-up customer message lands in the same thread
  (auto-sync re-classifies the new latest incoming).
- 0-N× when the merchant clicks "Generate draft" or "Reanalyze"
  explicitly.
- 0× from `refresh-stale-analyses` and `refreshThreadAnalysis` — those
  use the light no-LLM path.

But **billing is per conversation, not per Tier 3 run**. The very first
successful Tier 3 sets `analyzedAt`. Every subsequent Tier 3 on the
same thread is real LLM work we pay for, but the user pays 1 unit
total. This is intentional and aligns with how merchants think
("1 customer issue handled = 1 unit"). The margin section below
includes a multi-message conversation profile so the cost is honestly
absorbed.

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

Per-conversation totals across realistic profiles. Each row factors in
the typical number of incoming customer messages for that profile
(each new message triggers a Tier 3 re-analysis we pay for but
don't re-bill).

| Profile | # customer messages | Cost / conv |
|---|---|---|
| Short-and-done (1 message, no draft click) | 1 | $0.005 |
| Short with draft (1 message + 1 draft + 0 refines) | 1 | $0.008 |
| Typical (2 messages + 1 draft + 2 refines + 1 regen) | 2 | $0.022 |
| Multi-back-and-forth (4 messages + 1 draft + 3 refines) | 4 | $0.029 |
| Long thread (8 messages + 1 draft + 2 refines) | 8 | $0.049 |
| Power user on long thread (8 msgs + 1 draft + 10 refines) | 8 | $0.073 |
| Pathological abuse (any thread + 50 refines) | any | $0.155 |

### Revenue per conversation

- Starter $9 / 50 = **$0.18 / conversation**
- Pro $49 / 500 = **$0.098 / conversation**

### Gross margin

| Plan × Profile | Margin |
|---|---|
| Starter × Short-and-done | 97 % |
| Starter × Typical | 88 % |
| Starter × Multi-back-and-forth | 84 % |
| Starter × Long thread | 73 % |
| Starter × Power-on-long | 59 % |
| Starter × Pathological | 14 % |
| Pro × Short-and-done | 95 % |
| Pro × Typical | 78 % |
| Pro × Multi-back-and-forth | 70 % |
| Pro × Long thread | 50 % |
| Pro × Power-on-long | 26 % |
| Pro × Pathological | **-58 %** (loss) |

The Pro × Long-thread + Power-on-long rows are the squeeze. They're
rare in practice but they're the ones to monitor via the alerting
described below. Pathological abuse is the only consistently-negative
profile — that's where the operator-level alert applies.

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

Billing is a financially sensitive area. The test suite must
exhaustively cover every code path that could (a) over-bill, (b)
silently under-bill, (c) leak across shops, or (d) misbehave at period
boundaries. Tests are grouped by the failure class they prevent.

### Class 1 — Double counting

`markThreadAnalyzedIfFirst` is the only writer. Unit + integration
tests must prove it's idempotent.

- **Unit** — calling the helper twice in a row on the same thread
  returns `{counted: true}` then `{counted: false, alreadyAnalyzed:
  true}`. The DB row's `analyzedAt` is set after the first call and
  unchanged after the second.
- **Unit** — calling it 100 times sequentially yields exactly 1
  increment in `BillingUsage.analyzedThreadsCount`.
- **Integration** — auto-sync runs Tier 3 successfully on a thread,
  then auto-sync runs again on the same thread (e.g. resync) → only 1
  increment total.
- **Integration** — user clicks "Generate draft" on an already-analyzed
  thread → `redraftEmail` path runs, no `markThreadAnalyzedIfFirst`
  call, counter unchanged.
- **Integration** — full sequence: auto-sync analyzes, user clicks
  Generate draft, user refines 5×, user regenerates 2× → counter = 1.
- **Integration — long conversation** — seed a thread, run auto-sync
  → counter = 1. Append a 2nd customer message, sync → counter still
  = 1 (Tier 3 ran twice but only first time counted). Append 3rd, 4th,
  5th customer messages, sync after each → counter still = 1 at the
  end. This is the spec's most important billing invariant: a long
  conversation never re-bills.
- **Integration** — `handleReanalyze` on an already-analyzed thread →
  Tier 3 may run again to refresh facts, but `markThreadAnalyzedIfFirst`
  short-circuits → counter unchanged. (Document explicitly: re-analysis
  cost is absorbed in margin, not re-billed.)

### Class 2 — Concurrent racing (critical)

The atomic `updateMany WHERE analyzedAt IS NULL` is the linchpin.
Tests must prove it under real concurrent load against Postgres.

- **Integration** — fire 10 parallel `markThreadAnalyzedIfFirst` calls
  for the same threadId via `Promise.all`. Assert exactly 1 returns
  `{counted: true}` and 9 return `{counted: false}`. Final counter = 1.
- **Integration** — same test with 50 parallel calls split across 5
  distinct threads (10 each). Final counter = 5.
- **Integration** — fire 20 parallel auto-sync Tier 3 invocations on
  the same thread (simulating worker overlap or job-queue race). Final
  counter = 1.
- **Integration** — interleave: thread A's first analysis racing with
  thread B's first analysis for the same shop. Both succeed; counter
  = 2; `BillingUsage` row's `analyzedThreadsCount` is consistent (no
  lost update from upsert race).

### Class 3 — Spurious counting (should NOT have charged)

- **Unit** — `markThreadAnalyzedIfFirst` called with shop="X" on a
  thread belonging to shop="Y" → returns `{counted: false}`, no DB
  mutation, no usage row touched.
- **Integration** — Tier 3 throws before `markThreadAnalyzedIfFirst`
  is called → `analyzedAt` stays null, counter unchanged.
- **Integration** — Tier 3 succeeds but `markThreadAnalyzedIfFirst`
  fails (DB blip) → `analyzedAt` is not set, counter is not incremented.
  Next attempt will retry cleanly.
- **Integration** — `refreshThreadAnalysis({reclassifyIntent: false})`
  (the lightweight Shopify+17track-only path) runs on an unanalyzed
  thread → counter unchanged (it's not a Tier 3 first analysis).
- **Integration** — auto-sync receives a non-support thread (Tier 2
  returned `probable_non_client`) → Tier 3 never runs → counter
  unchanged. Move the same thread to support, BUT pretend the enqueue
  failed (mock the SyncJob create) → counter unchanged.
- **Integration** — `handleEditThreadIdentifiers` triggers
  `refreshThreadAnalysis` (light) on an analyzed thread → counter
  unchanged.

### Class 4 — Cross-shop isolation (must not leak)

- **Unit** — shop X analyzes thread, shop Y's `BillingUsage` for the
  same period is unaffected.
- **Integration** — shops X and Y each analyze 10 threads concurrently
  → X has counter=10, Y has counter=10, neither has 11+.
- **Integration** — shop X uninstalls → its `BillingUsage` rows are
  deleted; shop Y's are not.

### Class 5 — Period boundaries (off-by-one billing month bugs)

- **Unit** — `getCurrentPeriodStart` returns the UTC midnight of the
  1st of the month. Pin the test clock to 2026-03-31T23:59:59Z →
  period = 2026-03-01. Advance one second → period = 2026-04-01.
- **Integration** — analyze a thread on Mar 31 23:59 UTC → March
  counter +1. Analyze another thread on Apr 1 00:01 UTC → April
  counter +1; March counter unchanged.
- **Integration** — at the period flip, `getUsage` returns 0 for the
  new period even if previous period had 50/50.
- **Integration** — quota `isSyncSuspended` lifts at period start (50
  used last month, 0 this month → not suspended).

### Class 6 — Quota cap behaviour

- **Unit** — `computeQuotaStatus(49, 50)` → `level: 'ok'`,
  `canGenerateDraft: true` (handler still gates entry but Tier 3 can
  still consume the 50th unit cleanly).
- **Unit** — `computeQuotaStatus(50, 50)` → `level: 'exceeded'`,
  `isSyncSuspended: true`.
- **Integration** — shop at 49/50, auto-sync starts a job, Tier 3 runs
  on one thread → counter becomes 50, no error, job completes.
- **Integration** — shop at 50/50, auto-sync's next job is skipped
  (entitlement gate in `runJob`); inbox UI shows `SyncSuspendedBanner`.
- **Integration** — shop at 50/50, user clicks "Generate draft" on an
  unanalyzed thread → `handleReanalyze` returns `quotaExceeded: true`,
  no Tier 3 runs, counter unchanged.
- **Integration** — shop at 50/50, user clicks "Refine" on an
  already-analyzed thread → succeeds (refine doesn't consume), counter
  unchanged.
- **Integration** — concurrent quota race: at 49/50, fire two parallel
  user-triggered Tier 3 calls. Outcome: one succeeds (50/50), the
  other either succeeds-then-counter-is-51 OR fails with
  `quotaExceeded`. The spec requires the second to FAIL — verify with
  a deterministic test using transaction-level locking on the
  `BillingUsage` row, or `pg_advisory_xact_lock` on the shop key
  before the increment. (Implementation must choose one path; the test
  pins the behaviour.)

### Class 7 — Migration correctness

- **Migration test** — pre-state: 100 Thread rows, 60 with at least
  one `IncomingEmail.analysisResult != null`, 40 without. Run
  migration. Post-state: 60 threads with `analyzedAt = createdAt`, 40
  with `analyzedAt = null`. Counter unchanged.
- **Migration test** — pre-state: shop X had `BillingUsage` row for
  current period with `draftsCount = 30`. Run migration. Post-state:
  same row, `analyzedThreadsCount = 0` (current period reset). Historical
  rows from previous periods untouched.
- **Migration test** — column rename is reversible (Prisma down
  migration). Smoke-test that the rollback restores the old column
  name. (Down migrations are off-by-default in production; this test
  catches latent breakage.)
- **Migration test** — concurrent writes during migration are
  serialized by the migration's table lock (Prisma default). No data
  loss.

### Class 8 — Re-classification catch-up

- **Integration** — non_support thread, user calls `handleMoveThread`
  to `waiting_merchant` → asserts a `SyncJob {kind: "analyze_thread",
  params: {threadId}}` row is created.
- **Integration** — same scenario, BUT `Thread.analyzedAt` was already
  set → no SyncJob enqueued.
- **Integration** — same scenario, BUT the call to `handleMoveThread`
  is a no-op (state unchanged) → no SyncJob enqueued.
- **Integration** — auto-sync picks up the `analyze_thread` job, runs
  Tier 3 with `skipDraft: true`, succeeds → `analyzedAt` set, counter
  +1, no draft generated (assert `replyDraft` row stays null).
- **Integration** — auto-sync picks up the job, Tier 3 fails →
  `analyzedAt` stays null, counter unchanged, job retried per existing
  job-queue retry policy. After 3 failures, job moves to "error" and
  stays unanalyzed; UI must show a "Retry analysis" affordance.
- **Integration** — two calls to `handleMoveThread` in quick succession
  on the same thread → `enqueueJob` deduplicates (existing behaviour),
  only one SyncJob exists; the second call sees the pending one and
  returns its id.

### Class 9 — User-action paths (refine/redraft never charge)

- **Unit** — `handleRefine` body inspection: no call to
  `withDraftQuota`, no call to `markThreadAnalyzedIfFirst`, no call to
  `incrementUsage`.
- **Unit** — `handleRedraft` body inspection: same.
- **Unit** — `handleGenerateDraft` (wrapper) body inspection: same.
- **Integration** — call `handleRefine` 100 times on the same analyzed
  thread → counter unchanged.
- **Integration** — call `handleRedraft` 100 times on the same
  analyzed thread → counter unchanged.

### Class 10 — Negative / defensive

- **Unit** — `BillingUsage.analyzedThreadsCount` can never go negative.
  Test: `incrementUsage(shop, -5)` is rejected with a thrown error
  (the API should be additive-only; if it accepts deltas they must be
  non-negative integers).
- **Unit** — `markThreadAnalyzedIfFirst` with an empty or invalid
  `threadId` (`""`, `null`, malformed CUID) returns `{counted: false}`
  without touching the DB.
- **Unit** — `markThreadAnalyzedIfFirst` on a thread that doesn't
  exist (deleted between read and write) returns `{counted: false}`,
  no usage row touched.

### Class 11 — Observability for finance audits

- **Integration** — every successful `markThreadAnalyzedIfFirst`
  emits a metric (`billing.analyzed_thread.counted{shop, plan}`) so
  finance can reconcile invoices against the metric stream. Test:
  observation count matches DB increments after a batch of analyses.
- **Integration** — failed `markThreadAnalyzedIfFirst` (e.g., DB
  error after Tier 3 success) emits a different metric
  (`billing.analyzed_thread.skipped{shop, reason}`). The merchant is
  NOT over-billed if this happens — they're under-billed, but it's
  visible. Test: simulate DB failure, assert skipped metric is
  incremented, counter is unchanged.

### Plan / quota assertions

- **Unit** — `PLANS.starter.analyzedThreadsPerMonth === 50`.
- **Unit** — `PLANS.pro.analyzedThreadsPerMonth === 500`.
- **Unit** — `PLANS.trial.analyzedThreadsPerMonth === Infinity`.
- **Unit** — `getPlan('starter')` returns the starter plan.
- **Unit** — `getPlan('unknown')` returns `null`.

### Manual smoke (after merge, before public launch)

- Fresh shop on Starter: sync 50 support emails → counter = 50. Sync
  one more → not synced (suspended). UI shows banner. Upgrade to Pro
  → suspension lifts → catch-up resumes → counter = 51.
- Refine each of the first 50 conversations 3× → counter still = 50.
- Re-sync (handleResync) → counter still = 50.
- Trigger period flip manually (set `BillingUsage.periodStart` to
  previous month) → next analyze → counter for new period = 1.
- Migration on a copy of the production DB: capture counter values
  before/after, manually inspect that they make sense.

### Performance / load (smoke at 10-shop scale)

- Simulate 10 shops each receiving 30 support emails simultaneously
  → after auto-sync drain, each shop has counter = 30, no
  cross-pollination. Wall-clock budget for the full simulation < 5
  minutes on a 4-CPU dev box.

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
12. **Billing test coverage** — every test class in the Test Plan
    section above has at least one passing test, and the overall
    coverage of `markThreadAnalyzedIfFirst`, `incrementUsage`,
    `getUsage`, `computeQuotaStatus`, and the entitlements builders
    that read them is at or above 95 % statement coverage (run
    `npm run test:coverage` and inspect those files specifically).
