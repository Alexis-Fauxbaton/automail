# Manual edit of thread classification (intents + order) — Design

Date: 2026-05-03
Status: Approved (brainstorm), pending user review of written spec

## Goal

Let a human support agent manually correct the classification produced by the LLM/orchestrator on a support thread:

- the list of detected support intents (primary + secondary), and
- the Shopify order linked to the thread.

Manual corrections must survive subsequent automatic refreshes. Tracking facts must keep refreshing normally so that delivery information stays current.

This spec also includes a related refactor of the auto-refresh ("stale analysis") logic, scoped together because the override semantics depend on it.

## Non-goals

- Editing classification from the inbox list (only from the thread detail view).
- Audit log / history of edits (only the latest override + timestamp is kept).
- Editing other analysis fields (tracking, identifiers, draft, warnings).
- Auto-regenerating the draft after a classification change.
- Auto-triggering an LLM call when the user clicks "Reset".

## User-facing behavior

### Entry point

In the thread detail view, next to the existing intent badges at the top, a small pencil button `✎` opens a modal titled "Modifier la classification".

If at least one field has an active manual override, a small "modified manually" indicator (icon + tooltip with date) is rendered next to the pencil.

### Modal contents

A single modal contains both editors:

**Intents** — the canonical list of `SUPPORT_INTENTS` (8 values). Already-selected intents are shown as chips in their current order. Each chip has:
- left/right arrows to reorder (no drag-and-drop, accessibility-friendly)
- a remove (`×`) button

A `+` button opens a picker of intents not yet selected. The first chip is the primary intent (the one written to `intent`).

Constraint: at least one intent must remain selected (validated client-side and server-side).

**Linked order** — a list of radio options:
- one radio per `orderCandidates` entry, labelled `#name — customerName — date`
- "Autre numéro de commande" with an input + "Rechercher" button
- "Aucune commande (détacher)"

If "Autre numéro" is chosen, clicking "Rechercher" calls a server action that runs the existing Shopify order search. On unique match, the radio updates with the found order's preview. On 0 or N matches, an inline error is shown and the modal cannot be saved on that path.

**Footer** — `Annuler` + `Enregistrer les modifications`. No auto-save: changes are committed only on save.

**Reset per field** — when a field has an active override, a small "Réinitialiser ce champ" link appears next to its editor. Clicking it inside the modal stages a reset for that field; saving the modal commits it.

### Reset semantics

Resetting a field clears the canonical value AND removes the override:

- Reset intents → `intent = "unknown"`, `intents = []`, `manualOverrides.intents` removed.
- Reset order → `order = null`, `manualOverrides.order` removed.

The next auto-refresh cycle (or a manual retry) will detect the empty value and recompute it. No LLM call is triggered by the reset itself.

### What does NOT happen on save

- The draft is not regenerated. The user must click the existing "Regénérer" / "Refine" buttons if they want a new draft based on the new classification.
- No background job is triggered.

## Auto-refresh refactor (scoped here)

Today, `refreshStaleAnalysesForShop` calls `reanalyzeEmail` on every active "to handle" thread whose `lastAnalyzedAt` is older than 1h. `reanalyzeEmail` re-runs the full pipeline: LLM intent classification, Shopify order search, tracking lookup, and draft generation. This is expensive on stable threads.

The new behavior splits per-field:

| Field | Refresh condition |
|---|---|
| Tracking | Always refresh (>1h stale) |
| Intent classification (LLM) | Only if `intent` is `"unknown"` or `intents` is empty |
| Order matching | Only if `order` is `null` |
| Draft | Unchanged — only regenerated on demand or via the existing >10-min refresh-before-refinement path |

The `manualOverrides` flag does NOT need to gate the refresh anymore: a field with an active override has a non-empty value, so the "only if empty" condition naturally protects it. The flag remains, but only as UI metadata (badge + tooltip).

### Implementation strategy

`reanalyzeEmail` today is monolithic. Rather than refactoring it into N independent functions in the same chantier (risky), we introduce a thinner helper:

```ts
refreshThreadAnalysis(emailId, admin, shop, options: {
  reclassifyIntent: boolean;
  reSearchOrder: boolean;
  refreshTracking: boolean;
}): Promise<void>
```

Internally it can still call into existing pipeline pieces, but it short-circuits the LLM/Shopify-search calls when the corresponding flag is false, reusing the previous values from the persisted analysis.

`refreshStaleAnalysesForShop` builds the options per email by reading the current analysis state:

```ts
{
  reclassifyIntent: !analysis.intent || analysis.intent === "unknown",
  reSearchOrder: !analysis.order,
  refreshTracking: true,
}
```

The on-demand pre-refinement path (10-min staleness) keeps its current full-refresh behavior — refining a draft is a deliberate action where freshness matters.

## Data model

Add to `SupportAnalysis` ([app/lib/support/types.ts](app/lib/support/types.ts)):

```ts
manualOverrides?: {
  intents?: { editedAt: string };  // ISO timestamp
  order?: { editedAt: string };
};
```

The override does not store the value (the canonical fields hold it). The override only records that the user explicitly set this field, for UI display and audit.

Persistence: `SupportAnalysis` is already serialized as JSON on the anchor incoming email's `analysisResult` column. No schema migration needed.

## Server action contract

A new action discriminator in `app/routes/app.inbox.tsx` (or a dedicated `app/routes/api.classification.tsx` if cleaner — to be decided in the plan):

```ts
{
  intent: "updateClassification";
  threadId: string;
  intents?: SupportIntent[];                    // null/absent = no change
  resetIntents?: boolean;                       // mutually exclusive with `intents`
  orderChange?:
    | { type: "candidate"; orderId: string }
    | { type: "search"; orderNumber: string }
    | { type: "detach" }
    | { type: "reset" };                        // alias of detach but also clears override
}
```

Server validation:
- `intents` non-empty if provided; every value ∈ `SUPPORT_INTENTS`; deduplicated preserving order.
- `orderChange.candidate` → orderId must exist in current `orderCandidates`; otherwise 400.
- `orderChange.search` → call existing `shopify-order-search`; require unique match; otherwise return a structured error the modal renders inline.
- All writes are scoped by `shop` (multi-tenant rule).

On success, the action returns the updated `SupportAnalysisExtended` so the client updates optimistically without revalidation race.

## Edge cases

1. Empty intents on save → blocked client-side, refused server-side.
2. Free-form order number with 0 matches → inline error in modal, save disabled until resolved.
3. Free-form order number with N>1 matches → inline error "Plusieurs commandes correspondent, choisissez un candidat ou précisez le numéro complet".
4. Thread without an analysis (never analyzed) → pencil button hidden.
5. Concurrent auto-sync: if a refresh runs while the user saves, the next refresh will see a non-empty intent/order and skip recomputation. No destructive race.
6. Detach when no order was attached → idempotent no-op server-side.
7. Re-editing a field that already has an override → overwrites the override's `editedAt`.
8. Reset both fields in one save → both cleared in one transaction.

## Tests

Unit (vitest):
- `app/lib/support/__tests__/refresh-thread-analysis.test.ts` (new) — flag matrix: each combination of `reclassifyIntent` / `reSearchOrder` / `refreshTracking` calls the right pieces and skips the others.
- `app/lib/support/__tests__/refresh-stale-analyses.test.ts` (existing or new) — given an analysis with non-empty intent and null order, only order is recomputed; given empty intent and existing order, only intent is recomputed; tracking always refreshed.
- `app/routes/__tests__/update-classification.test.ts` (new) — payload validation: empty intents refused, unknown intents refused, dedup preserves order, candidate id not in candidates refused.

Integration (existing patterns under `app/lib/__tests__/integration/`):
- Manual override survives an auto-refresh pass.
- Reset clears the field and the next refresh recomputes it.

UI: manual smoke test in the inbox at minimum. Playwright if existing harness covers it.

## File plan

| File | Change |
|---|---|
| [app/lib/support/types.ts](app/lib/support/types.ts) | Add `manualOverrides` to `SupportAnalysis` |
| `app/lib/support/refresh-thread-analysis.ts` | **New** — `refreshThreadAnalysis(emailId, admin, shop, options)` |
| [app/lib/support/refresh-stale-analyses.ts](app/lib/support/refresh-stale-analyses.ts) | Rewrite to compute per-thread flags and call `refreshThreadAnalysis` |
| [app/lib/gmail/pipeline.ts](app/lib/gmail/pipeline.ts) | Expose granular pieces consumed by `refreshThreadAnalysis` (no behavior change to `reanalyzeEmail` itself unless needed) |
| [app/routes/app.inbox.tsx](app/routes/app.inbox.tsx) | Add `updateClassification` action; route may delegate to a service module for clarity |
| `app/lib/support/manual-classification.ts` | **New** — server-side service for applying validated edits to the persisted analysis |
| [app/components/SupportAnalysisDisplay.tsx](app/components/SupportAnalysisDisplay.tsx) | Render pencil button + "modified manually" indicator next to badges |
| `app/components/ClassificationEditModal.tsx` | **New** — the modal |
| Unit/integration tests | New files listed above |
| i18n locales (`app/locales/`) | New keys: `classification.edit`, `classification.intents`, `classification.linkedOrder`, `classification.otherOrderNumber`, `classification.search`, `classification.detach`, `classification.reset`, `classification.manuallyEdited`, `classification.errors.*` |

## Risks and open questions

- **Pipeline decomposition**: splitting `reanalyzeEmail` into steps callable independently may surface coupling we haven't measured (e.g. tracking depends on order facts being available). The plan must verify this and either keep the order-resolution step always-on if needed, or reuse the previously-persisted `order` when `reSearchOrder=false`.
- **Reset UX**: a field reset only takes effect on the next refresh cycle (up to 1h). If user testing shows confusion, we can add an explicit "Recalculer maintenant" button in the modal that triggers a one-shot refresh of just that field. Out of scope for first iteration.
- **Order search ambiguity**: today's search may return multiple orders for a same number across customers. The modal's free-form path must communicate this clearly; copy to be finalized during implementation.
