# Structured logging migration (deferred)

**Status**: not started. Deferred from the 2026-05-14 observability pass.

**Why deferred**: today every meaningful log line is either a one-off
`console.log` or a structured `createLogger(...)` call in the hot paths
(`gmail/pipeline.ts`, `lib/log/logger.ts`). Render captures both into the
same stream, and the team's day-to-day workflow is "open Render Logs, grep
for `[auto-sync]` / `[17track-breaker]` / `error`". That works as long as
the consumer is a human reading text.

The migration becomes useful the moment you wire a real log backend
(Datadog, Logflare, Better Stack, Axiom). Those backends index by JSON
fields, so an unstructured `console.log("[pipeline] shop=" + shop + " ...")`
becomes a free-text needle and you lose the per-shop filtering, alerting,
and aggregation that justified plugging in the backend in the first place.

## Trigger to start the migration

Do this work when any of these is true:

- You pick a log backend and have signed up / paid for it.
- You hit 10+ active shops and Render Logs grep becomes painful.
- An incident review shows you wasted >15 min grepping for a shop's
  recent errors.

Until then this doc lives here as the runbook.

## Step 1 — audit the surface

```sh
# Inventory of unstructured logs (one line per offending call site).
rg -n "console\.(log|warn|error|info|debug)" app/ \
  | grep -v "__tests__\|\.test\.\|scripts/" \
  > /tmp/console-surface.txt
wc -l /tmp/console-surface.txt
```

Expect ~80-120 hits. Group by file. Anything in `app/lib/` is worth
migrating; anything in `app/routes/` is lower priority (route lifetime is
short, the request id is the natural correlation key).

## Step 2 — extend the logger

`app/lib/log/logger.ts` already exists with `createLogger({ shop, mod })`.
Before mass-replacing, add:

- a `level` field (info/warn/error) so we don't lose severity in the JSON
  output;
- a `requestId` field, threaded from the incoming `Request` headers when
  available (`x-shopify-request-id` for embedded admin, generated UUID
  otherwise);
- a `correlationId` for cross-service chains (Shopify webhook id, OpenAI
  request id);
- a small `withChild({ ... })` helper so a function can add per-call
  context without rebuilding the base context.

Output format: JSON Lines (`{"ts":...,"level":"info","mod":"...","shop":"...",...}`),
one event per stdout line. That's what every backend ingests natively.

## Step 3 — instrument the hot paths first

Order matters — convert the modules that already produce the most logs:

1. `app/lib/gmail/pipeline.ts` (~30 lines, biggest single consumer)
2. `app/lib/mail/auto-sync.ts` (~12 lines)
3. `app/lib/support/tracking/seventeen-track-breaker.ts` (1 line)
4. `app/lib/support/refresh-stale-analyses.ts` (~5 lines)
5. `app/lib/llm/client.ts` (~3 lines)
6. `app/lib/mail/job-queue.ts` (no logs today, but worth tagging the
   reclaim events as `event="zombie-reclaim"`)

Pattern: at the top of each module
```ts
import { createLogger } from "../log/logger";
const log = createLogger({ mod: "gmail/pipeline" });
```
and per-call:
```ts
log.info({ shop, jobId, ms }, "job done");
```

A grep-friendly heuristic for what to convert: any `console.log` that
already contains a shop string (`shop=${shop}`) should become structured.

## Step 4 — keep `console.*` for true emergencies

Some calls SHOULD stay as `console.*`:

- Top-level `console.error("[shutdown] drain error:", err)` in
  `entry.server.tsx` — the structured logger may itself be broken at
  process exit; bare stderr is the safest path.
- Boot banners (`[E2E_AUTH_BYPASS]`) — developer ergonomics, not
  production telemetry.

Document this convention in `app/lib/log/logger.ts` so future contributors
know when to break the rule.

## Step 5 — wire a backend

Cheapest path for a solo dev today (2026-05): **Better Stack** (formerly
Logtail) free tier. 1 GB/month, ingests Render's stdout via their
Cloudflare worker bridge or a small forwarder, and they have built-in
saved searches + alerts.

Steps:
1. Sign up, create a source, copy the source token.
2. In Render, add a Log Drain pointing to the Better Stack ingest URL.
3. In Better Stack, create saved views:
   - `level=error` → email alert
   - `mod=auto-sync AND event=zombie-reclaim` → just a saved view, no
     alert (these happen on every deploy and are not actionable)
   - `breaker=open` → email alert
4. Test: trigger a fake error in dev, confirm it shows up in Better
   Stack within ~5s.

Alternative backends if you outgrow Better Stack:
- **Axiom** (better querying, ~$10/mo)
- **Datadog Logs** ($0.10/GB ingested, expensive at scale but unified
  with the rest of Datadog if you go APM)
- **Grafana Loki** self-hosted (free but you maintain it)

## Step 6 — keep the metrics endpoint as the source of truth for state

Logs are for events ("a job failed", "a breaker opened"). The `/metrics`
endpoint (Prometheus) and the `/app/metrics` dashboard remain the source
of truth for current state ("how many jobs in flight", "what's the LLM
cost this hour"). Don't try to derive state from log aggregations —
keep them complementary.

## Estimated effort

- Step 1-2: 1 h (audit + logger extensions)
- Step 3: 2-3 h (mechanical replacement, run tests between each module)
- Step 4: 30 min (documentation + lint rule if any)
- Step 5: 1 h (backend signup, log drain, alert setup, test)

Total ~5 h of focused work. Don't attempt in one sitting; do it in a
calm window after a deploy where no incident is brewing.
