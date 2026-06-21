# Reading `/app/metrics`

Operational dashboard for the live app. Gated by `ShopFlag.isInternal = true`
on the shop you log in as. Source: [app/routes/app.metrics.tsx](../app/routes/app.metrics.tsx).

## When to look

| Cadence | What to check |
|---|---|
| Daily (10 s) | Pipeline health — "ingested-not-analyzed" and "error state" should be near zero. |
| Weekly (1 min) | LLM cost by shop — spot the outlier (10× the average = bug). |
| During an incident | Real-time + Circuit breakers + Database pool. |

## Section-by-section

### Real-time (this worker)

State of THIS Node process right now. Resets to zero on every Render
restart / deploy.

- **Leader: yes / follower** — only the leader schedules new work. In
  multi-instance deployments you want exactly one `yes` across all
  workers. If you see two `yes` simultaneously, the advisory lock isn't
  doing its job — investigate `AUTOSYNC_LEADER_LOCK` env / DB role
  permissions.
- **Jobs in flight** — auto-sync slots currently busy. Capped by
  `AUTOSYNC_CONCURRENCY` (default 4).
- **LLM in flight / queued** — OpenAI calls executing vs waiting behind
  the semaphore. If `queued` stays > 5 for minutes, either bump
  `OPENAI_MAX_CONCURRENT` or lower `AUTOSYNC_CONCURRENCY`.

### Circuit breakers

`closed` = healthy. `open` = the breaker tripped and is short-circuiting
calls. Thresholds:

- **OpenAI** — 8 non-429 failures in any 5-min window → open for 2 min.
  429s are NOT counted (those are upstream-healthy back-pressure handled
  by the semaphore + retry).
- **17track** — 5 failures in any 10-min window → open for 15 min.
  Shared across all shops (one API key, one quota).

If a breaker oscillates open ↔ closed, look at the corresponding upstream's
status page first; if it's up, look for our own code that's producing
non-429 5xx errors.

### Process counters (since boot)

Cumulative since the process started. Useful to spot anomalies between
two refreshes; for trend over time use the SQL tables at the bottom of
the page.

- **Jobs OK / failed / suspended** — `suspended` = shops we skipped
  because their entitlements gate said so (trial expired, no plan). Not
  an error.
- **LLM calls OK / 429s / errors / breaker-open** —
  - 429s recovered transparently via retry (no user impact).
  - `errors` are real failures returned to the caller.
  - `breaker-open` is a count of calls we refused upstream because the
    breaker was open. Should match the duration of a real outage.
- **LLM cost (this proc)** — cost on this process only. For the real
  invoice number, see "LLM cost by shop" further down (it pulls from
  the `LlmCallLog` table, cross-process).

### Pipeline health

The one section to actually watch.

- **Emails ingested-not-analyzed** — should drain quickly each tick.
  A chronic backlog means Pass 2 (LLM classification) isn't running.
  A handful immediately after a deploy is normal — they'll move on the
  next tick.
- **Emails in error state** — count of `processingStatus = 'error'`
  rows. A few are normal (transient provider failures); a sustained
  rise means something repeatedly chokes on the same input.
- **Emails analyzed (24h)** — volume of activity. A useful "are we
  alive" indicator.

### Database pool

Best leading indicator for scaling.

- **Active** — connections currently doing work. If this approaches
  the `connection_limit` in your `DATABASE_URL`, requests start
  failing with "Timed out fetching a new connection from the pool".
- **Idle** — open but unused. Reusable; not a problem.
- **Idle in transaction** — connections sitting in a transaction
  without doing anything. Should be 0. If > 0 durably, you have a
  bug somewhere not closing a transaction.
- **Total / max** — `total` is what the DB sees from this app + every
  other client. `max` is the Postgres `max_connections` setting.

Sizing rule of thumb: keep `AUTOSYNC_CONCURRENCY ≤ connection_limit / 4`
so there's headroom for web requests + webhooks.

### Top shops by jobs (last 24h)

Cross-process, SQL-backed. Sorted by error count desc, then ok count.

- **Errors > 5/24h** on the same shop → check the actual error in DB:
  `SELECT "lastError" FROM "SyncJob" WHERE shop = '<x>' AND status = 'error' ORDER BY "finishedAt" DESC LIMIT 5;`
- **p95 > 300s on `sync`** → that shop is slow; could be an expensive
  Shopify GraphQL query or an unbounded LLM loop.

### LLM cost by shop (last 24h)

Cross-process, SQL-backed. Sorted by USD desc.

- **One shop 10× the others** without a 10× volume difference → either
  a stuck refresh loop or a regression in prompt size. Search logs for
  that shop with `[refresh-stale] shop=<x>` repeats.
- **Trend** is what matters more than absolute number. Compare week
  over week.

### Tracking carrier resolution

Three counters emitted by `resolveOneFulfillment` in `tracking-service.ts` on every 17track call. They accumulate since process start; use a Prometheus rate or a diff between two scrape snapshots for trend analysis.

**`tracking_resolution_total`** — labelled by `outcome`:
| outcome | meaning |
|---|---|
| `ok_auto` | 17track resolved the parcel; carrier confirmed without a hint |
| `ok_hint_recovered` | 17track resolved but used an inferred/hinted carrier code |
| `pending` | 17track reports tracking initialising (retry in 5 min) |
| `notfound` | corroboration mismatch — likely a wrong-parcel rejection |
| `error` | transient 17track failure (HTTP error or uncaught throw) |

Healthy reading: `ok_auto` dominates. `pending` is small and decays as parcels register. `error` is near zero outside incidents.

Degrading signal: a rising `notfound` with low `ok_hint_recovered` indicates hint coverage is too narrow for the carrier mix. A rising `error` sustained beyond a breaker window indicates a 17track API reliability issue.

**`tracking_hint_total`** — labelled by `source` and `result`. The label `{source:"reactive", result:"recovered"}` counts parcels where the reactive register-add hint branch ran and successfully produced tracking data (i.e. the first poll was NotFound, we re-registered with a derived carrier code, and the re-poll found the parcel). Comparing `ok_hint_recovered` in `tracking_resolution_total` against `ok_auto` gives the efficacy of the hint-recovery feature: a high ratio means many parcels would be lost without it.

**`tracking_corroboration_total`** — labelled by `result`:
| result | meaning |
|---|---|
| `match` | 17track's `recipientCountry` matches the order's destination country |
| `mismatch_rejected` | country mismatch — parcel rejected, tracking fell back to Shopify data |
| `absent_unverified` | carrier was inferred; no country data available to corroborate |

Healthy reading: `match` is the majority of verified parcels. `absent_unverified` covers parcels where the order lacks a destination country (expected for some merchants).

Degrading signal: a rising `mismatch_rejected` means the corroboration guard is catching wrong parcels — investigate whether tracking numbers are being reused across merchants, or whether the order country data is incorrect. A sustained `mismatch_rejected` spike without a corresponding `ok_auto` rise is a data-quality alert.

## Toggling access for a shop

```sql
-- Enable
UPDATE "ShopFlag" SET "isInternal" = true WHERE shop = '<your-shop>.myshopify.com';
-- Disable
UPDATE "ShopFlag" SET "isInternal" = false WHERE shop = '<your-shop>.myshopify.com';
```

A merchant with `isInternal = false` who lands on `/app/metrics` sees a
friendly "access required" page with the SQL above. No data leaks.

## Related: `/metrics` Prometheus endpoint

Same data exposed in Prometheus text format on `/metrics`, gated by a
constant-time check against `METRICS_TOKEN` (env var). If the env var
isn't set, the route returns 404 — invisible to scanners.

Use case: hook up Grafana Cloud (free tier 10k series) when in-app
inspection isn't enough. Until then this endpoint can stay dormant.

```sh
curl -H "Authorization: Bearer $METRICS_TOKEN" https://<app>/metrics
```
