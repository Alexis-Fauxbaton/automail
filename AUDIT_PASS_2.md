# Audit Pass 2 — 2026-05-07

Second-pass multi-agent audit on top of `feat/dashboard-sav-v1`. Run on branch `audit/pass-2-findings`.

Methodology: 6 specialized agents (security, code-quality, performance, architecture, database, test-quality) reviewed the codebase a second time, focusing on areas missed or under-covered in Pass 1.

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 9     |
| Medium   | 35    |
| Low      | 35    |
| **Total**| **79**|

> Pass 1 audit remains in `TECHNICAL_DEBT.md` (93 items, mostly fixed on branch `fix/tech-debt`).

---

## High (9)

### Security (3)

- [ ] **[SEC2-H1] No rate limiting on expensive LLM endpoints**
  - **Files**: `app/routes/api.reply-draft.tsx`, `app/lib/support/orchestrator.ts`
  - **Description**: `/api/reply-draft` and the orchestrator have no per-shop or per-user rate limit. A compromised session could spam LLM draft generation, costing money. Combined with no input size limits, this is a financial DoS vector.
  - **Fix**: Sliding-window rate limit (e.g., 10 drafts per shop per hour) before `updateReplyDraftBody` and `trackedChatCompletion`. Store counters in Redis or DB.
  - **Effort**: large

- [ ] **[SEC2-H2] No size limits on LLM inputs — prompt-injection / cost attack**
  - **Files**: `app/lib/support/llm-parser.ts:66`, `app/lib/support/llm-draft.ts:337`
  - **Description**: Email subject/body are concatenated directly into the LLM prompt without truncation. A 10 MB malicious email (or attacker-crafted reply) generates a multi-dollar OpenAI bill per call.
  - **Fix**: Cap body at 50 KB before constructing prompt; truncate with a warning in the analysis.
  - **Effort**: small

- [ ] **[SEC2-H3] Webhook session-null path silently proceeds**
  - **Files**: `app/routes/webhooks.app.scopes_update.tsx:11`, `app/routes/webhooks.app.uninstalled.tsx:6`
  - **Description**: `if (session) { ... }` proceeds silently when session is null. A valid HMAC webhook with no matching session could land in a corrupted state without any signal.
  - **Fix**: Log a warning when session is null; do not silently no-op without a structured error path.
  - **Effort**: small

### Architecture (2)

- [ ] **[ARCH2-H1] Missing error contract on `MailClient` interface**
  - **File**: `app/lib/mail/types.ts:45-79`
  - **Description**: `getSyncCursor()` can return `null` (Zoho/Outlook); `listNewMessages` returns `latestCursor: null` for cursor-stale Zoho threads. Behavior is provider-specific but the interface doesn't document it. Callers in `pipeline.ts` handle staleness inconsistently.
  - **Fix**: Document the error/null contract in TSDoc; consider a discriminated result type `{ ok: true, ... } | { ok: false, reason }`.
  - **Effort**: medium

- [ ] **[ARCH2-H2] Outlook tokens stored unencrypted while Gmail/Zoho are encrypted**
  - **File**: `app/lib/outlook/auth.ts:36-79`
  - **Description**: `exchangeCodeForTokens()` returns plain `accessToken`/`refreshToken`. Gmail and Zoho both use the encrypt/decrypt wrapper from `gmail/crypto.ts`. Outlook refresh tokens are persisted plaintext.
  - **Fix**: Apply the same encryption pattern. Extract a shared `app/lib/mail/token-crypto.ts` so all three providers go through the same path.
  - **Effort**: medium

### Performance (2)

- [ ] **[PERF2-H1] HTML sanitization runs on every render of EmailMessageBlock**
  - **File**: `app/routes/app.inbox.tsx:1207-1208`
  - **Description**: `sanitizeEmailHtml()` is called inline in the component body — no memoization. With 500 emails and parent re-renders on every filter/sync, the sanitizer (sanitize-html parses each HTML body fully) runs O(emails × renders).
  - **Fix**: (1) Wrap `EmailMessageBlock` in `React.memo`; (2) Pre-compute sanitized HTML on the server (loader) and serialize, OR (3) `useMemo` keyed on `email.id`.
  - **Effort**: medium

- [ ] **[PERF2-H2] No memoization on `ThreadCard` list items**
  - **File**: `app/routes/app.inbox.tsx:2669-2690`
  - **Description**: `ThreadCard` is rendered in `.map()` without `React.memo`. Inline `onSelect`, `onOrderClick`, `onFilterClick` callbacks are re-created every render, defeating any future memo. With 100+ visible threads, every parent state change re-renders all cards.
  - **Fix**: `React.memo(ThreadCard)` + `useCallback` for the handlers.
  - **Effort**: medium

### Tests (1)

- [ ] **[TEST2-H1] API route handlers have zero test coverage**
  - **Files**: `app/routes/api.draft-attachment.tsx`, `api.reply-draft.tsx`, `api.incoming-attachment.tsx`, `api.zoho-inline.tsx`, `api.repair-zoho-images.tsx`
  - **Description**: Five business-critical endpoints (file upload, draft persistence, attachment serving) have no integration tests. Permission/ownership checks could be silently removed without any test failing.
  - **Fix**: Integration tests in `app/lib/__tests__/integration/api-routes.test.ts` covering DELETE permission checks, file size limits, draft upsert side-effects.
  - **Effort**: large

### Code Quality (1)

- [ ] **[CODE2-H1] Outlook token refresh comparison inverted**
  - **File**: `app/lib/outlook/auth.ts:166`
  - **Description**: `if (conn.tokenExpiry.getTime() > Date.now() + 60_000) return decrypt(...)` — uses `>` instead of `<`. Tokens only refresh AFTER they expire, leaving a window of expired-token usage.
  - **Code**: `if (conn.tokenExpiry.getTime() > Date.now() + 60_000) { return { accessToken: decrypt(conn.accessToken) }; }`
  - **Fix**: Match the Zoho pattern in `app/lib/zoho/auth.ts:176`: invert the comparison, or rewrite as `expiresIn < 60_000 → refresh`.
  - **Effort**: small

---

## Medium (35)

### Security (8)

- [ ] **[SEC2-M1]** Marked.js renders raw HTML — `<img onerror=...>` slips past `<script>` strip — `app/lib/support/markdown-to-html.ts:8` | medium
- [ ] **[SEC2-M2]** `api.zoho-inline.tsx` fetch has no timeout — Zoho slowness blocks Node thread — `app/routes/api.zoho-inline.tsx:59` | small
- [ ] **[SEC2-M3]** OAuth `error_description` from provider logged as-is — possible secret leakage — `app/lib/outlook/auth.ts:54`, `app/lib/zoho/auth.ts:65` | small
- [ ] **[SEC2-M4]** Customer ID logged plaintext alongside hashed email in GDPR webhook — `app/routes/webhooks.customers.data_request.tsx:26` | small
- [ ] **[SEC2-M5]** No CSRF token on `api.reply-draft` POST/DELETE — relies entirely on Shopify session JWT — small | medium
- [ ] **[SEC2-M6]** Attachment file extensions accepted by format only, no MIME allowlist — `app/lib/attachments/storage.ts:18` | small
- [ ] **[SEC2-M7]** No size quota per email/per shop on attachment uploads — disk exhaustion risk — `app/routes/api.draft-attachment.tsx:42` | medium
- [ ] **[SEC2-M8]** `EMAIL_RE` regex accepts `user..name@example..com` — false matches in identifier extraction — `app/lib/support/identifier-extractor.ts:14` | small

### Code Quality (6)

- [ ] **[CODE2-M1]** Duplicate `delivery_delay` rule in intent-classifier — first rule unreachable — `app/lib/support/intent-classifier.ts:64-99` | small
- [ ] **[CODE2-M2]** `7 * 24 * 60 * 60 * 1000` magic number repeated 3× in `getOpsBucket` — `app/routes/app.inbox.tsx:528,535,551` | small
- [ ] **[CODE2-M3]** `useEffect([email.draftReply])` reads `allVersions` but doesn't depend on `email.draftHistory` — stale-effect risk — `app/routes/app.inbox.tsx:1547` | small
- [ ] **[CODE2-M4]** Inline `labelStyle`/`rowStyle` objects recreated every render in `DraftBlock` — `app/routes/app.inbox.tsx:1625-1626` | small
- [ ] **[CODE2-M5]** `saveBody` and `saveMeta` debounce: identical pattern but inconsistent error handling — `app/routes/app.inbox.tsx:1549-1584` | medium
- [ ] **[CODE2-M6]** CID-rewrite regex duplicated for `"` vs `'` quoting in sanitizer — `app/lib/mail/sanitize-html.ts:42-54` | small

### Performance (4)

- [ ] **[PERF2-M1]** `threadMeta` rebuilt on every render without `useMemo` (500 threads × every state change) — `app/routes/app.inbox.tsx:2409-2427` | small
- [ ] **[PERF2-M2]** `prior-contact.ts` filters whole `rows` array per thread — O(threads × rows) — `app/lib/support/prior-contact.ts:85-96` | medium
- [ ] **[PERF2-M3]** `JSON.parse(analysisResult)` re-runs in `serializeEmail` for every loaded email (500/load) — `app/routes/app.inbox.tsx:444` | small
- [ ] **[PERF2-M4]** Token-refresh thundering herd: no per-shop lock around Zoho/Outlook refresh — concurrent calls double-refresh — `app/lib/zoho/auth.ts:171`, `app/lib/outlook/auth.ts:162` | medium

### Architecture (5)

- [ ] **[ARCH2-M1]** Duplicate Zoho domain helpers `getZohoApiDomain()` (auth.ts) vs `getApiDomain()` (client.ts) — `app/lib/zoho/auth.ts:17`, `client.ts:8` | small
- [ ] **[ARCH2-M2]** `cleanHtml`/`decodeHtmlEntities` exported from Gmail; Zoho imports directly, Outlook via re-export facade — `app/lib/mail/html-utils.ts` | small
- [ ] **[ARCH2-M3]** Zoho duplicates Gmail's `extractEmail`/`extractName` privately — provider parity drift — `app/lib/zoho/client.ts:539-550` | medium
- [ ] **[ARCH2-M4]** Auto-sync silently swallows per-shop enqueue errors — no operator visibility — `app/lib/mail/auto-sync.ts:144-146` | medium
- [ ] **[ARCH2-M5]** `getMailClient` factory lives in `pipeline.ts`; mixes provider-discovery with pipeline logic — small

### Database (8)

- [ ] **[DB2-M1]** Several large TEXT fields lack `@db.VarChar` limits — table bloat / index efficiency — `prisma/schema.prisma:122,176,181,188,203,360` | small
- [ ] **[DB2-M2]** Cascade delete chain on `Thread` triggers deletion of dozens-to-hundreds of children sync — could lock at scale — schema.prisma | medium
- [ ] **[DB2-M3]** `Thread` lacks composite index `(shop, provider, subjectKey)` to detect duplicate canonical threads after backfill races — small
- [ ] **[DB2-M4]** `IncomingEmail.lastAnalyzedAt` index missing `processingStatus` — query filter not covered — `prisma/migrations/20260430210000_add_last_analyzed_at` | small
- [ ] **[DB2-M5]** Missing standalone `IncomingEmail_canonicalThreadId_idx` (only the composite with `receivedAt` exists) — slow `COUNT(*)` queries — small
- [ ] **[DB2-M6]** Missing `Thread_shop_firstMessageAt_idx` for `dashboard-stats` range queries — `app/lib/dashboard-stats.ts:180-221` | small
- [ ] **[DB2-M7]** `markJobFailed` `knownAttempts` race vs concurrent attempt-increment — could mark `pending` instead of `error` — `app/lib/mail/job-queue.ts:146-173` | medium
- [ ] **[DB2-M8]** `IncomingEmail` write-then-update churn (status pending→filtering→classified→analyzed + LLM cost incrementing) — VACUUM/bloat risk — large

### Tests (4)

- [ ] **[TEST2-M1]** LLM `computeCostUsd` and `priceFor` (model prefix matching) untested — `app/lib/llm/client.ts:30-37` | small
- [ ] **[TEST2-M2]** Dashboard `getHeatmap`, `getReopenedThreads`, `getCurrentThreadStates` not in integration suite — `app/lib/dashboard-stats.ts` | medium
- [ ] **[TEST2-M3]** Lazy-init OpenAI client fix (commit aa780a0) has no regression test — `app/lib/llm/client.ts:44-50` | small
- [ ] **[TEST2-M4]** E2E tests don't exercise any API route end-to-end — `tests/e2e/*.spec.ts` | medium

---

## Low (35)

### Security (3)
- [ ] **[SEC2-L1]** Zoho token refresh buffer is 60 s — increase to 120 s for clock-skew safety — `app/lib/zoho/auth.ts:176` | small
- [ ] **[SEC2-L2]** `JSON.parse(raw)` in llm-parser cast directly to `Record<string, unknown>` without schema validation — `app/lib/support/llm-parser.ts:84` | small
- [ ] **[SEC2-L3]** `extractEmail`/`extractName` could log/leak email envelope if errors echo back — minimal risk | low

### Code Quality (10)
- [ ] **[CODE2-L1]** Inline event handlers recreated each render in `ConnectionCard` — extract to `useCallback` — `app/routes/app.inbox.tsx:2031-2039` | small
- [ ] **[CODE2-L2]** `body = await res.json().catch(() => ({}))` cast loses type safety — `app/routes/app.inbox.tsx:1614` | small
- [ ] **[CODE2-L3]** `allowedStyles` regexes use `[/.*/]` overly permissive for `width`/`height`/`background` — `app/lib/mail/sanitize-html.ts:140-216` | medium
- [ ] **[CODE2-L4]** `_baselineEventCount` recomputes `durationMs`/`windowCount` per call — should be config map — `app/lib/dashboard-stats.ts:603-622` | small
- [ ] **[CODE2-L5]** `order?.customerName?.split(" ")[0]` not coalesced — `app/lib/support/response-draft.ts:205` | small
- [ ] **[CODE2-L6]** Boolean param `shareTrackingNumber: boolean` reduces call-site readability — options object preferred — `app/lib/support/llm-draft.ts:116` | medium
- [ ] **[CODE2-L7]** `confidence-scoring.ts` uses nested if-else; could be exhaustive switch on `matchedBy` — `app/lib/support/confidence-scoring.ts:81-93` | small
- [ ] **[CODE2-L8]** Tracking-number regex compares against `result.orderNumber` which may not be set — fragile ordering — `app/lib/support/identifier-extractor.ts:64-70` | small
- [ ] **[CODE2-L9]** Inconsistent null-coalescing styles (`??` vs ternary) within inbox loader — `app/routes/app.inbox.tsx` | small
- [ ] **[CODE2-L10]** Cleanup useEffect for two debounce timers could leak refs — `app/routes/app.inbox.tsx:1587-1590` | medium

### Performance (4)
- [ ] **[PERF2-L1]** `GRATITUDE_PATTERNS`/`ACTION_PATTERNS` are arrays of regex with `.some(.test)` — combine into single alternation — `app/lib/support/end-of-loop.ts:14-48` | medium
- [ ] **[PERF2-L2]** Snippet 3-step regex chain in `serializeEmail` could be one pass — `app/routes/app.inbox.tsx:457` | small
- [ ] **[PERF2-L3]** `app.dashboard.tsx` Recharts formatters typed `any` — code quality, not perf — `app/routes/app.dashboard.tsx:141,272` | small
- [ ] **[PERF2-L4]** Intent list / attachment list keys correct but parent boundary not memoized — covered by PERF2-H2 | small

### Architecture (3)
- [ ] **[ARCH2-L1]** `parseGraphMessage` synthesizes Outlook-specific label IDs (`OUTLOOK_OTHER`) into the generic `MailMessage` interface — `app/lib/outlook/client.ts:52-82` | small
- [ ] **[ARCH2-L2]** `VALID_GREETING_STYLES` declared inside `saveSettings()` while `VALID_TONES`/`VALID_LANGUAGES` are module-level — `app/lib/support/settings.ts:36-37,82` | small
- [ ] **[ARCH2-L3]** `orchestrator.ts` hardcodes default settings literal instead of importing `DEFAULT_SETTINGS` from `settings.ts` — `app/lib/support/orchestrator.ts:103-113` | small

### Database (8)
- [ ] **[DB2-L1]** Several String enum-like fields (`provider`, `processingStatus`, `tier2Result`, `supportNature`, `operationalState`) — Prisma enums would catch invalid values — schema.prisma | medium
- [ ] **[DB2-L2]** `bodyHistory` (JSON) lacks GIN index — only matters if it ever needs querying — schema.prisma | small
- [ ] **[DB2-L3]** Empty-string defaults (`@default("")`, `@default("[]")`) bloat indexes vs nullable — schema.prisma | medium
- [ ] **[DB2-L4]** `ThreadStateHistory` lacks `(shop, fromState, toState, changedAt)` covering index for alerts — `app/lib/dashboard-stats.ts:629` | small
- [ ] **[DB2-L5]** `refreshThreadStats` does aggregate + findFirst as parallel queries — could be one CTE — `app/lib/mail/thread-resolver.ts:220-246` | medium
- [ ] **[DB2-L6]** Backfill migration uses MD5 for deterministic IDs (`thr_md5(...)`) — collision negligible but weaker than CUID — `prisma/migrations/20260421182210_add_canonical_threads/migration.sql:74,113` | low
- [ ] **[DB2-L7]** Connection pool sizing not visible in code/config — operational risk at scale — schema.prisma + env | medium
- [ ] **[DB2-L8]** ENUM-like `direction` / `provider` strings could become Prisma enums — schema.prisma | small

### Tests (7)
- [ ] **[TEST2-L1]** Confidence-scoring missing test for `tracking.source === "none"` edge case — `app/lib/support/__tests__/confidence-scoring.test.ts` | trivial
- [ ] **[TEST2-L2]** End-of-loop punctuation-only message edge case not covered — `app/lib/support/__tests__/end-of-loop.test.ts` | trivial
- [ ] **[TEST2-L3]** ORDER_WITH_PHRASE regex variant untested — `app/lib/support/__tests__/identifier-extractor.test.ts` | trivial
- [ ] **[TEST2-L4]** Intent classifier whitespace-only inputs untested — `app/lib/support/__tests__/intent-classifier.test.ts` | trivial
- [ ] **[TEST2-L5]** Message parser Unicode/smart-quote handling untested — `app/lib/support/__tests__/message-parser.test.ts` | trivial
- [ ] **[TEST2-L6]** Mock fixture type-conformance not pinned by `_typeCheck: RawOrderNode` — `app/lib/support/__tests__/fixtures/` | trivial
- [ ] **[TEST2-L7]** `vitest.config.ts` exclusions lack rationale comments — small

---

## Cross-cutting observations

1. **Provider parity drift**: Gmail/Zoho/Outlook diverge in token encryption (Outlook lacks it), email parsing helpers (Zoho duplicates), client factory plumbing (Outlook is dynamically imported), and label conventions (Outlook synthesizes `OUTLOOK_*`). A `mail/provider-utils.ts` shared layer would consolidate.

2. **React performance hot spots**: `app.inbox.tsx` is the largest file (~2700 lines). Several heavy operations run on every render (HTML sanitization, threadMeta rebuild, JSON.parse). React.memo + useMemo passes would yield disproportionate UX gains.

3. **DB indexes for dashboard**: Several dashboard queries (`getHeatmap`, `getReopenedThreads`, `_fetchResponseTimesMs`) would benefit from focused composite indexes on `Thread.firstMessageAt` and `ThreadStateHistory.(fromState,toState,changedAt)`.

4. **Rate limiting and input bounds**: The single biggest external-cost risk is unbounded LLM input + no rate limit. A 5-line input cap and a per-shop hourly counter would close the most plausible cost-DoS vector.
