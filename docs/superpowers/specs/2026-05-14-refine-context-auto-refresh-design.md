# Refine context auto-refresh — design

**Date:** 2026-05-14
**Status:** Approved by user, ready for implementation plan

## Problem

Two related gaps in the support flow:

1. **Refine with AI is context-blind.** `refineDraft` only receives the
   original customer email's `subject` and `bodyText`. The matched
   Shopify order, the resolved tracking, and any analysis warnings are
   never passed to the LLM during a refine. The LLM is asked to rewrite
   a draft about facts it doesn't know.

2. **Manual identifier edits don't refresh the underlying analysis.**
   `handleEditThreadIdentifiers` updates `Thread.resolvedOrderNumber` /
   `resolvedTrackingNumber` / `resolvedEmail` / `resolvedCustomerName`,
   but the latest analyzed `IncomingEmail.analysisResult` (which carries
   the rich `order` and `trackings` objects) stays stale. The inbox UI
   keeps showing the old order until the next sync, and the next Refine
   gets stale context.

## Goal

When a user edits identifiers, immediately refresh the analysis so
`analysisResult` reflects the new identifiers (new order data, new
tracking facts). When the user clicks Refine, pass a curated summary of
that analysis to the LLM so it has accurate, factual context.

The two changes are independent in code but tightly coupled in intent:
together they make Refine "see the latest context automatically" without
adding any new detection logic to the Refine handler itself.

## Non-goals

- Detecting changes from auto-sync (when Shopify or 17track returns
  different data without anyone clicking edit). The existing 10-minute
  time-based safety net in `maybeRefreshAnalysis` already covers that.
- Adding a per-thread advisory lock between user actions and the
  auto-sync worker. Out of scope, tracked separately as H6 in
  TECHNICAL_DEBT.md.
- Re-running LLM intent classification during the edit-time refresh.
  Intent is a property of the customer's message, not the merchant's
  resolution choice.
- Auto-regenerating the draft after the refresh. The user explicitly
  triggers a refine; we don't surprise them with a new draft.
- Cross-tab synchronisation. Two concurrent edits from two tabs
  follow last-write-wins on `Thread.resolved*` and trigger two refreshes;
  the second wins. Adding a lock here is over-engineering for the use
  case.

## Design

### Section 1 — Edit-time refresh

**Trigger:** `handleEditThreadIdentifiers` in
`app/lib/support/inbox-actions.ts`.

**Flow:**

1. Read the current `Thread.resolved*` row (call it `before`).
2. Validate the new payload as today.
3. Compute the diff:
   ```ts
   const orderChanged    = before.resolvedOrderNumber    !== input.resolvedOrderNumber;
   const trackingChanged = before.resolvedTrackingNumber !== input.resolvedTrackingNumber;
   const emailChanged    = before.resolvedEmail          !== input.resolvedEmail;
   const nameChanged     = before.resolvedCustomerName   !== input.resolvedCustomerName;
   const anyChange       = orderChanged || trackingChanged || emailChanged || nameChanged;
   ```
4. If `!anyChange`: write nothing (early return) with
   `{ editedThread: { canonicalThreadId }, refreshed: "skipped_noop" }`.
5. Otherwise: persist `Thread.resolved*` updates as today.
6. Resolve the anchor (latest `processingStatus = "analyzed"` email of
   the thread).
7. If no anchor: return
   `{ editedThread: ..., refreshed: "no_anchor" }`. The thread has no
   analyzed email yet (still pending Tier 2/3); the next sync will
   incorporate the new identifiers when it analyzes a message.
8. If anchor exists, decide what to refresh:
   ```ts
   // refreshTracking follows reSearchOrder because a new order means
   // new fulfillments, which means new tracking numbers. The only
   // skip case is "only the customer name changed".
   const reSearchOrder    = orderChanged || trackingChanged || emailChanged;
   const refreshTracking  = reSearchOrder;
   ```
9. Call `refreshThreadAnalysis(anchor.id, admin, shop, { reclassifyIntent: false, reSearchOrder, refreshTracking })` **synchronously**.
10. On success: return `{ editedThread: ..., refreshed: "ok" }`. The
    UI's inbox loader revalidates via the existing React Router
    fetcher pattern and shows the new order/tracking.
11. On thrown error (Shopify auth fail, 17track 5xx, etc.): log a
    structured warning and return
    `{ editedThread: ..., refreshed: "error" }`. The edit ITSELF is
    persisted — only the refresh failed. The next sync rescues stale
    data within ~1h.

**External-call cost per edit:**

| What changed | Shopify call | 17track call | LLM call |
|---|---|---|---|
| Only `resolvedCustomerName` | 0 | 0 | 0 |
| Any of order / tracking / email | 1 GraphQL | 0 or 1 (see below) | 0 |

17track quota use is **1 unit if and only if the tracking number is new
to 17track** (first time we register it). Subsequent `gettrackinfo`
calls on a previously-registered number are free, so a typo correction
re-submitting the same number costs nothing. The breaker (5 fails / 10
min → 15 min cooldown) protects against abuse at the process level.

**Server-side telemetry:**

A new counter in `app/lib/metrics/definitions.ts`:

```ts
metrics.counter(
  "refine_context_refresh_total",
  "Edit-time refresh outcomes from handleEditThreadIdentifiers.",
);
```

Labels: `shop`, `outcome` ∈ `ok | skipped_noop | no_anchor | error`.
Surfaces directly on `/app/metrics` and `/metrics`.

**Client-side UX:**

- The Save button in the identifiers panel goes into `loading: true`
  during the action and re-enables on response. No full-page overlay.
- On `refreshed === "ok"`, the inbox card revalidates and shows the new
  order/tracking summary without a manual reload.
- On `refreshed === "error"`, a non-blocking toast: "Identifiers saved,
  but Shopify/tracking refresh failed — will retry on next sync."
- On `refreshed === "skipped_noop"` / `"no_anchor"`: silent success.

### Section 2 — Refine context-aware

**New helper:** `app/lib/support/refine-context.ts`

```ts
/**
 * Build a compact, English, plain-text summary of the support analysis
 * to feed into the Refine LLM call. Returns null when nothing useful
 * could be summarised (so the prompt stays clean).
 */
export function buildRefineContext(
  analysis: SupportAnalysis,
): string | null;
```

**Rendered shape (illustrative):**

```
=== ORDER ===
Order: #1234 — placed 2026-03-14, total €89.50
Status: fulfilled (paid)
Items:
  • 2× Blue T-Shirt L
  • 1× Sneakers 42
Customer: John Doe <john@example.com>

=== TRACKING ===
LP123456789FR (La Poste · Colissimo)
Status: in_transit
Last event: 2026-05-13 — Out for delivery (Paris)
ETA: 2026-05-14

=== WARNINGS ===
- Low confidence on order match
```

**Construction rules:**

- Section headers always in English ("ORDER", "TRACKING", "WARNINGS").
  The LLM is asked to keep the draft in the draft's own language; the
  context block is data, not prose.
- Omit any section that has no content (no empty `=== TRACKING ===`).
- Line items capped at 5 with `… + N more` suffix.
- Tracking: latest event only, never the full history. Multiple
  trackings produce multiple `=== TRACKING ===` blocks separated by a
  blank line.
- Warnings filtered to those that change the answer (low confidence on
  order match, missing customer email, etc.). Cosmetic / dev warnings
  are excluded. The exact filter list lives in the helper as a
  documented allowlist.
- Returns `null` when the resulting block would be empty or
  whitespace-only, so the caller can skip it cleanly.
- Output budget: aim for < 400 tokens. Helper does not enforce a hard
  cap because the cap-emitting fields (line items, trackings, warnings)
  are already bounded above.

**Modification to `refineDraft`:**

```ts
export async function refineDraft(
  currentDraft: string,
  instructions: string,
  context?: { subject?: string; body?: string; contextSummary?: string },
  ctx?: Partial<TrackedCallContext>,
): Promise<string>;
```

- System prompt grows one paragraph: a context block, if present, is
  the authoritative source of factual data about the order and shipment
  — do not invent or contradict it, but do not blindly recite it
  either.
- User message format when context is present:
  ```
  Current draft:
  <draft>

  Instructions: <instructions>

  Original customer email:
  <subject + body>

  Verified facts about this customer's order:
  <contextSummary>
  ```

**Modification to `handleRefine`:**

```ts
const analysis = record.analysisResult
  ? safeJsonParse<SupportAnalysis>(record.analysisResult)
  : null;
const contextSummary = analysis ? buildRefineContext(analysis) : null;

await refineDraft(currentDraft, instructions, {
  subject: record.subject,
  body: record.bodyText,
  contextSummary: contextSummary ?? undefined,
}, ctx);
```

The existing `maybeRefreshAnalysis(emailId, admin, shop)` time-based
trigger (10 min staleness) stays in `handleRefine`. It catches the case
where Shopify order state changed without anyone editing identifiers
(e.g. order shipped between two refines on the same day).

### Section 3 — Edge cases, observability, tests

**Edge cases:**

- `analysisResult` is `null` or non-JSON → `buildRefineContext` returns
  `null`, refine works as today (no context block in prompt). No
  regression.
- Edit submits identical values for every field → diff is empty,
  early-return `refreshed: "skipped_noop"`. Zero external calls.
- Edit on a thread whose anchor email isn't analyzed yet → return
  `refreshed: "no_anchor"`. Logged with shop + canonicalThreadId. The
  next sync's Tier 3 picks up the new identifiers via the existing
  `getThreadResolution` flow.
- `refreshThreadAnalysis` throws (Shopify auth, 17track 5xx, breaker
  open) → caught at the edit handler boundary, logged with structured
  fields, return `refreshed: "error"`. Edit is still persisted in DB.
- Two browser tabs edit concurrently → both writes succeed (last
  write wins on `Thread.resolved*`), both refreshes run (last wins on
  `analysisResult`). No explicit lock.

**Metrics added (besides the new counter above):**

- The existing `llm_calls_total{call_site="refine-draft"}` already
  measures Refine traffic — nothing new there.
- The Shopify GraphQL calls inside `refreshThreadAnalysis` are not
  metricised today and stay that way. Adding a Shopify-call counter is
  a separate (broader) telemetry pass.

**Test plan:**

Unit tests (`app/lib/support/__tests__/refine-context.test.ts`):

1. Order-only analysis → block contains `=== ORDER ===` and not
   `=== TRACKING ===`.
2. Tracking-only analysis → block contains `=== TRACKING ===` and not
   `=== ORDER ===`.
3. Both → both sections present, in order ORDER, TRACKING, WARNINGS.
4. Empty / missing analysis → returns `null`.
5. Line items > 5 → exactly 5 lines rendered + `+ N more` suffix.
6. Two trackings → two `=== TRACKING ===` blocks separated by a blank
   line.
7. Cosmetic warnings (e.g. `low_priority_metadata`) filtered out.
8. High-impact warning (e.g. `order_match_low_confidence`) present.
9. Empty arrays (`items: []`, `trackings: []`) → corresponding section
   omitted.
10. Output stays under a reasonable upper bound (assert < 2000 chars
    on the worst realistic fixture).

Integration tests (`app/lib/__tests__/integration/refine-context-refresh.test.ts`):

1. `handleEditThreadIdentifiers` — order changes →
   `refreshThreadAnalysis` is called with
   `{ reclassifyIntent: false, reSearchOrder: true, refreshTracking: true }`
   (verify via vi.spyOn on the module).
2. Only customer name changes → `refreshThreadAnalysis` is called with
   `reSearchOrder: false, refreshTracking: false`. (No external calls
   in this path.)
3. No change at all → `refreshThreadAnalysis` is not called and the
   response is `refreshed: "skipped_noop"`.
4. Thread without an analyzed anchor → response is `"no_anchor"`,
   `refreshThreadAnalysis` not called.
5. `refreshThreadAnalysis` throws → response is `"error"`,
   `Thread.resolved*` is still updated, error logged.
6. `handleRefine` — analysisResult present → `refineDraft` is called
   with a `contextSummary` containing the order name.
7. `handleRefine` — analysisResult null → `refineDraft` is called
   without a `contextSummary` (or with undefined).

The integration suite mocks `refreshThreadAnalysis` via vi.mock so it
doesn't hit Shopify or 17track. The unit suite uses pre-built
`SupportAnalysis` fixtures.

**Manual verification checklist** (do these once on the test shop after
merge):

- [ ] Change an order number on a thread → inbox card refreshes within
  ~3 s and shows the new order summary.
- [ ] Same thread → Click "Refine with AI" → ask "mention the
  tracking number explicitly" → output includes the new tracking
  number, not the old one.
- [ ] Change only the customer name → response is silent success, no
  Shopify call (check Network in devtools, no graphql request fires).
- [ ] Temporarily set `SEVENTEEN_TRACK_API_KEY` to garbage on Render →
  change a tracking number → edit returns "saved, refresh failed"
  toast.

**Migration / compatibility:**

- No DB schema change.
- `SupportAnalysis` already exposes `order`, `trackings`, `warnings` —
  no type changes.
- Threads predating this feature: their `analysisResult` is fully
  compatible. They get the rich Refine context immediately on the next
  Refine click, no migration needed.

## Risks

- **Edit latency rises from ~0 to 1–3 s.** Acceptable for a manual
  action with a button-level spinner.
- **17track quota.** Worst case 1 unit per tracking edit. 100/month
  free tier, breaker protects from runaway.
- **Concurrent two-tab edits**: last-write-wins. Documented, no fix.
- **`refreshThreadAnalysis` doesn't always touch `analysisResult`**
  when the underlying analysis is missing — verified that the helper
  no-ops gracefully on a thread with no prior analysis (already its
  current behaviour).

## Out of scope (acknowledged, not in this spec)

- `handleUpdateClassification` does similar identifier-changing work
  via the classification editor. Wiring the same refresh into that
  handler is a logical follow-up but not part of this spec.
- Detecting drift between `Thread.resolved*` and `analysisResult.order`
  outside of edits (e.g. when auto-sync re-resolves identifiers
  differently). The existing 10-min time gate in `maybeRefreshAnalysis`
  is the safety net for that.
- Generalising `buildRefineContext` for other LLM call-sites (e.g.
  `llm-draft`'s initial generation). The initial draft already has
  access to the full `SupportAnalysis` via the orchestrator; this
  helper is specifically for the Refine path where only a string can
  be passed.

## Open questions

None at this time. All design decisions resolved during brainstorming.

## File-by-file change summary

**New files:**
- `app/lib/support/refine-context.ts` — pure helper
- `app/lib/support/__tests__/refine-context.test.ts`
- `app/lib/__tests__/integration/refine-context-refresh.test.ts`

**Modified files:**
- `app/lib/support/inbox-actions.ts` — diff + refresh in
  `handleEditThreadIdentifiers`; pass `contextSummary` in `handleRefine`
- `app/lib/gmail/refine-draft.ts` — `contextSummary` param + prompt
  update
- `app/lib/metrics/definitions.ts` — new
  `refine_context_refresh_total` counter
- (Possibly) `app/routes/app.inbox.tsx` — Save button `loading` prop on
  identifier-edit submit, plus toast for the "error" outcome. Minimal
  diff, may already be handled by existing form state if the user has
  one.

## Acceptance criteria

1. After editing an identifier on a thread with an analyzed anchor, the
   inbox card for that thread reflects the new order / tracking within
   the same user interaction (no manual reload).
2. Refine with AI, asked to reference order or tracking facts, uses the
   currently-resolved data, not stale data.
3. Editing only `resolvedCustomerName` does not produce any Shopify or
   17track call.
4. An edit on a thread with no analyzed anchor succeeds and does not
   crash.
5. A Shopify / 17track outage during the refresh does not block the
   edit from being saved.
6. `/app/metrics` shows the `refine_context_refresh_total` counter
   incrementing with the right `outcome` label.
7. All new tests pass; existing tests still pass.

---

## Addendum (2026-05-15): Merge Regenerate + Refine into a single action

**Context for this addendum:** with edit-time auto-refresh shipped, the
analysis context is now reliably fresh whenever the user has touched the
thread. The 10-minute time-based refresh in `maybeRefreshAnalysis` becomes
a safety net for Shopify-side drift on idle threads, not a primary
freshness mechanism. That simplification opens the door to a UX cleanup:
unify "Regenerate draft" and "Refine with AI" into one affordance.

### What changes

**Behaviour:**

- A single action intent `generateDraft` handles both flows.
- The action branches on the trimmed `instructions` field:
  - `instructions.trim().length === 0` → redraft path (same as today's
    Regenerate button — re-emit the draft from the existing
    `analysisResult`, no LLM intent re-classification).
  - `instructions.trim().length > 0` → refine path (LLM rewrite using
    the user's instructions, with the `contextSummary` curated block
    from Tasks 1–6).

**Cost optimisation:** `maybeRefreshAnalysis` switches its engine from
`reanalyzeEmail` (full LLM pipeline) to `refreshThreadAnalysis({reclassifyIntent: false, reSearchOrder: true, refreshTracking: true})` (Shopify + 17track only, zero LLM tokens). The 10-minute staleness cutoff stays unchanged. This makes the safety-net call cheap enough that it can keep running on every redraft / refine click without hesitation.

**UI:**

- Two buttons collapse into one. The button sits next to the prompt
  input, not below it.
- Label is dynamic:
  - Empty / whitespace-only prompt → `Regenerate` (with a refresh icon).
  - Non-empty prompt → `Refine` (with a sparkles icon).
- Placeholder of the prompt input:
  `"Optional: tell the AI what to change (e.g. 'add the tracking link', 'be more formal')"`
- `Cmd/Ctrl + Enter` submits. `Enter` alone inserts a newline (standard
  textarea behaviour).
- During the action: button shows the Polaris `loading` state (built-in
  spinner) and the label flips to `Regenerating…` or `Refining…`. Both
  the button and the input are disabled until the action returns.
- The existing "Regenerate" button and the standalone "Refine with AI"
  trigger are both removed.

**Wire-level:**

- New handler `handleGenerateDraft` in `app/lib/support/inbox-actions.ts`
  branches on `instructions.trim().length > 0` and delegates to
  `handleRefine` or `handleRedraft`. Both legacy handlers stay exported
  so any internal caller (if any) keeps working; the route action
  registers a new intent `generateDraft` for the merged UI.
- The two old route-action branches (`intent === "refine"` and
  `intent === "redraft"`) stay for now (no API consumer migration
  needed), but the UI stops emitting them.

### Non-goals (addendum)

- Removing the legacy `handleRefine` / `handleRedraft` exports. They
  remain so server-side callers (e.g. tests, future scripts) can still
  invoke either path directly. Pruning is deferred until we're sure no
  consumer relies on them.
- A formal A/B between the merged UI and the split UI. The split UI was
  always confusing — we trust the unification.

### Risks

- **Behavioural change for keyboard users.** Today `Enter` inside the
  Refine textarea may or may not submit depending on browser; we
  explicitly standardise on `Cmd/Ctrl + Enter` to submit. Document this
  in the placeholder hint.
- **Quota impact.** Both redraft and refine consume one draft-quota
  unit. Behaviour unchanged from today — neither was free.
- **Accidental submits with an empty prompt.** The label flip
  (`Regenerate` vs `Refine`) makes the user aware before they click, and
  the dedicated regenerate path is exactly what they want anyway.

### Acceptance criteria (addendum)

A. Clicking the merged button with an empty prompt produces the same
   draft `app/lib/gmail/pipeline.ts:redraftEmail` would produce today.
B. Clicking the merged button with a non-empty prompt produces the same
   draft `refineDraft` would produce today, including the
   `contextSummary` block from Tasks 1–6.
C. The Polaris `loading` state shows for the duration of the action.
   The button is disabled while loading.
D. `Cmd/Ctrl + Enter` in the textarea submits the form.
E. `maybeRefreshAnalysis` no longer issues any LLM call (verify by
   reading the call path; it should bottom out at `refreshThreadAnalysis`).
F. Existing `handleRefine` and `handleRedraft` exports stay callable.
G. All new tests pass; existing tests still pass.
