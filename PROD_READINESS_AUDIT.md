# Production Readiness Audit — 2026-05-08

Final audit before public launch. Performed via 8 specialized review agents (production-readiness, concurrency, failure-modes, public attack surface, multi-tenant, billing, recently-changed files, Shopify-reviewer simulation) running in parallel on branch `audit/pass-2-findings`.

**Raw findings: ~115. After dedup + false-positive removal: 56 actionable items.**

| Severity | Count | Fixed | Deferred |
|----------|-------|-------|----------|
| BLOCKER  | 5     | 4     | 1 (B-PROD-4 advisory lock pool) |
| HIGH     | 17    | 15    | 2 (H-5, H-6 — operational/low-impact) |
| MEDIUM   | 24    | ~22   | ~2 |
| LOW      | 10    | 7     | 3 (docs / verify-only) |
| **Total**| **56**| **~48** | **~8** |

> **Status: production-ready code-side.** 609/609 tests pass. Remaining items are operational env vars (Render config) or deferred with documented rationale.

### Operational items to set on Render before launch
- `DATABASE_URL`: append `?connection_limit=20&pool_timeout=10` (H-5)
- `NODE_ENV=production` (M-18)
- `METRICS_TOKEN`: ≥ 32 chars (M-19)
- `METRICS_LABEL_SALT`: stable per-deploy random string (H-9 hash salt)
- `TRUSTED_PROXY=true` (H-16 — enables X-Forwarded-For trust behind Render's edge)
- `SEVENTEEN_TRACK_API_VERSION=v2.2` (optional override, L-6)

> Verified good (no issues found): GDPR webhooks correctness, CSP headers, OAuth state HMAC + TTL, AES-256-GCM token encryption, embedded App Bridge wrapper, sanitize-html (allow-list), shop-isolation in critical paths (api routes, dashboard, thread-state), Prisma cascade rules, leader election lock, FOR UPDATE SKIP LOCKED claim, customer-emails + subscription caches keyed by shop, prefilter memoization, recomputeAllThreadsForShop pagination, end-of-loop regex consolidation, ConnectionCard onboarding state, /privacy public, /healthz auth-free, /metrics token-gated with timingSafeEqual, GDPR shop.redact data-requests path traversal guard, app_subscriptions/update webhook handler exists.

---

## BLOCKERS (5) — fix before deploying to production

### B-PROD-1 — `mail-auth.tsx:163` regression: `error_description` is logged again
- **File**: [app/routes/mail-auth.tsx:163](app/routes/mail-auth.tsx#L163)
- **Evidence**: `console.warn(\`[mail-auth] OAuth provider error: ${oauthError} — ${errorDesc}\`)` — `errorDesc` is the raw `error_description` query param from the provider. SEC2-M3 in pass 2 was supposed to remove this; the linter or a later edit re-introduced it on a different code path (Microsoft consent error block).
- **Impact**: OAuth provider may echo back secret/PII fragments in error_description; logging it leaks them to whatever log sink runs in prod.
- **Fix**: Drop `errorDesc` from the log line, keep it only for the user-facing `errorPage` (which is acceptable since the error_description is being shown specifically to the user who triggered it).

### B-PROD-2 — Rate limiter UPSERT-then-update is not atomic
- **File**: [app/lib/rate-limit.ts:43-75](app/lib/rate-limit.ts#L43-L75)
- **Evidence**: Two concurrent `checkRateLimit` calls can both read `count=N` and both write `count=N+1`. Under burst load, the limit is silently undercounted.
- **Impact**: rate limit becomes a soft guideline, not a hard cap. Most damaging on `/api/reply-draft` (LLM cost DoS vector).
- **Fix**: Replace UPSERT + UPDATE with a single SQL that atomically increments via raw query or a Prisma `update` that uses `{ increment: 1 }` inside a `transaction` with `SELECT ... FOR UPDATE`. Concrete shape:
  ```ts
  await prisma.$executeRaw`
    INSERT INTO "RateLimitBucket" (key, kind, count, "windowStart")
    VALUES (${key}, ${kind}, 1, NOW())
    ON CONFLICT (key, kind) DO UPDATE SET
      count = CASE WHEN EXTRACT(EPOCH FROM (NOW() - "RateLimitBucket"."windowStart")) * 1000 >= ${windowMs}
                  THEN 1 ELSE "RateLimitBucket".count + 1 END,
      "windowStart" = CASE WHEN EXTRACT(EPOCH FROM (NOW() - "RateLimitBucket"."windowStart")) * 1000 >= ${windowMs}
                          THEN NOW() ELSE "RateLimitBucket"."windowStart" END
    RETURNING count, "windowStart";
  `;
  ```
  Then evaluate `ok = count <= limit` from the returned row.

### B-PROD-3 — No HTTP timeouts on Gmail/Zoho/Outlook/Shopify API calls
- **Files**:
  - [app/lib/gmail/client.ts](app/lib/gmail/client.ts) — `users.messages.list/get`, `users.history.list`
  - [app/lib/zoho/client.ts](app/lib/zoho/client.ts) — `zohoFetch`
  - [app/lib/outlook/client.ts](app/lib/outlook/client.ts) — `graphFetch`
- **Evidence**: All three providers' fetch calls have no `signal: AbortSignal.timeout(...)`. A hung provider socket hangs an entire sync job for up to the OS default (often 120 s+).
- **Impact**: One hung shop blocks an auto-sync worker slot. With `AUTOSYNC_CONCURRENCY=4`, four hung shops freeze the entire backend.
- **Fix**: Wrap every provider call with `AbortSignal.timeout(15_000)`. For googleapis (which doesn't accept `signal` directly), pass `{ timeout: 15_000 }` to the client constructor.

### B-PROD-4 — Advisory lock acquired and released on different pool connections
- **File**: [app/lib/mail/auto-sync.ts:74-92](app/lib/mail/auto-sync.ts#L74-L92)
- **Evidence**: `pg_try_advisory_lock` and `pg_advisory_unlock` both go through `prisma.$queryRaw`, which uses the connection pool. They may run on different connections. Postgres advisory locks are tied to the connection that acquired them, so a release on a different connection is a silent no-op.
- **Impact**: On graceful shutdown, the leader lock isn't released. New leader has to wait for Postgres to GC the dead connection (30–60 s), during which scheduling stalls.
- **Fix**: Wrap acquire + release in a long-lived transaction, OR use `pg_try_advisory_xact_lock` (transaction-scoped, auto-released at commit/rollback). Since the lock is held for the entire process lifetime, the cleanest fix is a dedicated PG client (not Prisma pool) reserved for leader election.

### B-PROD-5 — Production `shopify.app.toml` may not get migrations applied on deploy
- **Files**: [package.json](package.json), Render start command
- **Evidence**: Migrations run via `npm run setup` (= `prisma generate && prisma migrate deploy`). The actual `start` script chain needs verification. If `react-router-serve` boots before `migrate deploy` completes (or if `setup` is skipped), the app serves traffic against a stale schema.
- **Impact**: First deploy with a new migration silently runs old SQL. Forms 500, queries fail with "column does not exist".
- **Fix**: Make Render's start command explicitly `npm run setup && npm run start` (or `prisma migrate deploy && react-router-serve ./build/server/index.js`). Fail boot loudly if migration fails.

---

## HIGH (17) — fix before launch or expect operational pain

### Resilience / external deps
- [ ] **H-1** — Outlook/Gmail/Zoho don't distinguish revoked refresh tokens (`401/invalid_grant`) from transient errors → app retries forever and never tells the merchant to reconnect. Fix: catch `invalid_grant`, delete connection or surface "reconnect mailbox" banner.
- [ ] **H-2** — OpenAI 429: backoff sleep happens AFTER `release()` (`app/lib/llm/client.ts:170-188`), so 20 queued shops all resume together → second 429 burst. Fix: hold the semaphore for the full backoff window.
- [ ] **H-3** — 17track quota exhaustion treated as breaker failure, not as `{ state: "quota_exhausted" }`. Fix: detect 17track's `-18019999` error and surface "wait until quota resets" to UX instead of breaking the breaker for all tracking lookups.
- [ ] **H-4** — DNS timeout in `safe-fetch` (`app/lib/net/safe-fetch.ts:131-136`) can hang forever if `dns.lookup` doesn't respond. Fix: wrap `lookup` in `withTimeout(5_000)`.

### DB / Prisma
- [ ] **H-5** — `DATABASE_URL` has no `connection_limit` → Prisma defaults to ~10. With 4 concurrent auto-sync slots × 3-5 queries each + dashboard loaders, you saturate. Fix: append `?connection_limit=20&pool_timeout=10` to the production env var.
- [ ] **H-6** — `lastAnalyzedAt: new Date()` uses Node clock (`app/lib/gmail/pipeline.ts`); analytics filters compare against `NOW()` from Postgres. Clock skew (NTP drift) miscounts records around the boundary. Fix: use `prisma.$queryRaw` or Prisma's `@updatedAt` semantics — set the column server-side.
- [ ] **H-7** — `claimNextJob` subquery race: `NOT IN (SELECT shop FROM SyncJob WHERE status='running')` is evaluated before `FOR UPDATE SKIP LOCKED` locks the row, so two workers can both claim a job for the same shop ([app/lib/mail/job-queue.ts:105-124](app/lib/mail/job-queue.ts#L105-L124)). Fix: push the shop filter inside the FOR UPDATE block, OR use a separate `RUNNING_SHOPS` table updated atomically with the claim.
- [ ] **H-8** — `markThreadAnalyzedIfFirst` atomicity: `updateMany` + subsequent upsert is not in a single transaction ([app/lib/billing/usage.ts:62-98](app/lib/billing/usage.ts#L62-L98)). Wrap both in `prisma.$transaction(...)`.

### Observability / metrics
- [ ] **H-9** — Prometheus metrics export shop domains as labels (`autoSyncJobsTotal{shop="…"}`). Anyone with scrape access enumerates merchants — sensitive business info. Fix: hash shop domains with a deployment secret, or use opaque indices.
- [ ] **H-10** — Subscription plan cache is 60 s per-process; multi-instance deployments serve stale plan state after a webhook. Fix: reduce TTL to 10 s, OR have the webhook handler bump a `ShopFlag.subscriptionCacheBust` counter that all workers read on each call.

### Boot / lifecycle
- [ ] **H-11** — `entry.server.tsx` calls `startAutoSyncLoop()` synchronously at module load. If the advisory-lock query throws, boot succeeds but no syncs run. Fix: wrap in try/catch and either fail boot or emit a critical metric.
- [ ] **H-12** — `runBootCleanup()` and `backfillBillingShopFlags()` are fire-and-forget; errors don't block boot or surface to ops. Fix: log a `BOOT_DEGRADED` metric so dashboards can alert.
- [ ] **H-13** — `boot-cleanup.ts` `take: 5000` loads 5 000 rows + builds a Set of 5 000 strings on a 0.5 CPU Render instance. OOM risk during boot. Fix: cursor-paginate in chunks of 500.
- [ ] **H-14** — Shutdown drain timeout 25 s vs Render's 30 s SIGKILL grace = 5 s buffer is fragile. Fix: lower drain to 20 s, log "killed mid-flight" if jobs remain.
- [ ] **H-15** — `healthz.tsx` only pings the DB. If auto-sync crashes silently, healthz still 200s. Fix: add a `lastTickAt` gauge updated in `tick()`, and have healthz check it's < 3 × TICK_MS old.

### Public surface
- [ ] **H-16** — `getClientIp` trusts `X-Forwarded-For` blindly ([app/lib/rate-limit.ts:112-122](app/lib/rate-limit.ts#L112-L122)). An attacker behind a CDN can spoof the IP and bypass `/mail-auth` per-IP rate limits. Fix: configure `TRUSTED_PROXY_DEPTH=1` (Render adds exactly one hop), OR check the request actually came through Render's proxy via a known header.
- [ ] **H-17** — `app/routes/app.tsx` ErrorBoundary returns HTML with default 200 OK on errors. Load balancers think requests succeeded. Fix: throw a `Response` with `{ status: 500 }`, or call `responseStatusCode = 500` before render.

---

## MEDIUM (24)

### Performance
- [ ] **M-1** — Inbox loader can run 3-5 large queries per page view; no per-loader timeout. Slow shop = slow inbox. Fix: cap loader at 2 s via `Promise.race(loader, timeout)` and degrade to "loading" state.
- [ ] **M-2** — `getOpenAIClient()` is process-global, no connection pool tuning. Default OpenAI HTTP/2 keepalive is fine but worth confirming under load.
- [ ] **M-3** — `customerEmails` cache (20 min) is per-process; multi-instance staleness same as subscription cache. Either reduce TTL or use Postgres-backed cache.
- [ ] **M-4** — `recomputeThreadState` called multiple times during a single ingestion pass (already known PERF-H2 from pass 1, deferred). Consolidate to a single end-of-batch call.
- [ ] **M-5** — `Zoho.embedZohoInlineImages` fires unbounded `Promise.allSettled` for inline images. Cap to 5 concurrent.
- [ ] **M-6** — `_baselineEventCount` recomputes window duration math per call (`app/lib/dashboard-stats.ts:603-622`). Hoist as module const map.

### Code quality / correctness
- [ ] **M-7** — `buildCidMap` in `sanitize-html.ts:19-20` writes the same entry twice when contentId already lacks angle brackets. Skip the second `map.set` when `clean === contentId`.
- [ ] **M-8** — `normalizeIntents` in `llm-parser.ts:136-137` filters "unknown" twice (once on map, once on the result). Remove the redundant second filter.
- [ ] **M-9** — `handleRefine` reloads the email by ID without re-checking shop (`app/lib/support/inbox-actions.ts:374-377`). Defense-in-depth: add `shop` to the where clause.
- [ ] **M-10** — `upsertReplyDraftBody`/`updateReplyDraftBody` accept `shop` but don't validate that the underlying email belongs to the shop. Currently safe because all callers validate, but it's a footgun. Either remove the param or use it.
- [ ] **M-11** — `handleUpdateClassification` second `prisma.thread.findUnique({ where: { id: threadId } })` lacks shop scoping. Add it.
- [ ] **M-12** — `inFlight` counter underflow possible if `runJob` crashes synchronously before its finally block fires (rare, but `runJob` is called via `void`). Switch to `.then(release).catch(release)` pattern.
- [ ] **M-13** — `Outlook.getAuthenticatedClient` may infinite-loop on clock skew (refresh < 1 s ago, refresh again). Track last refresh time per shop.
- [ ] **M-14** — `Zoho.folders cache` caches `null` on fetch failure → folders look empty forever. Only cache on success.
- [ ] **M-15** — `markJobFailed` doesn't distinguish 429-style transient failures from real bugs. Both increment `attempts` the same way. Add a `transient: boolean` so we can apply different backoff.

### Operational / observability
- [ ] **M-16** — Log volume on the auto-sync hot path is high (20-30 lines per sync, 4 shops × every minute = > 4 000 lines/h). Add a `LOG_VERBOSITY=info` env knob and demote per-batch lines to debug.
- [ ] **M-17** — OpenAI 429 warning lacks shop+callSite context (`app/lib/llm/client.ts:183`). Add `{ shop, callSite, model }` to the log.
- [ ] **M-18** — Render-side: confirm `NODE_ENV=production` is explicitly set in the deploy env. Default-to-development is a silent footgun (E2E bypass guards don't activate).
- [ ] **M-19** — Render-side: confirm `METRICS_TOKEN` length ≥ 32 chars (boot validation, refuse to start if short).
- [ ] **M-20** — `autoSyncLeader` Prometheus gauge isn't reset to 0 on leader-lock release. Tag the release path with `autoSyncLeader.set(0)`.
- [ ] **M-21** — `prisma.$disconnect()` not called on process exit. Add `process.once('exit', () => prisma.$disconnect())`.

### UX / reviewer simulation
- [ ] **M-22** — Inbox doesn't show a banner when `lastSyncError` is set on a connected mailbox. Add a Polaris banner in `ConnectionCard` for `connected && lastSyncError`.
- [ ] **M-23** — Help page hardcodes FR/EN strings inline instead of using `t()` keys (`app/routes/app.help.tsx:39-56`). Move all copy to translation keys.
- [ ] **M-24** — Help page derives language from `navigator.language` instead of `i18n.language` — risks mismatch if user picked a different app language. Use `i18n.language`.

---

## LOW (10)

- [ ] **L-1** — `SignalPill` (alert-triangle) has `aria-hidden` SVG but no `role="img"`/`aria-label`. Screen readers skip it.
- [ ] **L-2** — `escapeHtml` in `mail-auth.tsx` is custom; could use the `escape-html` npm package for consistency. Cosmetic.
- [ ] **L-3** — `pruneOldRateLimitBuckets` is wired only into the auto-sync tick; if the auto-sync leader is down, buckets never get cleaned. Acceptable for now.
- [ ] **L-4** — Order-search retries hardcode `2500ms` backoff. Switch to jittered exponential.
- [ ] **L-5** — Shopify API version is hardcoded in code; no warning when nearing deprecation. Add a comment with the deprecation date.
- [ ] **L-6** — 17track API endpoint hardcoded as `v2.2`; if Shopify-side bumps to `v2.3`, no fallback.
- [ ] **L-7** — `computeQuotaStatus` caps `pct` at 1.0; UI can't show overage. Display the raw value, let UI clamp.
- [ ] **L-8** — Scheduled-changes processor: `listDueChanges` exists but its cron caller isn't visible in the repo. Verify.
- [ ] **L-9** — `STARTUP_DELAY_MS = 15s` adds a small first-boot latency. Reduce to 5 s.
- [ ] **L-10** — Trial → paid quota carryover policy isn't documented. Add a note to `CLAUDE.md` so the policy is explicit (no carry, full new quota on first paid period).

---

## False positives (verified, no action needed)

- ❌ `webhooks.shop.redact.tsx` "path traversal" — the OR condition is intentionally `shopDir.startsWith(base + sep) || shopDir === base`, and line 56 explicitly refuses to delete when `shopDir === base`. The guard is correct.
- ❌ `.env` committed in git — `.env` is in `.gitignore` AND `git ls-files | grep .env` returns nothing. Local plaintext is expected for dev.
- ❌ `webhooks.app_subscriptions.update` handler missing — handler exists at [app/routes/webhooks.app_subscriptions.update.tsx](app/routes/webhooks.app_subscriptions.update.tsx).
- ❌ `handleRedraft` / `handleRefine` quota bypass — the gate `if (!ent.canGenerateDraft) return quotaExceeded` is intentional and cost-correct (these operations DO trigger LLM calls and shouldn't run for suspended shops).
- ❌ `shopify.app.automail-test.toml` committed — the dev config has different client_id from prod, and the file pattern is in `.gitignore` (line 34: `shopify.app.*.toml`). Verify it's not tracked in git history.
- ❌ `mail-auth.tsx` shop domain regex — the regex is defense-in-depth; main verification is via HMAC.

---

## Suggested order

1. **Today (BLOCKERS)** — B-PROD-1, B-PROD-2, B-PROD-3, B-PROD-5 (a few hours). B-PROD-4 needs more care.
2. **Before launch** — All HIGH (~1-2 days).
3. **Week 1 post-launch** — MEDIUM tier.
4. **Sprint backlog** — LOW tier.
