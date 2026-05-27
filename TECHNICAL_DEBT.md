# Technical Debt

Last updated: 2026-05-24
Reviewed by: 6-agent automated audit (security, code-quality, architecture, database, performance, test-quality) + 2026-05-14 production-hardening audit (multi-tenant / 10-shops concurrency focus — see "Production hardening" section at end)

## Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| Critical | 6     | 1     |
| High     | 21    | 0     |
| Medium   | 38    | 1     |
| Low      | 28    | 1     |
| **Total**| **93**| **3** |

---

## Critical (6)

- [ ] **[SEC-C1] Live production secrets in `.env`**
  - **File**: `.env`
  - **Description**: OpenAI key, Shopify API secret, Google OAuth client secret, Zoho client secret, Neon DB password, and Gmail token encryption key are in plaintext on disk. If this file was ever committed (even once), all secrets are permanently in git history.
  - **Fix**: Rotate all secrets immediately. Run `git log --all --full-history -- .env` to verify no commit history. Add `gitleaks` as a pre-commit hook. Use `.env.local` for real secrets and document the convention.
  - **Effort**: medium

- [ ] **[ARCH-C1] Non-atomic `deleteConnection` — orphaned email rows**
  - **File**: [app/lib/gmail/auth.ts](app/lib/gmail/auth.ts)
  - **Description**: `deleteConnection` deletes `MailConnection` then `incomingEmail` in two separate awaits. A crash between them leaves orphaned emails without a connection, corrupting state for a reconnecting shop.
  - **Fix**: Wrap both operations in `prisma.$transaction([...])`.
  - **Effort**: small

- [x] **[ARCH-C2] `deleteConnection` and `handleResync` leave orphan `Thread` rows** (RESOLVED 2026-05-24 in multi-mailbox refactor — feature/multi-mailbox)
  - **File**: [app/lib/gmail/auth.ts:160](app/lib/gmail/auth.ts#L160), [app/lib/support/inbox-actions.ts:114](app/lib/support/inbox-actions.ts#L114)
  - **Description**: Both paths wipe `IncomingEmail` but leave `Thread` rows behind. Over disconnect/reconnect cycles (especially when switching providers, e.g. Zoho → Outlook), the `Thread` table accumulates rows pointing to dead `lastMessageId`s. Observed on a fresh test mailbox: 18 real mails → 221 Thread rows, of which 207 had zero `IncomingEmail`. The dashboard now filters them out (`messages: { some: {} }` in `getCurrentThreadStates`, fix `31a7881`), but the rows still bloat the DB.
  - **Resolution**: `Thread.mailConnectionId` FK with `onDelete: Cascade` (schema commit `cccb687`) means that deleting a `MailConnection` row now atomically removes all associated `Thread`, `IncomingEmail`, and `SyncJob` rows via FK cascade. `deleteConnection` is scoped by `mailConnectionId`, not shop, so reconnecting a different mailbox to the same shop does not wipe unrelated threads. GDPR tombstones remain protected by a pre-delete filter in the GDPR handlers.
  - **Effort**: medium (couples with multi-mailbox migration)

- [ ] **[PERF-C1] Unbounded sequential API call loop in backfill**
  - **File**: [app/lib/mail/backfill.ts:64](app/lib/mail/backfill.ts#L64)
  - **Description**: Sequential `await` inside `for` loop over up to 2,000 messages — ~400s of serial I/O, hits Gmail quota, occupies the job slot for the entire duration and starves other shops.
  - **Fix**: Replace with bounded parallel batches using `p-limit(10)` and a configurable inter-batch delay (~50ms) to stay within Gmail's 250 quota units/s limit.
  - **Effort**: medium

- [ ] **[TEST-C1] No tests for `crypto.ts` (AES-256-GCM token encryption)**
  - **File**: [app/lib/gmail/crypto.ts](app/lib/gmail/crypto.ts)
  - **Description**: Every OAuth access/refresh token is encrypted with this module. Zero unit tests. A regression in IV packing, base64 encoding, or key-length check silently corrupts or leaks all stored credentials. The only indirect coverage mocks the module away entirely.
  - **Fix**: Add `app/lib/gmail/__tests__/crypto.test.ts` covering: round-trip, mismatched auth tag throws, wrong key length throws, invalid base64 throws, IV uniqueness across calls.
  - **Effort**: small

- [ ] **[TEST-C2] No tests for `oauth-state.ts` (OAuth CSRF defense)**
  - **File**: [app/lib/mail/oauth-state.ts](app/lib/mail/oauth-state.ts)
  - **Description**: The module's own comments describe the CSRF/account-takeover attack it prevents. Zero tests for tampered signature, expired TTL, wrong provider, non-myshopify domain, empty string, etc.
  - **Fix**: Add `app/lib/mail/__tests__/oauth-state.test.ts` covering: round trip, expired state, tampered signature/body, wrong provider, non-myshopify domain, nonce uniqueness.
  - **Effort**: small

- [ ] **[TEST-C3] No tests for `safe-fetch.ts` (SSRF guard)**
  - **File**: [app/lib/net/safe-fetch.ts](app/lib/net/safe-fetch.ts)
  - **Description**: `isPrivateIPv4` / `isPrivateIPv6` have no tests. A regression allows merchant-controlled URLs pointing to `169.254.169.254` or RFC1918 ranges to reach internal services.
  - **Fix**: Add `app/lib/net/__tests__/safe-fetch.test.ts`. Mock `dns/promises.lookup` and `fetch`. Test: HTTP rejected, public IP passes, `10.x.x.x` / `169.254.x.x` / `127.x.x.x` / `100.64.x.x` rejected, redirect to private IP rejected, redirect loop hits max-redirects.
  - **Effort**: medium

---

## High (21)

### Security

- [ ] **[SEC-H1] `allow-same-origin` on email iframe defeats sandbox**
  - **File**: [app/routes/app.inbox.tsx:1412](app/routes/app.inbox.tsx#L1412)
  - **Description**: `sandbox="allow-popups allow-same-origin"` — with `allow-same-origin`, script inside the iframe can access `window.parent`, parent cookies, localStorage, and DOM. Combined with the bypassable regex sanitizer, this is a practical XSS vector.
  - **Fix**: Remove `allow-same-origin`. Replace the `onLoad` height-measurement (which forces same-origin access) with a `postMessage` approach: inject `<script>window.onload=()=>window.parent.postMessage({h:document.body.scrollHeight},'*')</script>` into `srcDoc` and listen via `window.addEventListener('message', ...)`. Use `sandbox="allow-scripts allow-popups"` — `allow-scripts` without `allow-same-origin` runs in a null origin and cannot access the parent.
  - **Effort**: small

- [ ] **[SEC-H2] Regex HTML sanitizer is bypassable**
  - **File**: [app/lib/mail/sanitize-html.ts:30](app/lib/mail/sanitize-html.ts#L30)
  - **Description**: `sanitizeEmailHtml` uses regex replacements to strip `<script>`, `on*` handlers, and `javascript:` URLs. Known bypasses: nested tags, HTML entities in attribute names, `<base>` tag redirect, SVG `onload`, `data:text/html` in `src`/`href`, `<link>` external stylesheet with `behavior:`, `<template>` tags.
  - **Fix**: Replace with `sanitize-html` npm package or DOMPurify (via jsdom server-side). Use an allowlist of safe elements and attributes, not a blocklist.
  - **Effort**: small

- [ ] **[SEC-H3] Unvalidated provider MIME type reflected as `Content-Type` in attachment proxy**
  - **File**: [app/routes/api.incoming-attachment.tsx:55](app/routes/api.incoming-attachment.tsx#L55), [app/routes/api.zoho-inline.tsx:53](app/routes/api.zoho-inline.tsx#L53)
  - **Description**: `attachment.mimeType` (from the mail provider, stored without sanitization) is returned as the `Content-Type` header. A malicious email with `mimeType: "text/html"` would cause the browser to execute the attachment as HTML in the app's origin. `api.zoho-inline.tsx` has the same issue with the Zoho server's response `Content-Type`.
  - **Fix**: Allowlist permitted MIME types (e.g. `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `application/pdf`). For non-allowlisted types, force `Content-Disposition: attachment` and add `X-Content-Type-Options: nosniff` to all attachment responses.
  - **Effort**: small

### Code Quality

- [ ] **[QA-H1] `runJob` parameter type excludes `"reclassify"` — case unreachable via TypeScript**
  - **File**: [app/lib/mail/auto-sync.ts:156](app/lib/mail/auto-sync.ts#L156)
  - **Description**: `runJob`'s `kind` parameter is typed as `"sync" | "backfill" | "resync" | "recompute"` but handles `"reclassify"` in the switch — unreachable via the declared type. No `default` branch means an unexpected kind silently marks the job done without doing any work.
  - **Fix**: Use `SyncJobKind` (already exported from `job-queue.ts`) as the `kind` type. Add `default: throw new Error(\`Unknown job kind: \${job.kind}\`)`.
  - **Effort**: small

- [ ] **[QA-H2] `inFlight` counter has a race window allowing over-claiming**
  - **File**: [app/lib/mail/auto-sync.ts:126](app/lib/mail/auto-sync.ts#L126)
  - **Description**: `void runJob(job)` fires before `inFlight++` executes (the increment is the first line inside `runJob`, but there's an event loop yield before it). `drainJobQueue` can claim more jobs than `MAX_CONCURRENT` in this window.
  - **Fix**: Increment `inFlight` and add to `runningShops` synchronously in `drainJobQueue` before calling `void runJob(job, { skipBookkeeping: true })`.
  - **Effort**: medium

- [ ] **[QA-H3] `StructuredThreadState` object constructed twice verbatim**
  - **File**: [app/lib/support/thread-state.ts:256](app/lib/support/thread-state.ts#L256) and [`:297`](app/lib/support/thread-state.ts#L297)
  - **Description**: Nearly identical object literals in the normal path and the `wasManuallyResolved` branch. A new field added to the interface must be added in two places; a miss produces a stale snapshot silently.
  - **Fix**: Build the base object once, then spread-override the fields that differ in the resolved branch: `{ ...structured, awaitingCustomer: false, replyNeeded: false, operationalState: "resolved" }`.
  - **Effort**: small

### Architecture

- [ ] **[ARCH-H1] `recomputeThreadState` queries `incomingEmail` without `shop` filter**
  - **File**: [app/lib/support/thread-state.ts:163](app/lib/support/thread-state.ts#L163)
  - **Description**: The inner `findMany` for messages uses only `canonicalThreadId`. Violates CLAUDE.md multi-tenant rule. If a threading bug ever causes ID collision across shops, their messages become co-visible.
  - **Fix**: Add `shop` to the `where` clause. The `shop` is on the thread row loaded just above — pass it down.
  - **Effort**: small

- [ ] **[ARCH-H2] Same missing `shop` filter in `backfill.ts`**
  - **File**: [app/lib/mail/backfill.ts:139](app/lib/mail/backfill.ts#L139) and [`:275`](app/lib/mail/backfill.ts#L275)
  - **Description**: `runOpportunisticThreadBackfill` and `evaluateHistoryStatus` both fetch `incomingEmail` by `canonicalThreadId` alone. `thread.shop` is already in scope in both — just not passed as a predicate.
  - **Fix**: Add `shop` to both `where` clauses.
  - **Effort**: small

### Database

- [ ] **[DB-H1] Missing index on `Session.shop`**
  - **File**: [prisma/schema.prisma:17](prisma/schema.prisma#L17)
  - **Description**: `Session.shop` is queried on every authenticated request (Shopify session lookup). No index — every lookup is a full table scan.
  - **Fix**: Add `@@index([shop])` to the `Session` model and generate a migration.
  - **Effort**: small

- [ ] **[DB-H2] `Session.accessToken` / `refreshToken` stored in plaintext**
  - **File**: [prisma/schema.prisma:24](prisma/schema.prisma#L24)
  - **Description**: `MailConnection` explicitly encrypts tokens (AES-256-GCM via `crypto.ts`). `Session` stores Shopify access/refresh tokens in plaintext. A DB compromise exposes all OAuth tokens.
  - **Fix**: Apply the same encryption-at-rest approach on write/read. At minimum annotate the fields with `// encrypted` and add a test verifying the stored value is never the raw token.
  - **Effort**: medium

- [ ] **[DB-H3] N+1 in `recomputeAllOpenThreads` / `recomputeAllThreadsForShop`**
  - **File**: [app/lib/support/thread-state.ts:412](app/lib/support/thread-state.ts#L412)
  - **Description**: Loads all thread IDs with `findMany`, then sequentially calls `recomputeThreadState()` per thread (3+ DB queries each). For 1,000 threads: 3,000+ sequential round-trips.
  - **Fix**: Pre-fetch all threads with their messages in one batched query, or process in chunks of 50 with `Promise.all`.
  - **Effort**: medium

- [ ] **[DB-H4] Unbounded `findMany` in dashboard breakdown queries**
  - **File**: [app/lib/dashboard-stats.ts:183](app/lib/dashboard-stats.ts#L183)
  - **Description**: `getDailyBreakdown` and `getDailyActivityBreakdown` fetch every email in the selected period (90-day range = tens of thousands of rows) into Node.js memory. No `take`/cursor.
  - **Fix**: Push grouping into the DB with `prisma.$queryRaw` using `DATE_TRUNC`, or add a hard cap (`take: 10_000`) as an interim measure.
  - **Effort**: medium

### Performance

- [ ] **[PERF-H1] Sequential `getMessage` loop in pipeline Pass 1 (500 messages)**
  - **File**: [app/lib/gmail/pipeline.ts:151](app/lib/gmail/pipeline.ts#L151)
  - **Description**: Sequential `await ingestAndPrefilter()` per message ID — 500 network round-trips serialized.
  - **Fix**: Fan out in bounded batches (8–16 concurrent) using a concurrency limiter. Keep the cancellation check at batch boundaries.
  - **Effort**: medium

- [ ] **[PERF-H2] Sequential LLM classification loop (Pass 2) — no rate limiting**
  - **File**: [app/lib/gmail/pipeline.ts:191](app/lib/gmail/pipeline.ts#L191)
  - **Description**: Sequential `classifyAndDraft()` per thread with no rate limit. 100 threads fire 100–200 OpenAI calls in rapid succession, triggering 429 errors that surface as processing errors.
  - **Fix**: Add a rate-limit wrapper enforcing ~60 RPM. Use concurrency limiter of 3–5 parallel threads. Catch 429s and retry with exponential back-off.
  - **Effort**: medium

- [ ] **[PERF-H3] Inbox loader fetches 500 emails with full `bodyHtml` + `analysisResult` on every page load**
  - **File**: [app/routes/app.inbox.tsx:50](app/routes/app.inbox.tsx#L50)
  - **Description**: `bodyHtml` can be 50–200 KB per message; `analysisResult` 5–20 KB. Fetching all 500 on every load/revalidation transfers megabytes from DB on each request.
  - **Fix**: Exclude `bodyText`, `bodyHtml`, `analysisResult` from the list query. Load them lazily when a thread is selected via a separate fetcher call keyed to the selected thread ID.
  - **Effort**: medium

- [ ] **[PERF-H4] `fetchCustomerEmails` fetches all Shopify customers on every sync with no cache**
  - **File**: [app/lib/gmail/pipeline.ts:142](app/lib/gmail/pipeline.ts#L142)
  - **Description**: Every incremental sync (possibly processing 5–10 new messages) repeats a full customer enumeration via Shopify API. Currently hard-capped at 250 with no pagination.
  - **Fix**: Cache the customer email `Set` in-process keyed by `shop` with a 15–30 min TTL. Alternatively, query Shopify for specific email addresses on-demand during classification.
  - **Effort**: medium

- [ ] **[PERF-H5] Prior contact computation is O(T×A×R) inline in loader — blocks every page request**
  - **File**: [app/routes/app.inbox.tsx:128](app/routes/app.inbox.tsx#L128)
  - **Description**: Loads all outgoing emails for the shop, builds multiple Maps, iterates with nested loops and `Set` spreading on every page visit and revalidation.
  - **Fix**: Materialise `priorContactByAddress` / `priorContactByOrder` as boolean columns on `Thread`, updated by the thread-state recompute job. The loader reads pre-computed values with zero extra queries.
  - **Effort**: large

- [x] **[PERF-H6] No rate limiting on 17track API or carrier `fetchPage` calls** (partially mitigated 2026-05-14)
  - **File**: [app/lib/support/crawl/context-crawler.ts:311](app/lib/support/crawl/context-crawler.ts#L311), [app/lib/support/tracking/seventeen-track-breaker.ts](app/lib/support/tracking/seventeen-track-breaker.ts)
  - **Description**: Dozens of threads refreshed simultaneously during auto-sync can fire hundreds of requests to 17track within a single sync window, violating fair-use policy and generating IP bans.
  - **Mitigated 2026-05-14**: process-wide circuit breaker opens after 5 failures in any 10-min window and suspends 17track calls for 15 min across all shops. Adaptive retry cadence (`pickCutoffForAnalysis`) backs off naturally: pending → 5 min, error → 10 min, ok → 1h.
  - **Remaining**: no proactive token-bucket on the success path, and no DB-side caching of tracking responses across threads. Add when 17track quota becomes the binding constraint.
  - **Effort**: medium

## 17track resilience (resolved 2026-05-14)
- `last17trackAttempt` (`ok` / `pending` / `error` / `skipped`) + `last17trackAttemptAt` stamped on every `FulfillmentTrackingFacts` ([app/lib/support/tracking/tracking-service.ts](app/lib/support/tracking/tracking-service.ts)).
- `pickCutoffForAnalysis` drives adaptive retries inside `refreshStaleAnalysesForShop`: pending → 5 min, error → 10 min, ok / skipped → 1h ([app/lib/support/refresh-stale-analyses.ts](app/lib/support/refresh-stale-analyses.ts)).
- In-memory circuit breaker in [app/lib/support/tracking/seventeen-track-breaker.ts](app/lib/support/tracking/seventeen-track-breaker.ts) opens after 5 failures / 10 min and stays open for 15 min, shared across all shops (one API key, one quota).
- Known limits:
  - Breaker is per-process. A horizontally scaled deploy will have independent breakers per instance — acceptable until multi-instance is the norm.
  - Adaptive freshness reads the JSON blob in JS (not SQL). Cost: a few extra rows fetched per pass; bounded by `take: 20` in the Prisma query.

### Tests

- [ ] **[TEST-H1] No unit tests for `auth.ts` key functions**
  - **File**: [app/lib/gmail/auth.ts](app/lib/gmail/auth.ts)
  - **Description**: `getAuthUrl` must embed an HMAC-signed state (missing/unsigned state enables CSRF). `exchangeCodeForTokens` must throw on absent `access_token`. `deleteConnection` deletes emails for all shop users — a mis-scoped delete is a data leak. None of these paths are tested.
  - **Fix**: Add unit tests mocking `googleapis` and `prisma`.
  - **Effort**: medium

- [ ] **[TEST-H2] GDPR `customers/data_request` webhook has zero test coverage**
  - **File**: [app/lib/__tests__/integration/webhooks-gdpr.test.ts](app/lib/__tests__/integration/webhooks-gdpr.test.ts)
  - **Description**: Three GDPR webhooks are required for App Store compliance. The test file covers `customers/redact` and `shop/redact` but entirely omits `customers/data_request`.
  - **Fix**: Add a test case that mocks `authenticate.webhook` with topic `customers/data_request` and asserts HTTP 200 with no data modification.
  - **Effort**: small

- [ ] **[TEST-H3] `shop/redact` test does not verify `IncomingEmail` rows are deleted**
  - **File**: [app/lib/__tests__/integration/webhooks-gdpr.test.ts:111](app/lib/__tests__/integration/webhooks-gdpr.test.ts#L111)
  - **Description**: The test verifies `Thread`, `MailConnection`, and `SupportSettings` counts are 0 after redact, but never seeds or checks `IncomingEmail` rows. A missing `deleteMany` for emails would pass the test silently — a GDPR compliance gap.
  - **Fix**: Seed at least one `IncomingEmail` for `TEST_SHOP` and assert `incomingEmail.count === 0` after the handler runs.
  - **Effort**: small

---

## Medium (38)

### Security (5)

- [ ] **[SEC-M1] Debug route `api.zoho-image-debug.tsx` with hardcoded real folder ID — delete before production**
  - **File**: [app/routes/api.zoho-image-debug.tsx:46](app/routes/api.zoho-image-debug.tsx#L46)
  - **Fix**: Delete the file. If needed for dev, gate behind `NODE_ENV === "development"` and never hardcode real account IDs.
  - **Effort**: small

- [ ] **[SEC-M2] OAuth error page reflects raw `state` parameter into unescaped `<pre>` tag**
  - **File**: [app/routes/mail-auth.tsx:53](app/routes/mail-auth.tsx#L53)
  - **Fix**: HTML-escape `<`, `>`, `&`, `"`, `'` in `title` and `detail` before interpolation. Remove decoded payload from production error output.
  - **Effort**: small

- [ ] **[SEC-M3] Zoho inline proxy reflects provider `Content-Type` without allowlisting**
  - **File**: [app/routes/api.zoho-inline.tsx:53](app/routes/api.zoho-inline.tsx#L53)
  - **Fix**: Restrict to `image/jpeg`, `image/png`, `image/gif`, `image/webp`. Return 415 for anything else. Add `X-Content-Type-Options: nosniff`.
  - **Effort**: small

- [ ] **[SEC-M4] `LlmCallLog` written with `shop: ""` when shop is undefined**
  - **File**: [app/lib/llm/client.ts:123](app/lib/llm/client.ts#L123)
  - **Fix**: Make `shop` non-optional in `TrackedCallContext`. Skip writing the row if shop is unavailable, or use a clear sentinel. Violates CLAUDE.md rule: "every DB row must be scoped per shop."
  - **Effort**: small

- [ ] **[SEC-M5] No HTTP security headers on any route (CSP, X-Content-Type-Options, X-Frame-Options)**
  - **File**: [app/routes/mail-auth.tsx:25](app/routes/mail-auth.tsx#L25) (and globally)
  - **Fix**: Add `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` to `errorPage` responses. Add global middleware in the React Router entry point for all responses.
  - **Effort**: small

### Code Quality (7)

- [ ] **[QA-M1] `JSON.parse(record.analysisResult)` with no schema validation in `redraftEmail`**
  - **File**: [app/lib/gmail/pipeline.ts:980](app/lib/gmail/pipeline.ts#L980)
  - **Fix**: Add a guard after parsing: `if (!raw || typeof raw.intent !== "string") throw new Error("Malformed analysis — run Refresh first")`. Or define a `parseAnalysisResult()` helper.
  - **Effort**: small

- [ ] **[QA-M2] DB enum casts without runtime validation (`as SupportNature`, `as OperationalState`)**
  - **File**: [app/lib/support/thread-state.ts:238](app/lib/support/thread-state.ts#L238)
  - **Fix**: Add `parseSupportNature(v)` / `parseOperationalState(v)` guard functions that return defaults for invalid values.
  - **Effort**: medium

- [ ] **[QA-M3] `classifyEmail` swallows all errors with a single catch — LLM outages invisible**
  - **File**: [app/lib/gmail/classifier.ts:123](app/lib/gmail/classifier.ts#L123)
  - **Fix**: Distinguish transient/rate-limit errors (re-throw for job queue retry) from parsing failures (return `"incertain"` with a log).
  - **Effort**: medium

- [ ] **[QA-M4] `persistEmailAttachments` short-circuits on existing count — partial failures can't recover**
  - **File**: [app/lib/gmail/pipeline.ts:237](app/lib/gmail/pipeline.ts#L237)
  - **Fix**: Remove the pre-check. Rely on `skipDuplicates: true` in `createMany`. Add unique constraint on `(emailId, fileName, sizeBytes)` if missing.
  - **Effort**: small

- [ ] **[QA-M5] `markJobFailed` issues an extra `findUnique` to read `attempts` — value already known**
  - **File**: [app/lib/mail/job-queue.ts:148](app/lib/mail/job-queue.ts#L148)
  - **Fix**: Accept `attempts` as a parameter (already known by the caller from `claimNextJob`'s return value).
  - **Effort**: small

- [ ] **[QA-M6] `MailMessage.attachments` optional but inconsistently treated — synthetic messages skip the field**
  - **File**: [app/lib/mail/types.ts:37](app/lib/mail/types.ts#L37)
  - **Fix**: Make `attachments` required, defaulting to `[]` in all constructors and providers.
  - **Effort**: small

- [ ] **[QA-M7] `recomputeAllOpenThreads` loads all thread IDs with no pagination — large shops risk memory pressure**
  - **File**: [app/lib/support/thread-state.ts:398](app/lib/support/thread-state.ts#L398)
  - **Fix**: Add cursor-based pagination (`take: 100`) or a hard cap to process in multiple job runs.
  - **Effort**: medium

### Architecture (4)

- [ ] **[ARCH-M1] 125 lines of prior-contact business logic inline in inbox loader — not independently testable**
  - **File**: [app/routes/app.inbox.tsx:121](app/routes/app.inbox.tsx#L121)
  - **Fix**: Extract to `app/lib/support/prior-contact.ts` exporting `getPriorContact(shop, canonicalIds)`.
  - **Effort**: medium

- [ ] **[ARCH-M2] Inbox action: 200-line megaswitch with 14 intents and direct `prisma.*` calls**
  - **File**: [app/routes/app.inbox.tsx:316](app/routes/app.inbox.tsx#L316)
  - **Fix**: Extract each major intent into a service function (e.g. `lib/mail/sync-actions.ts`, `lib/support/thread-actions.ts`). Route becomes a thin dispatcher.
  - **Effort**: medium

- [ ] **[ARCH-M3] `enqueueDuePeriodicSyncs` schedules jobs for shops with no valid Shopify session**
  - **File**: [app/lib/mail/auto-sync.ts:92](app/lib/mail/auto-sync.ts#L92)
  - **Fix**: Add a join/sub-query checking for existence of a valid `Session` row, or implement `shop/uninstalled` webhook to disable `MailConnection.autoSyncEnabled` on app removal.
  - **Effort**: medium

- [ ] **[ARCH-M4] `customers.ts` hard-capped at 250 customers — silent truncation for large shops**
  - **File**: [app/lib/gmail/customers.ts:3](app/lib/gmail/customers.ts#L3)
  - **Fix**: Implement cursor-based pagination using `pageInfo.hasNextPage` / `pageInfo.endCursor`, or switch to per-email on-demand Shopify customer lookup.
  - **Effort**: medium

### Database (7)

- [ ] **[DB-M1] Missing standalone index on `IncomingEmail.canonicalThreadId`**
  - **File**: [prisma/schema.prisma:212](prisma/schema.prisma#L212)
  - **Description**: Composite `[canonicalThreadId, receivedAt]` exists but single-column queries on `canonicalThreadId` alone (in `refreshThreadStats`, `recomputeThreadState`, etc.) won't use it.
  - **Fix**: Add `@@index([canonicalThreadId])`.
  - **Effort**: small

- [ ] **[DB-M2] `LlmCallLog.threadId` stores raw provider string, not canonical `Thread.id`**
  - **File**: [prisma/schema.prisma:292](prisma/schema.prisma#L292)
  - **Description**: Zoho split-threads have multiple provider thread IDs but one canonical `Thread.id`. Cost aggregation is wrong for split threads.
  - **Fix**: Rename to `canonicalThreadId`, update write sites to use `Thread.id`, optionally add FK with `onDelete: SetNull`.
  - **Effort**: medium

- [ ] **[DB-M3] N+1 in `refreshThreadStats` — two queries where one would do**
  - **File**: [app/lib/mail/thread-resolver.ts:192](app/lib/mail/thread-resolver.ts#L192)
  - **Fix**: Replace separate `aggregate` + `findFirst` with a single `findMany` selecting `{ id, receivedAt, createdAt }` and derive counts in JS.
  - **Effort**: small

- [ ] **[DB-M4] N+1 in `runOpportunisticThreadBackfill` — `localIds` fetched inside loop**
  - **File**: [app/lib/mail/backfill.ts:139](app/lib/mail/backfill.ts#L139)
  - **Fix**: Hoist `localIds` fetch outside the `thread.providerIds` loop — it's the same query on every iteration.
  - **Effort**: small

- [x] **[DB-M5] `enqueueDuePeriodicSyncs` loads all enabled shops every tick — no due-time filter in SQL** (RESOLVED 2026-05-24 in multi-mailbox refactor — feature/multi-mailbox)
  - **File**: [app/lib/mail/auto-sync.ts:93](app/lib/mail/auto-sync.ts#L93)
  - **Resolution**: Replaced the Prisma `findMany` with a raw SQL query that pushes the due-time filter into the DB: `WHERE "autoSyncEnabled" = true AND ("lastSyncAt" IS NULL OR "lastSyncAt" + ("autoSyncIntervalMinutes" * INTERVAL '1 minute') <= now)`. The `@@index([autoSyncEnabled, lastSyncAt])` index was added to `MailConnection` in the same schema migration, allowing the DB to efficiently filter without a full table scan.
  - **Effort**: small

- [ ] **[DB-M6] Data migration casts JSON without guarding malformed values**
  - **File**: [prisma/migrations/20260424180536_migrate_draft_reply_to_reply_draft/migration.sql:1](prisma/migrations/20260424180536_migrate_draft_reply_to_reply_draft/migration.sql)
  - **Fix**: Migration already ran — document it. Add a forward check in the next migration if bad data is found (verify with `SELECT count(*) FROM "IncomingEmail" WHERE "draftHistory" IS NOT NULL AND "draftHistory" != '' AND "draftHistory" !~ '^[\[{]'`).
  - **Effort**: small

- [ ] **[DB-M7] Cross-model join per email row in `getDailyBreakdown` without standalone index**
  - **File**: [app/lib/dashboard-stats.ts:184](app/lib/dashboard-stats.ts#L184)
  - **Fix**: Add standalone `@@index([canonicalThreadId])` (see DB-M1). For the dashboard query, consider denormalizing `thread.supportNature` onto `IncomingEmail` or computing in a single aggregated SQL query.
  - **Effort**: medium

### Performance (8)

- [ ] **[PERF-M1] `isCancelled` issues a DB query every 10 messages — 50 extra queries per 500-message sync**
  - **File**: [app/lib/gmail/pipeline.ts:262](app/lib/gmail/pipeline.ts#L262)
  - **Fix**: Cache result with a 15s TTL, or reduce check frequency to every 50 messages / once per batch boundary.
  - **Effort**: small

- [ ] **[PERF-M2] `enqueueRecomputeIfNeeded` runs full table `groupBy` every 60s tick**
  - **File**: [app/lib/mail/auto-sync.ts:145](app/lib/mail/auto-sync.ts#L145)
  - **Fix**: Add composite index `(operationalState, operationalStateUpdatedAt, shop)`, or track a per-shop `hasUncomputedThreads` flag on `MailConnection`.
  - **Effort**: medium

- [ ] **[PERF-M3] `pickThreadsForClassification` issues N sequential DB queries (2 per canonical thread)**
  - **File**: [app/lib/gmail/pipeline.ts:484](app/lib/gmail/pipeline.ts#L484)
  - **Fix**: Parallelise with `Promise.all(canonicalIds.map(...))` — per-thread logic is independent.
  - **Effort**: medium

- [ ] **[PERF-M4] `DraftBlock` debounce timer can fire after thread switch — overwrites new thread's draft**
  - **File**: [app/routes/app.inbox.tsx:1773](app/routes/app.inbox.tsx#L1773)
  - **Fix**: Add `useEffect(() => () => { clearTimeout(bodySaveTimer.current); clearTimeout(metaSaveTimer.current); }, [email.id])` to cancel pending saves on thread switch.
  - **Effort**: small

- [ ] **[PERF-M5] `groupByThread` and derived sorts run on every render without `useMemo`**
  - **File**: [app/routes/app.inbox.tsx:868](app/routes/app.inbox.tsx#L868)
  - **Fix**: Wrap in `useMemo` keyed on the `emails` array reference. Also memoize filtered/sorted thread lists derived from it.
  - **Effort**: small

- [ ] **[PERF-M6] Inbox loader runs two additional heavy queries sequentially after main 500-email fetch**
  - **File**: [app/routes/app.inbox.tsx:78](app/routes/app.inbox.tsx#L78)
  - **Fix**: Run the `Thread` query in parallel with the `analyzedPerThread` query using `Promise.all` (they are independent once `canonicalIds` is derived). Verify a covering index on `(shop, canonicalThreadId, receivedAt DESC)` for the `distinct` query.
  - **Effort**: medium

- [ ] **[PERF-M7] `logCall` issues two DB writes fire-and-forget on every LLM call — connection pool burst**
  - **File**: [app/lib/llm/client.ts:107](app/lib/llm/client.ts#L107)
  - **Fix**: Batch `LlmCallLog` writes via an in-memory queue flushing every 5s or at 20 entries. Defer cost-increment to a periodic rollup.
  - **Effort**: medium

- [ ] **[PERF-M8] `startAutoSyncLoop` module-level `started` flag unsafe under hot reload / clustering**
  - **File**: [app/lib/mail/auto-sync.ts:46](app/lib/mail/auto-sync.ts#L46)
  - **Fix**: Register a hot-reload cleanup hook in development. For multi-worker production, replace `setInterval` with an external cron trigger (pg_cron, Render cron job).
  - **Effort**: large

### Tests (7)

- [ ] **[TEST-M1] `intent-classifier.test.ts` — vacuous assertion on conflicting-intent test**
  - **File**: [app/lib/support/__tests__/intent-classifier.test.ts:192](app/lib/support/__tests__/intent-classifier.test.ts#L192)
  - **Fix**: Replace `expect(["marked_delivered_not_received", "refund_request"]).toContain(result)` with `expect(result).toBe("marked_delivered_not_received")` per the classifier's documented priority order.
  - **Effort**: small

- [ ] **[TEST-M2] `confidence-scoring.test.ts` — `matchedBy: "trackingNumber"` path untested**
  - **File**: [app/lib/support/__tests__/confidence-scoring.test.ts:53](app/lib/support/__tests__/confidence-scoring.test.ts#L53)
  - **Fix**: Add a test for `makeInput({ matchedBy: "trackingNumber", ... })` asserting `confidence === "medium"`.
  - **Effort**: small

- [ ] **[TEST-M3] `pipeline.test.ts` — no multi-tenant shop isolation test in orchestrator**
  - **File**: [app/lib/support/__tests__/pipeline.test.ts](app/lib/support/__tests__/pipeline.test.ts)
  - **Fix**: Add a test calling `analyzeSupportEmail` for two different shops and verifying results don't cross-contaminate.
  - **Effort**: medium

- [ ] **[TEST-M4] `reply-draft.test.ts` — cross-shop isolation of upsert never verified**
  - **File**: [app/lib/__tests__/integration/reply-draft.test.ts:40](app/lib/__tests__/integration/reply-draft.test.ts#L40)
  - **Fix**: Create drafts for two shops with the same `emailId` and verify each shop only sees its own draft.
  - **Effort**: small

- [ ] **[TEST-M5] `thread-state-machine.test.ts` — missing tests for `waiting_customer` and `no_reply_needed` states**
  - **File**: [app/lib/__tests__/integration/thread-state-machine.test.ts:26](app/lib/__tests__/integration/thread-state-machine.test.ts#L26)
  - **Fix**: Add DB integration tests for both states.
  - **Effort**: medium

- [ ] **[TEST-M6] `pipeline.test.ts` — crawler-failure test: `buildCrawlTasks` returns `[]` so rejection never fires**
  - **File**: [app/lib/support/__tests__/pipeline.test.ts:312](app/lib/support/__tests__/pipeline.test.ts#L312)
  - **Fix**: Mock `buildCrawlTasks` to return a non-empty list in the failure test. Add `expect(crawlContexts).toHaveBeenCalled()`.
  - **Effort**: small

- [ ] **[TEST-M7] `storage.test.ts` — no path traversal test**
  - **File**: [app/lib/attachments/__tests__/storage.test.ts](app/lib/attachments/__tests__/storage.test.ts)
  - **Fix**: Test `storage.save("../../etc", "passwd", file)` and verify the path stays inside the configured root.
  - **Effort**: small

---

## Low (28)

### Security (3)

- [ ] **[SEC-L1] `onLoad` height-measurement forces `allow-same-origin` (root cause of SEC-H1)**
  - **File**: [app/routes/app.inbox.tsx:1402](app/routes/app.inbox.tsx#L1402) — fixed by SEC-H1 fix.

- [ ] **[SEC-L2] No per-shop rate limiting on LLM / sync action endpoints**
  - **File**: [app/routes/app.inbox.tsx:362](app/routes/app.inbox.tsx#L362)
  - **Fix**: Use `SyncJob` table to enforce one active job per shop per kind. Cap `backfill` `days` param to 365. Add per-shop token budget in `SupportSettings`.
  - **Effort**: medium

- [ ] **[SEC-L3] OpenAI singleton architectural smell — will use wrong key if per-shop keys are introduced**
  - **File**: [app/lib/llm/client.ts:42](app/lib/llm/client.ts#L42)
  - **Fix**: Add a comment explicitly documenting the single-global-key assumption. Initialise eagerly at module load to eliminate the double-initialisation race.
  - **Effort**: small

### Code Quality (7)

- [ ] **[QA-L1] `domain` extracted twice from `msg.from` in `prefilterEmail`**
  - **File**: [app/lib/gmail/prefilter.ts:43,74](app/lib/gmail/prefilter.ts#L43)
  - **Fix**: Extract once as `senderDomain`; reuse for blacklist check.
  - **Effort**: small

- [ ] **[QA-L2] Parent-domain extraction logic duplicated between store-domain and blacklist checks**
  - **File**: [app/lib/gmail/prefilter.ts:50,81](app/lib/gmail/prefilter.ts#L50)
  - **Fix**: Extract `getParentDomain(domain: string): string | null` helper.
  - **Effort**: small

- [ ] **[QA-L3] `getStoreDomains()` rebuilds its `Set` on every call**
  - **File**: [app/lib/gmail/prefilter.ts:24](app/lib/gmail/prefilter.ts#L24)
  - **Fix**: Memoize at module scope: assign once on first call.
  - **Effort**: small

- [ ] **[QA-L4] Dynamic imports in `redraftEmail` / `reanalyzeEmail` — should be static top-level imports**
  - **File**: [app/lib/gmail/pipeline.ts:982,999](app/lib/gmail/pipeline.ts#L982)
  - **Fix**: Convert `await import(...)` to static imports at top of file.
  - **Effort**: small

- [ ] **[QA-L5] `void customerEmails` suppresses lint for an unused parameter**
  - **File**: [app/lib/gmail/pipeline.ts:695](app/lib/gmail/pipeline.ts#L695)
  - **Fix**: Remove the parameter from `classifyAndDraft` and its call sites if unused. Add a `// TODO:` comment if genuinely planned for future use.
  - **Effort**: small

- [ ] **[QA-L6] `refreshStaleAnalysesForShop` always returns `skipped: 0` — counter never incremented**
  - **File**: [app/lib/support/refresh-stale-analyses.ts:98](app/lib/support/refresh-stale-analyses.ts#L98) (approx)
  - **Fix**: Remove `skipped` from the return type and all callers, or implement the counter.
  - **Effort**: small

- [ ] **[QA-L7] `buildReplySubject` strips `Re:` but not `Fwd:` prefixes**
  - **File**: [app/lib/support/draft-subject.ts:2](app/lib/support/draft-subject.ts#L2)
  - **Fix**: `replace(/^((re|fwd?|fw):\s*)+/i, "").trim()` before prepending `Re: `.
  - **Effort**: small

### Architecture (3)

- [ ] **[ARCH-L1] `_refreshedEmailIds` is a module-level `Set` — never cleared on shop switch**
  - **File**: [app/routes/app.inbox.tsx:35](app/routes/app.inbox.tsx#L35)
  - **Fix**: Scope inside a React context or `useRef` on the inbox root, or prefix keys with the current `shop`.
  - **Effort**: small

- [ ] **[ARCH-L2] `enqueueDuePeriodicSyncs` outer `findMany` error not attributed per-shop**
  - **File**: [app/lib/mail/auto-sync.ts:92](app/lib/mail/auto-sync.ts#L92)
  - **Fix**: Wrap outer `findMany` in its own try/catch with a distinct error message indicating the full scheduler stalled vs. a single shop failing.
  - **Effort**: small

- [ ] **[ARCH-L3] `inFlight` / `runningShops` brittle under process crash — no self-healing**
  - **File**: [app/lib/mail/auto-sync.ts:46](app/lib/mail/auto-sync.ts#L46)
  - **Fix**: Document that these are intentionally process-local. Add a defensive reset on `process.uncaughtException`. For multi-worker, rely solely on the DB `SKIP LOCKED` fence.
  - **Effort**: small

### Database (7)

- [x] **[DB-L1] Missing index on `MailConnection.lastSyncAt`** (RESOLVED 2026-05-24 in multi-mailbox refactor — feature/multi-mailbox)
  - **File**: [prisma/schema.prisma:52](prisma/schema.prisma#L52)
  - **Resolution**: `@@index([autoSyncEnabled, lastSyncAt])` added to `MailConnection` in the multi-mailbox schema migration (`cccb687`). Covers both the due-sync scheduler query (see DB-M5) and the index listed in DB-M5's fix recommendation.
  - **Effort**: small

- [ ] **[DB-L2] `fetchCustomerEmails` hard-capped at 250 — silently truncates large shops**
  - **File**: [app/lib/gmail/customers.ts:18](app/lib/gmail/customers.ts#L18)
  - **Description**: Already covered by ARCH-M4; tracked here for DB perspective (paginate via cursor loop).
  - **Effort**: medium

- [ ] **[DB-L3] Redundant `findUniqueOrThrow` after `create` in `ingestHistoricalMessage`**
  - **File**: [app/lib/mail/backfill.ts:246](app/lib/mail/backfill.ts#L246)
  - **Fix**: Capture the return value of `create` directly: `const row = await prisma.incomingEmail.create({ data: { ... }, select: { id: true } })`.
  - **Effort**: small

- [ ] **[DB-L4] Redundant `getTrueLatestMessage` query — always `messages.at(-1)`**
  - **File**: [app/lib/support/thread-state.ts:254](app/lib/support/thread-state.ts#L254)
  - **Fix**: Replace `await getTrueLatestMessage(canonicalThreadId)` with `messages.at(-1) ?? null`.
  - **Effort**: small

- [ ] **[DB-L5] Missing indexes on `Thread.resolvedEmail` / `Thread.resolvedOrderNumber`**
  - **File**: [prisma/schema.prisma:94](prisma/schema.prisma#L94)
  - **Fix**: Add `@@index([shop, resolvedEmail])` and `@@index([shop, resolvedOrderNumber])` if these fields will be queried.
  - **Effort**: small

- [ ] **[DB-L6] `ThreadStateHistory` allows duplicate no-op transition rows**
  - **File**: [prisma/schema.prisma:310](prisma/schema.prisma#L310)
  - **Fix**: Skip writing a history row when `fromState === toState` in `recordStateTransition`.
  - **Effort**: small

- [ ] **[DB-L7] MD5-based synthetic IDs from migration mixed with CUID runtime IDs in `Thread.id`**
  - **File**: [prisma/migrations/20260421182210_add_canonical_threads/migration.sql:38](prisma/migrations/20260421182210_add_canonical_threads/migration.sql#L38)
  - **Fix**: No immediate action. Document that `Thread.id` values prefixed with `thr_` are legacy migration IDs; treat `Thread.id` as an opaque string throughout.
  - **Effort**: small

### Performance (3)

- [ ] **[PERF-L1] `buildCidMap` + `sanitizeEmailHtml` run on every render of `EmailMessageBlock`**
  - **File**: [app/routes/app.inbox.tsx:1437](app/routes/app.inbox.tsx#L1437)
  - **Fix**: Wrap both in `useMemo` keyed on `email.id` and `email.bodyHtml`.
  - **Effort**: small

- [ ] **[PERF-L2] `cachedClient` in `llm/client.ts` — double-initialisation race on concurrent first calls**
  - **File**: [app/lib/llm/client.ts:42](app/lib/llm/client.ts#L42)
  - **Fix**: Initialise eagerly at module load: `const cachedClient = process.env.OPENAI_API_KEY ? new OpenAI(...) : null;`.
  - **Effort**: small

- [ ] **[PERF-L3] Non-null assertion on `thread.operationalStateUpdatedAt` — fragile**
  - **File**: [app/lib/support/thread-state.ts:291](app/lib/support/thread-state.ts#L291)
  - **Fix**: Assign to a narrowed local `const resolvedTs = thread.operationalStateUpdatedAt` and narrow with `if (wasManuallyResolved && resolvedTs)`.
  - **Effort**: small

### Tests (5)

- [ ] **[TEST-L1] `cleanup.test.ts` — `findExpiredPaths` with `maxAgeDays = 0` not tested (boundary condition)**
  - **File**: [app/lib/attachments/__tests__/cleanup.test.ts:32](app/lib/attachments/__tests__/cleanup.test.ts#L32)
  - **Effort**: small

- [ ] **[TEST-L2] `response-draft.test.ts` tests non-canonical `"package_stuck"` intent — silent fallthrough**
  - **File**: [app/lib/support/__tests__/response-draft.test.ts:149](app/lib/support/__tests__/response-draft.test.ts#L149)
  - **Fix**: Remove the test or explicitly test that unknown intents map to a safe default and document the behavior.
  - **Effort**: small

- [ ] **[TEST-L3] `thread-state.test.ts` — `deriveOperationalState` with `replyNeeded: true` AND `noReplyNeeded: true` untested**
  - **File**: [app/lib/support/__tests__/thread-state.test.ts:53](app/lib/support/__tests__/thread-state.test.ts#L53)
  - **Fix**: Add a test for the conflict case and assert the expected priority.
  - **Effort**: small

- [ ] **[TEST-L4] `recomputeAllOpenThreads` passes `thread.id` without `shop` to `recomputeThreadState`**
  - **File**: [app/lib/support/thread-state.ts:405](app/lib/support/thread-state.ts#L405)
  - **Description**: Lower-risk because `shop` is recovered from the thread row inside `recomputeThreadState`, but the message sub-query gap (ARCH-H1) makes this a chain worth tracking.
  - **Effort**: small

- [ ] **[TEST-L5] `upsertReplyDraftBody` cross-shop isolation never verified in integration test**
  - **File**: [app/lib/__tests__/integration/reply-draft.test.ts:40](app/lib/__tests__/integration/reply-draft.test.ts#L40)
  - **Description**: Already covered by TEST-M4. Tracked here as a low-priority duplicate for completeness.
  - **Effort**: small

---

## Progress Tracking

### Critical
- [ ] SEC-C1 — Rotate live secrets in `.env`
- [ ] ARCH-C1 — Wrap `deleteConnection` in `prisma.$transaction`
- [ ] PERF-C1 — Bounded parallel batches in backfill loop
- [ ] TEST-C1 — Unit tests for `crypto.ts`
- [ ] TEST-C2 — Unit tests for `oauth-state.ts`
- [ ] TEST-C3 — Unit tests for `safe-fetch.ts`

### Quick wins (small effort, high/medium severity)
- [ ] SEC-H1 — Remove `allow-same-origin`, use `postMessage` for iframe height
- [ ] SEC-H2 — Replace regex sanitizer with `sanitize-html` / DOMPurify
- [ ] SEC-H3 — Allowlist MIME types in attachment proxies
- [ ] QA-H1 — Fix `runJob` kind type, add `default` branch
- [ ] QA-H3 — Deduplicate `StructuredThreadState` construction
- [ ] ARCH-H1 — Add `shop` to `incomingEmail` sub-query in `thread-state.ts`
- [ ] ARCH-H2 — Add `shop` to `incomingEmail` sub-queries in `backfill.ts`
- [ ] DB-H1 — Add `@@index([shop])` to `Session`
- [ ] DB-M1 — Add `@@index([canonicalThreadId])` to `IncomingEmail`
- [ ] DB-M3 — Merge `refreshThreadStats` two queries into one
- [ ] DB-M4 — Hoist `localIds` outside loop in backfill
- [x] DB-M5 — Push due-time filter into `enqueueDuePeriodicSyncs` query (resolved in feature/multi-mailbox)
- [ ] DB-L3 — Capture `create` return value; remove `findUniqueOrThrow`
- [ ] DB-L4 — Replace `getTrueLatestMessage` query with `messages.at(-1)`
- [ ] PERF-M1 — Cache `isCancelled` result with 15s TTL
- [ ] PERF-M4 — Cancel `DraftBlock` debounce timers on thread switch
- [ ] PERF-M5 — `useMemo` for `groupByThread`
- [ ] PERF-L1 — `useMemo` for `buildCidMap` + `sanitizeEmailHtml`
- [ ] SEC-M1 — Delete `api.zoho-image-debug.tsx`
- [ ] SEC-M2 — HTML-escape `errorPage` output
- [ ] SEC-M3 — Allowlist `Content-Type` in Zoho inline proxy
- [ ] TEST-H2 — Add `customers/data_request` webhook test
- [ ] TEST-H3 — Add `IncomingEmail` assertion to `shop/redact` test
- [ ] TEST-M6 — Fix crawler-failure test (non-empty `buildCrawlTasks`)

---

## Production hardening audit — 2026-05-14

Scope: prepare for public-distribution launch with ~10 shops syncing in
parallel. Focused on multi-tenant isolation, concurrency, rate limits,
error isolation between shops, webhook idempotence.

### Fixed in this pass (code)

- [x] **C2** — Move entitlement check from scheduling loop into per-job
      (`auto-sync.ts`). One shop's slow Shopify response no longer
      serialises scheduling for the others.
- [x] **C3** — Subscription cache TTL dropped from 5 min to 60 s
      (`billing/subscription.ts`). Caps revenue-integrity window after a
      downgrade on a peer worker.
- [x] **C4** — Postgres advisory-lock leader election for the auto-sync
      loop (`auto-sync.ts`). Disable via `AUTOSYNC_LEADER_LOCK=off`.
      Released on graceful shutdown and HMR dispose.
- [x] **H1** — Global OpenAI semaphore (`OPENAI_MAX_CONCURRENT`, default
      20) + 429 retry-after backoff in `trackedChatCompletion`
      (`llm/client.ts`). Stops cascading failures across shops under load.
- [x] **H2** — `gmail/customers` cache now sweeps expired entries before
      LRU eviction (no premature kick-out under churn) + exported
      `invalidateCustomerEmailsCache` wired into uninstall and shop/redact
      webhooks.
- [x] **H3** — Job-queue heartbeat (`heartbeatJob`) called every 2 min by
      the worker. Legitimate long jobs are no longer reclaimed as zombies
      by a peer worker.
- [x] **H4** — `customers/data_request` deduplicates exports within a
      5-min window so Shopify retries don't accumulate JSON files.
- [x] **H5** — `unauthenticated.admin(shop)` calls wrapped with
      `withTimeout(10s)` (`util/with-timeout.ts`). A hung Shopify auth
      lookup can no longer stall a worker indefinitely.
- [x] **M2** — `pruneOldRateLimitBuckets` bounded to 1000 rows × 5 batches
      per call so a backlog never holds a long DELETE lock.
- [x] **M3** — `pickThreadsForClassification` concurrency capped at 10
      so a sync touching hundreds of threads can't saturate the DB pool.
- [x] **O3** — `/healthz` route added (DB `SELECT 1`, JSON response, no
      auth). For platform health checks and uptime monitors.

Note: this audit also confirms several previously-listed items are
already implemented in the codebase (QA-H1, PERF-H4) — leaving them
in the legacy list for traceability.

### Must-do before launch (NOT code-fixable here)

- [ ] **C1** — Set `DATABASE_URL?connection_limit=20&pool_timeout=20` in
      the Render production environment. Default Prisma pool (1-CPU dyno
      = 3 connections) is too small for `AUTOSYNC_CONCURRENCY=4` + web
      requests + webhooks. Keep `AUTOSYNC_CONCURRENCY ≤ connection_limit / 4`.
      If a pooler becomes necessary, use pgBouncer in **session mode**
      (transaction mode breaks `FOR UPDATE SKIP LOCKED` in `claimNextJob`).
- [ ] **C4-followup** — On Render multi-instance deployments, verify that
      exactly one instance logs `[auto-sync] elected leader for this instance`.
      The `boot-cleanup` `WORKER_ID === "0"` gate also needs an explicit
      env var on Render or a switch to the same advisory-lock pattern
      (different lock key).
- [ ] **Single-process boot-cleanup / billing-backfill** — `runBootCleanup`
      and `backfillBillingShopFlags` run once per worker today. On a
      multi-instance deploy they'll run N times in parallel. Either
      consolidate behind the leader lock (cheap) or move to a one-shot
      migration script.

### Observability pass — 2026-05-14 (B.3 of the scaling plan)

Fixed in this pass:

- [x] **O4** — Generic circuit-breaker helper (`lib/util/circuit-breaker.ts`).
      17track breaker refactored to use it. New OpenAI breaker applied
      inside `trackedChatCompletion` (opens after 8 non-429 failures in
      any 5-min window, cools down for 2 min). 429s are NOT counted as
      breaker failures because they signal upstream-is-healthy
      back-pressure already handled by the semaphore + retry combo.
- [x] **O2 (partial)** — In-process metrics registry
      (`lib/metrics/registry.ts`) with counters, gauges and histograms.
      Prometheus text exposition + JSON snapshot supported. Instrumented:
      `auto_sync_jobs_total`, `auto_sync_job_duration_seconds`,
      `auto_sync_in_flight`, `auto_sync_leader`, `llm_calls_total`,
      `llm_tokens_total`, `llm_cost_usd_total`, `llm_duration_seconds`,
      `llm_semaphore_in_flight`, `llm_semaphore_queued`, `breaker_state`,
      `breaker_transitions_total`. SQL-backed cross-worker history in
      `lib/metrics/stats.ts` (jobs per shop, LLM cost per shop, pipeline
      health, DB pool).
- [x] **Dashboard** — `/app/metrics` page, gated by `ShopFlag.isInternal`
      (same pattern as `api.repair-zoho-images.tsx`). Renders the
      in-process metric snapshot side-by-side with the SQL stats. No
      auto-refresh — browser reload is the refresh model for the
      operator.
- [x] **/metrics endpoint** — Prometheus-format scrape, gated by a
      constant-time comparison against `METRICS_TOKEN`. Returns 404 when
      the env var is unset so the route is invisible in default
      deployments. Accepts `Authorization: Bearer <token>` or `?token=…`.
- [x] **Tests** — added concurrency / contention tests
      (`util/__tests__/concurrency.test.ts`), breaker cycle tests,
      `trackedChatCompletion` under load (50 concurrent → peak ≤ cap),
      heartbeat-vs-reclaim integration test (alive job survives, silent
      job is reclaimed), `/metrics` auth/format tests.

Deferred (intentional):

- [ ] **O1** — Replace remaining `console.*` calls with `createLogger`.
      Mechanical search-and-replace; defer until a logging backend
      actually needs structured fields (Datadog / Logflare). Today the
      Render log search is the consumer and plain console works.
- [ ] **Shopify Admin breaker** — Not added because failure cadence is
      per-shop (one merchant's expired token shouldn't trip the breaker
      for others). Revisit if a global Shopify outage actually happens.

### Refine context auto-refresh — 2026-05-15

Fixed in this pass:

- [x] **Edit-time refresh** — `handleEditThreadIdentifiers` now diffs
      incoming vs current values and, when anything other than the
      customer name changed, synchronously calls
      `refreshThreadAnalysis({reclassifyIntent: false, reSearchOrder, refreshTracking})`
      so the matched Shopify order and tracking data are up-to-date
      for the next read. Zero LLM cost.
- [x] **Refine context-aware** — `handleRefine` reloads
      `analysisResult` after the time-based safety refresh, builds a
      curated English text block via the new `buildRefineContext`
      helper (ORDER / TRACKING / WARNINGS sections with an allowlist
      filter on warning codes), and passes it to the OpenAI prompt.
      Refine no longer invents or contradicts the verified
      order/tracking facts.
- [x] **Metric** — `refine_context_refresh_total{shop,outcome}`
      (ok / skipped_noop / no_anchor / error) exposed on `/app/metrics`
      and `/metrics`.
- [x] **Merged Regenerate + Refine UI** — single prompt-aware action
      `intent="generateDraft"` routed through the new
      `handleGenerateDraft` wrapper. Empty prompt → redraft (no LLM
      rewrite). Non-empty → refine with curated context. Cmd/Ctrl+Enter
      submits. Polaris `loading` state + dynamic label
      (`Regenerate` / `Refine` / `Regenerating…` / `Refining…`).
      Textarea height locked to 60 px and button wrapper to
      `min-width: 120 px` so dimensions stay stable across label
      changes (verified end-to-end via Playwright).
- [x] **Cheaper safety net** — `maybeRefreshAnalysis` switched from
      `reanalyzeEmail` (1–2 LLM calls) to `refreshThreadAnalysis` with
      `reclassifyIntent: false` (0 LLM, Shopify + 17track only).

Out of scope (kept for later):

- `handleUpdateClassification` doesn't yet trigger the same refresh.
  Same pattern applies; a 1-task follow-up.
- Toast wording is reused across edit successes — could be split (no
  toast on noop, "context updated" toast on ok) if the UX warrants.
- Legacy `intent === "refine"` and `intent === "redraft"` route branches
  stay alongside `generateDraft`. Prune when nothing else calls them.

### Billing model — per analyzed conversation — 2026-05-15

Fixed in this pass:

- [x] **Schema migration** — `Thread.analyzedAt` added; backfilled
      from existing `analysisResult` so current shops are
      grandfathered. `BillingUsage.draftsCount` renamed to
      `analyzedThreadsCount` with current-period reset.
- [x] **`markThreadAnalyzedIfFirst` helper** — atomic
      `updateMany WHERE analyzedAt IS NULL` + `BillingUsage` upsert.
      Single billing-write site. Audited via two new metrics:
      `billing_analyzed_thread_counted_total` and
      `billing_analyzed_thread_skipped_total{reason}`.
- [x] **Tier 3 increment site wired** in `classifyAndDraft`,
      `backfillResolvedIntents.processThread`, and `reanalyzeEmail`.
- [x] **Refine/redraft don't charge** — `withDraftQuota` removed
      from `handleRefine` and `handleRedraft`. `canGenerateDraft`
      pre-check stays on `handleReanalyze` (which still triggers
      Tier 3 directly).
- [x] **Catch-up on classification change** — new
      `SyncJobKind: "analyze_thread"`. `handleMoveThread` and
      `handleUpdateClassification` enqueue when supportNature flips
      to support AND `analyzedAt` is null. Auto-sync runs Tier 3 with
      `skipDraft: true` and consumes 1 unit on first success.
- [x] **Plan names** — `draftsPerMonth` → `analyzedThreadsPerMonth`.
      Caps unchanged: 50 Starter / 500 Pro / Infinity Trial.
- [x] **i18n + UI** — "drafts" replaced by "conversations" in
      user-facing strings (en + fr).
- [x] **Test coverage** — 11 failure classes from the spec covered.
      Statement coverage >= 95 % on the billing-critical files.

Known follow-ups (subtle, not blocking):
- `__resetMetricsForTest` is incomplete: counter API closures
  captured at module-load time keep referencing the pre-reset
  registry. Workaround in `mark-thread-metrics.test.ts` uses
  baseline-delta assertions on unique shop labels. Fix the reset
  helper to also rebuild the closures, or stop calling `inc()`
  through captured references.

Operator follow-up:
- Send the soft-comm email to active paying shops explaining the
  change ("Now we count conversations instead of drafts; refines and
  regens are free").

Out of scope (kept for later):
- Manual drafting feature (separate spec; billing decoupling makes
  it a small follow-up PR).
- Soft overage / usage charges.
- Per-seat pricing.
- Refine-count cap (alerting instead, operator-driven).

### Deferred follow-ups

- [ ] **H6** — Per-thread advisory lock for user actions vs auto-sync.
      Today a user clicking "Refine" while auto-sync runs Tier 3 on the
      same thread can race on `analysisResult`/`replyDraft`; the second
      write wins. Add `pg_advisory_xact_lock(hashtext(canonicalThreadId))`
      inside `handleReanalyze` / `handleRedraft` / `handleRefine` and the
      orchestrator's Tier 3 phase, or a row-level `SELECT … FOR UPDATE`.
- [ ] **M1** — Move `customers/redact` into a background job. The
      `findMany` with six `contains` filters on `bodyText` etc. is OK
      under ~50k emails/shop but will blow Shopify's 5 s webhook budget
      past that. Enqueue `SyncJob(kind="redact-customer", params={email})`,
      ack immediately, process in the worker.
- [ ] **O1 / O2** — Observability:
      - Replace remaining `console.*` calls with structured `createLogger`
        (~80 % of files still use bare console).
      - Metrics: `auto_sync.duration_ms{shop,kind}`, `auto_sync.in_flight`,
        `job.failed_total{shop,kind}`, `llm.calls_total{shop,call_site}`,
        `llm.cost_usd_total`, `breaker.open_total{name}`,
        `openai.queue_depth`, `openai.in_flight`.
- [ ] **O4** — Process-global circuit breakers for OpenAI and Shopify
      Admin (mirror the 17track one). Add when metrics show repeat
      outages; over-engineering today.
