# CLAUDE.md

> Last refreshed: 2026-05-24 — covers main + the in-flight billing branch (`feature/billing-per-conversation`) + multi-mailbox (shipped on feature/multi-mailbox). Update when major architecture changes ship.

## Project
Shopify app that helps human support agents answer customer emails faster.

Target: public distribution on the Shopify App Store, multi-tenant (multiple merchants / multiple shops).

Originally a single-store internal tool; now in the run-up to public App Store launch. Every new change must assume multi-shop.

## Product

The app pulls support emails from the merchant's Gmail / Zoho / Outlook inbox, classifies them, matches each to a Shopify order, fetches tracking, and pre-drafts a reply. The merchant reviews, edits, refines, and sends from their own mailbox (we never send mail for them).

This is a support copilot, not a full CRM.

Today the merchant:
- connects a mailbox via OAuth (Gmail / Zoho / Outlook)
- auto-sync pulls new mail every 5 min by default
- the pipeline classifies + analyses each thread automatically
- the merchant opens the inbox, reviews each thread, generates / refines a draft, copies to their mail client to send
- multiple mailboxes per shop are supported (up to 3 on Pro/Trial, 1 on Starter), managed at `/app/connections`
- the inbox aggregates threads from all connected mailboxes; each thread displays a `MailboxBadge` and the merchant can filter by mailbox via the `MailboxFilter` dropdown

## Supported support intents (canonical)

- `where_is_my_order` — Where is my order / order tracking request
- `delivery_delay` — Delivery delay / late delivery, including stuck tracking or no movement updates
- `marked_delivered_not_received` — Package marked as delivered but not received
- `damaged_product` — Product or item received damaged, broken, or unusable
- `order_error` — Wrong item, wrong size/color, missing item, or preparation mistake
- `refund_request` — Refund or reimbursement request
- `pre_purchase_question` — Question before buying or placing an order
- `unknown` — Unknown / manual review case

Analyses carry a primary `intent` plus an ordered `intents` array when several intents apply.

Intent is classified at the **thread level**, not per message. `buildThreadContext` concatenates all messages in the thread (labelled `--- Earlier message ---` / `--- Latest message ---`) and sends the full block to the LLM. The result is stored on the latest incoming email (the "semantic anchor") and displayed as the thread's badge.

## Out of scope

Do not build any of the following unless explicitly requested:
- Automatic email sending (the merchant always reviews + sends manually)
- Automatic refunds
- Automatic order edits
- Live chat
- WhatsApp / Instagram / omnichannel support
- Background agents doing autonomous actions
- Generic CRM abstractions

(Gmail / Zoho / Outlook are NOT out of scope — they shipped.)

## Core principle

Truth-seeking. The app must:
- never invent Shopify data
- never invent tracking status
- never invent a carrier
- never claim a refund was issued unless verified
- never claim a parcel is lost unless the source clearly supports it
- if data is missing, say it is missing
- if several possible orders exist, show ambiguity clearly
- if confidence is low, say so
- prefer structured data over scraping
- use scraping only as a fallback, behind a dedicated interface

## High-level architecture

**Stack:** TypeScript, React Router 7, Prisma (Postgres on Neon), Shopify Admin API, OpenAI SDK.

**Layout (key modules):**

```
app/
  routes/                      # React Router routes (loaders + actions)
    app.inbox.tsx              # the main support inbox UI
    app.dashboard.tsx          # KPIs, charts
    app.metrics.tsx            # internal operational dashboard (gated)
    metrics.tsx                # Prometheus /metrics endpoint
    healthz.tsx                # /healthz for platform probes
    webhooks.*.tsx             # Shopify webhooks (uninstall, redact, ...)
  lib/
    gmail/, zoho/, outlook/    # mail provider adapters + OAuth
    mail/                      # provider-agnostic ingest, sync, job queue
    support/                   # intent classifier, identifier extraction,
                               # order search, tracking, draft generation,
                               # thread state, manual classification,
                               # refine-context
    billing/                   # entitlements, plans, usage, quota,
                               # catchup zone, scheduled changes
    metrics/                   # in-process Prometheus registry +
                               # SQL-backed stats for the dashboard
    util/                      # circuit breaker, semaphore, with-timeout
    log/                       # createLogger + PII sanitizer
    onboarding/                # onboarding state + guard
    attachments/               # storage + cleanup
    net/                       # safe-fetch (SSRF guard)
    llm/                       # OpenAI client with semaphore + breaker
  components/
    billing/                   # quota banner, suspended banner,
                               # quota exceeded modal, top-bar counter
    onboarding/                # checklist + wizard steps
    ui/                        # shared bits (cards, icons, etc.)
    ClassificationEditModal.tsx
    SupportAnalysisDisplay.tsx
    RichDraftEditor.tsx
  i18n/                        # react-i18next setup + en/fr locales
prisma/                        # schema + migrations
```

UI stays thin: routes orchestrate server actions, JSX components render. Business logic lives in `app/lib/*`.

**Data model note (multi-mailbox):** `MailConnection.id` is the PK (a CUID); `shop` + `email` form a unique pair. Both `Thread` and `IncomingEmail` carry a required `mailConnectionId` FK with `onDelete: Cascade`, so disconnecting a mailbox atomically removes all its threads and emails. `SyncJob.mailConnectionId` is nullable — shop-wide job kinds (`recompute`, `reclassify`) intentionally omit it.

## Auto-sync pipeline

When a new message arrives in a connected mailbox, the worker runs three tiers (called Pass 1 / 2 / 3 in the code):

1. **Pass 1 — Tier 1 (free regex prefilter)**: ingest the message, run free heuristics (blacklist, store-domain check, customer-email match). Marks the row `ingested` if it passes, or `classified:filtered:<reason>` if not.
2. **Pass 2 — Tier 2 (LLM classifier)**: for threads touched by new messages, the **latest incoming** that passed Tier 1 gets sent to the LLM classifier with the full thread context. Outputs `support_client | probable_non_client | incertain`.
3. **Pass 2 — Tier 3 (full support analysis)**: only for `support_client`. Runs the orchestrator (`analyzeSupportEmail`): LLM parser (intent + identifiers), Shopify order search, tracking resolution + 17track, optional crawl, returns the rich `SupportAnalysis`. Draft generation is skipped during auto-sync; the merchant explicitly triggers it from the inbox.

Re-analysis triggers:
- a new customer message in an existing thread re-runs Tier 3 on the new latest;
- `refresh-stale-analyses` runs every minute and refreshes "active" threads when their analysis is older than 1h (lighter path: no LLM intent re-classify, just Shopify + 17track);
- `handleEditThreadIdentifiers` triggers a lightweight refresh on the anchor after the merchant edits identifiers (also no LLM intent re-classify).

`reanalyzeEmail` (full Tier 3 including LLM intent + draft) runs when the merchant clicks "Generate draft" on an unanalysed thread or explicitly clicks "Reset classification".

## Confidence model

- `high`  — exact order match + clear fulfillment/tracking state
- `medium` — likely order match but partial tracking info
- `low`   — ambiguous order match or insufficient data

## Draft generation

The merchant interacts with drafts through a single merged affordance (the legacy "Regenerate" + "Refine with AI" buttons were unified):

- Empty prompt → `handleRedraft` path: re-emit the draft from the existing `analysisResult` (no LLM intent re-run, just a fresh `generateLLMDraft` call).
- Non-empty prompt → `handleRefine` path: LLM rewrite with the merchant's instructions, fed a curated text block (`buildRefineContext` summarises order + tracking + key warnings).

Cmd/Ctrl+Enter submits. The button label flips between `Regenerate` / `Refine` (idle) and `Regenerating…` / `Refining…` (submitting). Native HTML `<button>` styled to match Polaris, dimensions locked (140 × 60 px) so the layout doesn't shift between labels.

Drafts must always:
- rely on verified facts first
- mention uncertainty when needed
- avoid overpromising
- avoid saying anything unsupported by data

## Shopify access rules

Only the minimum read scopes. See `shopify.app.toml`:
- `read_orders`
- `read_all_orders`
- `read_customers`
- `read_fulfillments`

No write scopes unless a feature explicitly requires them. App Store review penalises unjustified scopes.

Access to protected customer data (email, name, address, phone) requires Shopify's protected-customer-data configuration and approval. Any scope change must be reflected in the listing and the privacy policy.

## Public distribution requirements

The app targets the Shopify App Store. Non-negotiable compliance items:
- **Compliance webhooks** — `customers/data_request`, `customers/redact`, `shop/redact` registered + implemented ([app/routes/webhooks.*](app/routes/)).
- **Privacy policy** — public route at `/privacy` ([app/routes/privacy.tsx](app/routes/privacy.tsx)), kept in sync with what the app actually stores.
- **Support channel** — a real support email advertised in the listing + privacy policy.
- **Data minimization** — never store more customer data than strictly needed to draft a reply.
- **Multi-tenant isolation** — every query, job, cache, and log entry must be scoped per `shop`.

## Multi-tenant rules

Assume many shops in parallel:
- Every shop-scoped DB row has a `shop` column and is queried with it.
- Background jobs (sync, backfill, auto-sync, recompute, reclassify, analyze_thread) hold a per-shop lock via `SyncJob.shop NOT IN (running)` in the DB-level claim query. No global locks.
- The auto-sync loop itself uses a Postgres advisory lock (`pg_try_advisory_lock`) for leader election across replicas (`AUTOSYNC_LEADER_LOCK=off` to disable).
- No in-memory singleton may hold shop-scoped state across shops.
- Errors and metrics are tagged by `shop`.
- A bug in one shop must never stall sync for other shops.
- Every mailbox-scoped query MUST include both `shop` AND `mailConnectionId` in the WHERE clause to prevent cross-mailbox leaks within the same shop. Shop-wide aggregates (billing usage, GDPR webhooks, recompute/reclassify jobs) intentionally do not filter by mailbox.

## Tracking integration

- Provider resolution layer in `app/lib/support/tracking/provider-resolver.ts`.
- Each tracking source isolated in its own adapter (`tracking/adapters/*`).
- Prefer Shopify-provided tracking URLs or carrier data.
- Scraping is fallback-only, behind a dedicated interface (`tracking/crawl/`).
- Auto and manual mail sync refresh active support analyses/tracking when `lastAnalyzedAt` is missing or older than ~1h (adaptive — see `refresh-stale-analyses.ts:pickCutoffForAnalysis`).
- Draft regen / refine fall back to the same lightweight refresh (Shopify + 17track only, no LLM) inside `maybeRefreshAnalysis` when the analysis is older than 10 minutes.
- Do NOT refresh tracking for threads classified `non_support`, `resolved`, or `no_reply_needed`.
- The last analysis/tracking update time is visible next to the Tracking section title.
- 17track adaptive retries: a fulfillment whose last 17track attempt errored is refreshed after 10 min; `pending` after 5 min; `ok` / `skipped` follow the 1h cadence.
- A process-wide circuit breaker ([app/lib/support/tracking/seventeen-track-breaker.ts](app/lib/support/tracking/seventeen-track-breaker.ts)) suspends 17track calls for 15 min after 5 failures in any 10-min window, to protect the shared API quota across shops. Built on the generic [app/lib/util/circuit-breaker.ts](app/lib/util/circuit-breaker.ts).

## Billing

Shopify Billing API drives the subscription state. Server-side mirror in `app/lib/billing/`:
- `plans.ts` — static catalog (trial / starter / pro), prices, monthly quota, mailbox limit, advanced-dashboard flag.
- `entitlements.ts` — single facade `resolveEntitlements({ shop, admin })` that composes plan + trial + usage + mailbox count + internal-bypass flag. Always call this from loaders/actions; never bypass.
- `usage.ts` — per-period counters with atomic compare-and-swap reserve (Postgres-side raw SQL).
- `subscription.ts` — Shopify Billing API integration + 60-second cache.
- `catchup.ts` — `isWithin48hZone` helper for catch-up logic after suspension lifts.
- `scheduled-changes.ts` — downgrades scheduled for `effectiveAt`.

When quota is exhausted, `isSyncSuspended` flips true: auto-sync pauses for that shop (job is skipped), `SyncSuspendedBanner` shows in the inbox, user actions return `quotaExceeded`.

**Pricing model state (2026-05-15):** the in-flight `feature/billing-per-conversation` branch is switching the metered unit from "AI draft generated" to "support conversation analyzed" — refines and regenerations become free within a conversation. Once merged, `BillingUsage.draftsCount` becomes `analyzedThreadsCount`, `Plan.draftsPerMonth` becomes `analyzedThreadsPerMonth`, and the single billing-write site is `markThreadAnalyzedIfFirst` (atomic per-thread). Track in [docs/superpowers/specs/2026-05-14-billing-model-per-conversation-design.md](docs/superpowers/specs/2026-05-15-billing-model-per-conversation-design.md).

## Observability & operations

- **In-process metrics registry** ([app/lib/metrics/registry.ts](app/lib/metrics/registry.ts)) — counters, gauges, histograms, exposed via Prometheus text format on `GET /metrics` (gated by `METRICS_TOKEN` env var) and via JSON snapshot on the internal `/app/metrics` dashboard (gated by `ShopFlag.isInternal`).
- **OpenAI client** ([app/lib/llm/client.ts](app/lib/llm/client.ts)) — global semaphore (`OPENAI_MAX_CONCURRENT`, default 20), 429 retry-after handling, dedicated circuit breaker (8 non-429 failures in 5 min → opens for 2 min). Every call goes through `trackedChatCompletion` and is metricised.
- **Auto-sync** ([app/lib/mail/auto-sync.ts](app/lib/mail/auto-sync.ts)) — leader-lock election, configurable concurrency (`AUTOSYNC_CONCURRENCY`, default 4), per-job heartbeat to protect long-running jobs from zombie reclaim, lightweight entitlement check inside `runJob` rather than the scheduling loop.
- **Job queue** ([app/lib/mail/job-queue.ts](app/lib/mail/job-queue.ts)) — `SyncJob` rows, `FOR UPDATE SKIP LOCKED` claim, per-shop running lock, exponential backoff retries, zombie reclaim every tick. Job kinds: `sync | backfill | resync | recompute | reclassify | analyze_thread`.
- **/healthz** ([app/routes/healthz.tsx](app/routes/healthz.tsx)) — lightweight DB ping for platform probes.
- **Rate limit** ([app/lib/rate-limit.ts](app/lib/rate-limit.ts)) — Postgres-backed sliding-window per-shop / per-IP limits for action endpoints.
- **Structured logger** ([app/lib/log/logger.ts](app/lib/log/logger.ts)) — `createLogger({ shop, mod, ... })`. Replacing remaining `console.*` calls is ongoing (see runbook).

## Mail providers

Three connectors, each behind the same `MailClient` interface ([app/lib/mail/types.ts](app/lib/mail/types.ts)):
- **Gmail** ([app/lib/gmail/](app/lib/gmail/)) — Google OAuth, History API for incremental sync.
- **Zoho** ([app/lib/zoho/](app/lib/zoho/)) — Zoho Mail OAuth, timestamp-based incremental sync (no native History API).
- **Outlook** ([app/lib/outlook/](app/lib/outlook/)) — Microsoft Graph OAuth, delta token-based sync.

OAuth state is HMAC-signed and TTL-bound ([app/lib/mail/oauth-state.ts](app/lib/mail/oauth-state.ts)) — never trust the callback `state` blindly.

Outgoing-message detection is deterministic ([app/lib/mail/outgoing-detection.ts](app/lib/mail/outgoing-detection.ts) — uses `MailConnection.outgoingAliases`, a JSON array of emails the merchant can send from).

## Coding style

- TypeScript only.
- Prioritise readability over cleverness.
- Small focused modules.
- Avoid large monolithic files (a notable exception is `app/routes/app.inbox.tsx` which has grown — splits are welcome when touching nearby code).
- Avoid business logic inside UI components.
- Prefer pure functions where possible.
- Keep data contracts explicit (types for every domain object).
- Add comments only where they actually help, especially WHY (constraints, invariants, past incidents) rather than WHAT.

## Confidence boundaries & error handling

- Fail safely.
- Return clear error states.
- Distinguish: no match found vs ambiguous match vs Shopify API failure vs tracking lookup failure vs parsing failure.
- Never hide uncertainty behind a confident UI message.

## Testing

- Unit tests: `npm test` (vitest, no DB).
- Integration tests: `npm run test:integration` (vitest, real Postgres test DB via `DATABASE_URL`).
- E2E tests: `npm run test:e2e` (Playwright, scaffolded but rarely run — the auth bypass mode is documented in [app/shopify.server.ts](app/shopify.server.ts)).
- Typecheck: `npm run typecheck` (some pre-existing errors in `app.inbox.tsx` and a few scripts are tracked in `TECHNICAL_DEBT.md`; don't fix unrelated ones in your PR).

Test discipline:
- Multi-tenant tests use `TEST_SHOP = "integration-test.myshopify.com"` from `app/lib/__tests__/integration/helpers/db.ts`.
- Always assert shop scoping when testing handlers that take an `emailId` / `threadId`.
- Concurrency-sensitive code (counters, locks) needs explicit `Promise.all` racing tests, not just sequential coverage.

## Dependency policy

- Prefer built-in platform capabilities when reasonable.
- Avoid adding packages for trivial tasks.
- Keep dependencies minimal.
- If adding a dependency, explain why in the PR.

## Working style

If asked to implement something:
1. Inspect the existing scaffold first.
2. Propose the minimal implementation plan.
3. Identify files to create or modify.
4. Implement in small steps.
5. Explain meaningful changes.
6. Avoid broad refactors unless needed.

The brainstorming / writing-plans / subagent-driven-development skills are the standard workflow for non-trivial work — use them.

## Deferred runbooks

When relevant, follow these prepared step-by-step plans rather than re-deriving them:
- **Structured logging migration** (start the day a real log backend is wired — Better Stack / Datadog / Axiom / etc.): [docs/logging-migration.md](docs/logging-migration.md)
- **Reading the operational dashboard** (`/app/metrics` — what each section means, when to look, how to read breakers / pipeline health / DB pool): [docs/metrics-dashboard.md](docs/metrics-dashboard.md)

## Specs + plans archive

Active specs and implementation plans live under [docs/superpowers/](docs/superpowers/). The recent ones:
- 2026-05-02 Outlook integration
- 2026-05-07 Dashboard SAV v1 handoff
- 2026-05-14 Refine context auto-refresh (shipped)
- 2026-05-15 Billing model per conversation (in flight on `feature/billing-per-conversation`)
- 2026-05-23 Multi-mailbox per shop (shipped 2026-05-24 on `feature/multi-mailbox`)

Past technical debt sits in [TECHNICAL_DEBT.md](TECHNICAL_DEBT.md).

## What to avoid

- Over-engineering before the use case is concrete
- Generic CRM abstractions
- Adding background automation eagerly (we already have plenty)
- Mixing UI code and domain logic
- Using AI for facts that can be retrieved from Shopify
- Using scraping as the default strategy
- Touching the prod Neon DB from local dev (DATABASE_URL pointed at prod = trouble)
- Committing changes that span two unrelated concerns
