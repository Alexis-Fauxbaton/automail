# Open Technical Debt — automail

Last updated: 2026-05-07. Three fix passes completed (see git log). This file lists **only items that are still open**. Fixed items are not listed here — check the commit log (`fix(audit):` prefix) for what was resolved.

---

## Requires DB migration (do not fix without a migration plan)

### DB-H2 — Session.accessToken / refreshToken stored in plaintext
**File**: [prisma/schema.prisma:24](prisma/schema.prisma#L24), Shopify Prisma session adapter  
**Why open**: The Shopify adapter writes tokens directly. Encrypting them requires a migration, a key-rotation plan, and adapter wrapping. The `// encrypted` comment in the schema is misleading — no encryption is applied.  
**Fix**: Wrap the Prisma session adapter with AES-256-GCM read/write hooks (same key as `GMAIL_TOKEN_SECRET`). Add migration to re-encrypt existing rows.

### DB-M2 — LlmCallLog.threadId stores raw provider ID, not canonical Thread.id
**File**: [prisma/schema.prisma:296](prisma/schema.prisma#L296), [app/lib/gmail/pipeline.ts:1326](app/lib/gmail/pipeline.ts#L1326)  
**Why open**: Cost aggregation per canonical thread is wrong for Zoho split-threads. Renaming requires a migration and backfill.  
**Fix**: Rename to `canonicalThreadId`, add FK `Thread? @relation(fields: [canonicalThreadId], references: [id], onDelete: SetNull)`, update all write sites.

---

## Database — missing indexes (safe to add in a new migration)

### DB-M1 — No standalone index on IncomingEmail.canonicalThreadId
**File**: [prisma/schema.prisma:218](prisma/schema.prisma#L218)  
Only `@@index([canonicalThreadId, receivedAt])` exists. Single-column lookups (`WHERE canonicalThreadId = ?`) scan the composite index inefficiently.  
**Fix**: Add `@@index([canonicalThreadId])`.

### DB-L2 — IncomingEmail prior-contact query loads all outgoing emails per page load
**File**: [app/lib/support/prior-contact.ts](app/lib/support/prior-contact.ts) (extracted from loader)  
`findMany({ where: { shop, processingStatus: "outgoing" } })` with no `take`. An established shop with 20 000 outgoing emails loads all of them on every inbox page load + every 10s revalidation.  
**Fix**: Materialise prior-contact flags onto `Thread` (boolean + lastReplyAt), or compute via single SQL `groupBy`. This is the most impactful loader perf issue still open.

### DB-L5 — No index on Thread.resolvedEmail / Thread.resolvedOrderNumber
**File**: [prisma/schema.prisma:137](prisma/schema.prisma#L137)  
Both fields are written by manual classification and read by the prior-contact module. No index means full `Thread` table scan per shop when filtering.  
**Fix**: Add `@@index([shop, resolvedEmail])` and `@@index([shop, resolvedOrderNumber])`.

### DB-new — No partial unique index preventing two running SyncJobs for same shop
**File**: [prisma/schema.prisma:364](prisma/schema.prisma#L364), [app/lib/mail/auto-sync.ts:48](app/lib/mail/auto-sync.ts#L48)  
Process-local `inFlight` + `FOR UPDATE SKIP LOCKED` are correct but provide no DB-level guarantee. After a process crash the zombie reclaim takes 30 min.  
**Fix**: `CREATE UNIQUE INDEX ON "SyncJob"(shop) WHERE status = 'running'`.

---

## Performance

### PERF-H3 — Inbox loader ships full bodyHtml + analysisResult for 500 emails
**File**: [app/routes/app.inbox.tsx:53](app/routes/app.inbox.tsx#L53)  
`prisma.incomingEmail.findMany` has no `select` clause. Serialising 500 full email bodies + raw JSON analysis on every page load + every 10s revalidation is the largest network payload issue.  
**Fix**: Add a `select` that excludes `bodyHtml`, `bodyText`, `errorMessage` from the list query. Fetch those only for the active thread (lazy on click).

### PERF-H5 — Prior-contact computation O(T·A·R) with no materialised columns
**File**: [app/lib/support/prior-contact.ts](app/lib/support/prior-contact.ts)  
Extraction is done (ARCH-M1 fixed), but the underlying data model still requires loading all outgoing emails and scanning them in Node. See DB-L2 above.

### PERF-H6 — No rate limiting on 17track / carrier fetchPage calls
**File**: [app/lib/support/tracking/adapters/seventeen-track.ts:227](app/lib/support/tracking/adapters/seventeen-track.ts#L227), [app/lib/support/crawl/context-crawler.ts:311](app/lib/support/crawl/context-crawler.ts#L311)  
No per-shop token bucket and no DB-level TTL cache for tracking results. Heavy syncs can 429 the tracking provider.  
**Fix**: Token bucket at the module level; cache results in DB with a TTL column.

### PERF-M7 — logCall fires two DB writes per LLM call, fire-and-forget
**File**: [app/lib/llm/client.ts:107](app/lib/llm/client.ts#L107)  
Every `trackedChatCompletion` creates 2 `LlmCallLog` rows (one to capture start, one to update with cost). No batching or queue.  
**Fix**: Collapse into one write (upsert), or batch in a short-lived queue flushed every 1s.

### PERF-DB — backfillResolvedIntents loads all resolved/no_reply_needed threads on every sync
**File**: [app/lib/gmail/pipeline.ts:528](app/lib/gmail/pipeline.ts#L528)  
Four unbounded `findMany` calls on every sync (pre- and post-Pass-1). For a shop with 5000 resolved threads, all 5000 IDs are loaded into Node memory twice per sync even though only 200 are processed.  
**Fix**: Add `take: 200` on the first three queries to match the processing cap.

### PERF-DB2 — enqueueRecomputeIfNeeded full-table groupBy without partial index
**File**: [app/lib/mail/auto-sync.ts:184](app/lib/mail/auto-sync.ts#L184)  
Cross-shop `groupBy` over `Thread` where `operationalStateUpdatedAt IS NULL` on every 60s tick. The existing composite index leads on `shop`, not on the predicate.  
**Fix**: Add partial index `(shop) WHERE "operationalState" = 'open' AND "operationalStateUpdatedAt" IS NULL`, or add `MailConnection.hasUncomputedThreads` boolean.

### PERF-DB3 — recomputeAllOpenThreads per-thread N+1 queries remain
**File**: [app/lib/support/thread-state.ts:398](app/lib/support/thread-state.ts#L398)  
Cursor pagination added (PARTIALLY FIXED) but each `recomputeThreadState` call still issues 3+ DB queries per thread (inbox emails, outgoing check, state write). No batch-fetch of thread data.  
**Fix**: Pre-fetch thread email aggregates in bulk before the per-thread recompute loop.

---

## Security

### SEC-M5 — No global HTTP security headers
**File**: [app/entry.server.tsx:19](app/entry.server.tsx#L19)  
Only attachment routes set `X-Content-Type-Options: nosniff`. No global CSP, no `Referrer-Policy`. Embedded Shopify apps cannot use `X-Frame-Options: DENY` but a `frame-ancestors` CSP scoped to `*.myshopify.com` and `*.shopify.com` is appropriate.  
**Fix**: Set security headers in `entry.server.tsx`'s response handler.

### SEC-L2 — No per-shop rate limiting on LLM endpoints
**File**: [app/routes/app.inbox.tsx](app/routes/app.inbox.tsx) — `reanalyze`, `refine`, `redraft` intents  
Manual-trigger actions accept unlimited requests. A fast-clicking merchant (or a compromised session) can run hundreds of OpenAI calls.  
**Fix**: Token bucket per shop stored in DB or Redis; return 429 with Retry-After.

---

## Code quality

### QA-M1 — JSON.parse without schema validation (Zod)
**Files**: [app/lib/gmail/pipeline.ts:1300](app/lib/gmail/pipeline.ts#L1300), [app/lib/support/refresh-stale-analyses.ts:91](app/lib/support/refresh-stale-analyses.ts#L91), [app/lib/support/refresh-thread-analysis.ts:76](app/lib/support/refresh-thread-analysis.ts#L76)  
`try/catch` added around `JSON.parse` (partially fixed) but parsed value is not validated against `SupportAnalysis` shape. A corrupt DB row returns a partial object silently.  
**Fix**: Extract `parseAnalysisResult(json: string): SupportAnalysis` with Zod `safeParse`.

### QA-M2 — DB enum casts without runtime validation
**File**: [app/lib/support/thread-state.ts:237](app/lib/support/thread-state.ts#L237)  
`as SupportNature`, `as OperationalState`, etc. No `parseSupportNature()` guard.  
**Fix**: Add parse helpers that throw on unknown values.

### QA-M3 — classifyEmail swallows non-429 errors → "incertain"
**File**: [app/lib/gmail/classifier.ts:124](app/lib/gmail/classifier.ts#L124)  
Re-throws 429s but returns `"incertain"` for everything else. A malformed prompt or quota exhaustion looks like a legitimate low-confidence classification.  
**Fix**: Use `err.status === 429` (not string match); log and propagate other errors.

### QA-L4 — Dynamic `await import()` still in inbox route
**File**: [app/routes/app.inbox.tsx](app/routes/app.inbox.tsx) — several action handlers (moved to inbox-actions.ts)  
`pipeline.ts` fixed; check inbox-actions.ts for any remaining `await import(...)` call sites.

### QA-L5 — `void customerEmails` lint suppression
**File**: [app/lib/gmail/pipeline.ts:1071](app/lib/gmail/pipeline.ts#L1071)  
Fire-and-forget cache refresh with no error boundary.

### ARCH-M4 — customers.ts hard-capped at 250 Shopify customers
**File**: [app/lib/gmail/customers.ts:28](app/lib/gmail/customers.ts#L28)  
`variables: { first: 250 }` with no cursor pagination. Shops with > 250 customers get silent truncation on prior-contact lookup.  
**Fix**: Paginate with Shopify cursor until `pageInfo.hasNextPage` is false.

### ARCH-L3 — inFlight / runningShops brittle under process crash
**File**: [app/lib/mail/auto-sync.ts:47](app/lib/mail/auto-sync.ts#L47)  
Module-level state is lost on crash. Recovery relies on 30-min zombie reclaim. See also DB-new (partial unique index) which provides DB-level protection.

---

## Tests still missing (test-quality)

| ID | What | File | Priority |
|----|------|------|----------|
| TEST-new | `E2E_AUTH_BYPASS` predicate not unit tested — extract to pure function | [app/shopify.server.ts:73](app/shopify.server.ts#L73) | High |
| TEST-new | `thread-resolver.ts` canonical merge logic has zero tests — cross-shop non-merge case critical | [app/lib/mail/thread-resolver.ts](app/lib/mail/thread-resolver.ts) | High |
| TEST-new | `reanalyzeEmail` manual-override path has no test | [app/lib/gmail/pipeline.ts:1248](app/lib/gmail/pipeline.ts#L1248) | High |
| TEST-new | Engaged-thread resync protection has no test | [app/routes/app.inbox.tsx:340](app/routes/app.inbox.tsx#L340) | High |
| TEST-M1 | Vacuous `toContain` on conflicting-intent test | [app/lib/support/__tests__/intent-classifier.test.ts:198](app/lib/support/__tests__/intent-classifier.test.ts#L198) | Medium |
| TEST-M2 | `matchedBy: "trackingNumber"` path untested | [app/lib/support/__tests__/confidence-scoring.test.ts](app/lib/support/__tests__/confidence-scoring.test.ts) | Medium |
| TEST-M3 | No two-shop isolation test in pipeline test | [app/lib/support/__tests__/pipeline.test.ts](app/lib/support/__tests__/pipeline.test.ts) | Medium |
| TEST-M4 | reply-draft cross-shop isolation not verified | [app/lib/__tests__/integration/reply-draft.test.ts](app/lib/__tests__/integration/reply-draft.test.ts) | Medium |
| TEST-M5 | Missing `waiting_customer` / `no_reply_needed` integration tests | [app/lib/__tests__/integration/thread-state-machine.test.ts](app/lib/__tests__/integration/thread-state-machine.test.ts) | Medium |
| TEST-M6 | Crawler-failure test never actually invokes `crawlContexts` | [app/lib/support/__tests__/pipeline.test.ts:50](app/lib/support/__tests__/pipeline.test.ts#L50) | Medium |
| TEST-M7 | No path-traversal test in storage.test.ts | [app/lib/attachments/__tests__/storage.test.ts](app/lib/attachments/__tests__/storage.test.ts) | Medium |
| TEST-new | Vacuous `toBeDefined()` on override `editedAt` markers | [app/lib/__tests__/integration/manual-classification-override.test.ts:194](app/lib/__tests__/integration/manual-classification-override.test.ts#L194) | Medium |
| TEST-new | `boot-cleanup.ts` + `classifier.ts` have zero unit tests | [app/lib/attachments/boot-cleanup.ts](app/lib/attachments/boot-cleanup.ts) | Medium |
| TEST-L1 | `findExpiredPaths` boundary case (maxAgeDays=0) untested | [app/lib/attachments/__tests__/cleanup.test.ts](app/lib/attachments/__tests__/cleanup.test.ts) | Low |
| TEST-L2 | Non-canonical `package_stuck` intent in response-draft test | [app/lib/support/__tests__/response-draft.test.ts:148](app/lib/support/__tests__/response-draft.test.ts#L148) | Low |
| TEST-L3 | Conflicting `replyNeeded + noReplyNeeded` flags untested | [app/lib/support/__tests__/thread-state.test.ts:53](app/lib/support/__tests__/thread-state.test.ts#L53) | Low |
| TEST-new | Coverage `include` restricted to `app/lib/support/**` — misleadingly high | [vitest.config.ts:11](vitest.config.ts#L11) | Low |
| TEST-new | Playwright iPhone capture spec has no assertions | [tests/e2e/iphone-layout-capture.spec.ts](tests/e2e/iphone-layout-capture.spec.ts) | Low |

---

## What was fixed in the 2026-05-07 pass

For the full list of fixes, see:
- Commit `ca5f952` — 33 files, security + isolation + perf + code quality
- Commit `82bfe4a` — SEC-H2 regex sanitizer → `sanitize-html`
- Commit `fe640a4` — ARCH-M2 inbox megaswitch refactor + ARCH-M1 prior-contact extraction

TECHNICAL_DEBT.md contains the original 2026-05-02 audit (93 findings) and the 2026-05-05 re-audit (73 new findings). That file is historical context; this file is the live tracker.
