# 17track carrier resolution — design

> Date: 2026-06-19
> Status: approved (methodology), pending spec review
> Supersedes the carrier-hint behaviour shipped in PR #32 (which introduced a regression — see below).

## Why this matters

WISMO ("Where Is My Order") is the core of the app. If we show the wrong carrier,
a `NotFound`, or — worse — *another customer's* parcel, the pre-drafted reply is
wrong and the merchant loses trust. This document defines how we resolve the
carrier + live status for a tracking number reliably, and how we **measure** that
reliability over time on real merchant data rather than asserting it.

## Background: the failure we observed

17track auto-detects the carrier from the tracking number. For Cainiao / AliExpress
dropship parcels the number is ambiguous and 17track frequently guesses **a wrong
last-mile carrier and returns `NotFound`**, even though the parcel is perfectly
trackable under the consolidator (Cainiao):

- `AP00819233764158` → guessed **Australia Post** (`1151`) → `NotFound`. Real: **Cainiao** → Delivered.
- `CK094884943NL` → guessed **PostNL** (`14041`) → `NotFound`. Real: **Cainiao** → InTransit (ColisPrivé last-mile, FR).

Meanwhile PR #32 tried to help by passing a carrier hint derived from the Shopify
tracking-URL host — but it put the hint in **both** the `register` *and* the
`gettrackinfo` payload. Filtering `gettrackinfo` by a carrier code breaks numbers
whose real carrier differs from the hint:

- `LV121529710FR` has a `laposte.fr` URL → #32 hint `100068`. But the real Colissimo
  code is **`6051`**; 17track **rejects** `100068` → the app falls back to Shopify
  ("Autre / SUCCESS"). Without the hint, auto-detect resolves it to Colissimo /
  Delivered. **#32 regressed this case.**

## Evidence (measured, not assumed)

Sample: 40 real shipped-order tracking numbers from the live shop (ambienthome),
queried against the real 17track API on 2026-06-19.

- Of **23 registered** numbers: 18 OK (Delivered/InTransit), **5 `NotFound`**.
- **All 5 `NotFound` are `AP…`/`CK…` Cainiao parcels mis-detected as Australia
  Post / PostNL** — i.e. ~22% of registered shipments broken (≈30% before two
  `AP…` numbers were manually pre-fixed during investigation).
- **Recovery proven on an untouched `NotFound`:** `CK095178434NL` (PostNL NotFound)
  → `register` add `carrier=190271` → `gettrackinfo` **without** a carrier filter
  returns `PostNL(NotFound)` **+** `Cainiao(InTransit, recipient=FR)` → we select
  Cainiao. ✅
- **`register`-add keeps both carriers; `changecarrier` replaces** (and re-enters
  `pending`). Verified live. → we use `register`-add (never lose a slow-but-correct
  auto carrier).
- **`gettrackinfo` without a carrier returns all registered carriers** — official
  17track behaviour, confirmed live.
- **Corroboration is real and necessary:** `01425091717892` auto-detected as
  **DPD (DE)**, "Delivered", `recipient=DE` — but the order shipped to **FR**. That
  is a *wrong parcel*; a country check catches it. Across the sample, recipient
  country was present in 78% of resolved numbers and matched the order in 94%.
- **Our hard-coded carrier codes are wrong:** `100068` (La Poste) vs official
  Colissimo `6051`; Chronopost `100174` vs official `100273`.

## Design

Resolution runs per tracking number inside the 17track adapter / tracking-service.

### Step 1 — auto-detect, query carrier-agnostic, pick the one with data

- `register` the number **bare** (`{number, param}`) so 17track auto-detects, as it
  did before #32.
- `gettrackinfo` **without** any carrier filter (`{number}`). Official behaviour:
  returns every carrier the number is registered under.
- Select among the returned candidates (see Step 3). This alone **fixes the #32
  regression** (no more carrier filter on `gettrackinfo`).

### Step 2 — reactive hint on NotFound (additive)

If the selected result is still `NotFound` **and** we can derive a carrier hint:

- Derive candidate code(s) from, in union:
  - the **Shopify tracking-URL host** (`carrierCodeFromTrackingUrl`, from #32), and
  - the **tracking-number pattern** (`guessCarrierCode`, currently dead — revived).
  Neither alone is sufficient: `AP…` only has the URL signal (`cainiao.com`),
  `CK…` only has the number-pattern signal (its URL is the misleading `postnl.nl`).
- `register`-**add** each candidate code (`{number, carrier, param}`). This **adds**
  a carrier without removing the auto-detected one (verified). Do **not** use
  `changecarrier` (it replaces and can discard a slow-but-correct auto carrier).
- Re-`gettrackinfo` without a carrier filter and re-select.
- **Idempotency / cost:** only register a hint when the current result is NotFound
  and the candidate isn't already registered, so steady-state refreshes don't
  re-register. The extra call happens only for genuinely mis-detected numbers.

### Step 3 — stable selection among candidates

Given the candidates from `gettrackinfo` (carrier-agnostic):

1. **Corroboration filter:** drop any candidate whose `track_info.shipping_info
   .recipient_address.country` is present and **differs** from the order's
   `destinationCountry`. (This is what eliminates the DPD-DE-on-an-FR-order case.)
2. Among the survivors that are **non-`NotFound`**, pick by a **stable** rule (never
   recency, which would make the displayed carrier oscillate between refreshes):
   - a candidate with status **Delivered** wins (terminal, monotone); else
   - the candidate matching our **hint** carrier, or the **previously-selected**
     carrier (stable identity); else
   - the first.
3. If no non-`NotFound` survivor: keep `NotFound` (genuinely untrackable right now).

### Step 4 — honesty when corroboration is weak

- Country present **and matches** → accept normally.
- Country present **and mismatches** → **reject the override / don't trust it**; do
  not invent a status (truth-seeking principle).
- Country **absent** (≈22% of cases) → accept but flag `inferred` /
  "transporteur non vérifié" (the `badgeUnverifiedCarrier` UI affordance exists).

### Carrier codes

- Keep a **small** name→code table for the carriers we actually hint (Cainiao
  `190271`, La Poste/Colissimo `6051`, UPS `100002`, YunExpress, 4PX, …), with the
  **official** codes from `res.17track.net/asset/carrier/info/apicarrier.all.json`.
- Add a **test** that validates our table against the official list (fetched in CI,
  or a committed snapshot) so a wrong/stale code fails the build. No runtime network
  dependency — the table is a committed constant.
- For **display**, never map codes: use the carrier name string 17track returns
  (`provider.name`), as today.

## Monitoring — the "suivi" (first-class requirement)

We do **not** claim ">99%". We **measure** it in production on real merchants, via
the existing in-process metrics registry (`app/lib/metrics/registry.ts`, surfaced on
`/metrics` and the internal `/app/metrics` dashboard):

- `tracking_resolution_total{outcome}` — `outcome` ∈ `ok_auto | ok_hint_recovered |
  notfound | pending | error | not_registered`. → NotFound rate and recovery rate
  over time.
- `tracking_hint_total{source, result}` — `source` ∈ `url | number_pattern`;
  `result` ∈ `derived | applied | recovered | no_data`. → how often hints fire and
  succeed.
- `tracking_corroboration_total{result}` — `result` ∈ `match | mismatch_rejected |
  absent_unverified`. → wrong-parcel catches and corroboration coverage.

These let us watch the metric **evolve across the merchant base** and prove (or
disprove) the >99% target on data we don't have yet, instead of overfitting to one
shop. A short section in [docs/metrics-dashboard.md](../../metrics-dashboard.md)
documents how to read them.

## Generalization (anti-overfit)

The sample is one Cainiao-heavy dropship shop. Why the design holds beyond it:

- The **mechanism** (query-all → pick non-NotFound → corroborate) is
  **carrier-agnostic**; it does not "know" Cainiao, it picks whichever carrier has
  data.
- The mis-detection it fixes stems from **Cainiao/AliExpress number ambiguity**,
  common to the **entire dropship segment** of the App Store — not a quirk of this
  shop.
- **Graceful degradation:** unknown carrier / no derivable hint → today's behaviour
  (auto-detect). No regression for merchants we've never seen.
- **Overfit is contained by corroboration:** a hint rule that is wrong for some other
  merchant produces either `NotFound` (not selected) or a country mismatch
  (rejected) — it can **never** produce confident-wrong output. So hint rules
  degrade safely.
- Hint tables are built from **known ambiguous-carrier families** (Cainiao, YunExpress,
  4PX, SunYou…), universal to dropship, validated against official codes — not from
  this shop's specific numbers.

## Honest residual risks

- **Same-route number collision** (two different CN→FR parcels sharing a number
  string): undetectable from tracking data alone. Negligible probability on these
  long numbers, and *no worse than today* (the app already trusts auto-detect with
  zero corroboration). The country gate only catches gross mismatches.
- **No hint + wrong auto-detect + no corroboration data**: irreducible; falls back to
  current behaviour. Measured by the metrics above.
- **17track quota** (shared key across shops): the reactive hint adds one `register`
  only for genuinely-NotFound numbers; idempotent on refresh. Tracked.
- The ">99%" target is **measured in prod**, not asserted here.

## Resilience (added 2026-06-21 — same branch)

A production survey (read-only, 800 latest stored analyses) found **~17% of shipped
parcels displayed a Shopify-fallback source instead of 17track**, almost all stamped
`last17trackAttempt: "error"`. Investigation (verified):

- **Root cause 1 — refreshes overwrite, destructively.** `orchestrator.ts` recomputes
  `trackings = await getTrackingFacts(order)` on every refresh with **no** reuse of
  the previous trackings (there is `reuseOrder`/`reuseIntents` but no `reuseTracking`).
  So a *transient* 17track failure replaces a good `seventeen_track` result with the
  Shopify fallback, and if the thread then goes inactive it stays frozen on Shopify.
- **Root cause 2 — transient HTTP failures are hard + untreated.** `postJson` throws on
  any `!res.ok` (incl. **HTTP 429 rate-limit**); the adapter turns that into a `null`
  (→ `error` → Shopify overwrite) and a breaker failure. 8/10 surveyed stuck numbers
  resolve fine on a later query — the failures were point-in-time rate-limits. This
  feature's reactive register-add modestly *increases* 17track call volume, so it
  aggravates exactly this weakness — hence it ships on the same branch.
- **Root cause 3 — `-18019902` mis-classified as quota.** Official 17track docs:
  `-18019902` = *"the tracking number does not register, please register first"* (not
  indexed yet), **not** quota. The adapter's over-broad quota range
  (`-18010000 … -18019999`) swallows it → `quota_exhausted` → `skipped`/1h retry
  instead of register + fast retry.

### Resilience design

1. **Non-destructive refresh.** Thread the previous analysis's trackings into the
   orchestrator (`analyze-thread.ts` already holds `previousAnalysis.trackings`) →
   `getTrackingFacts(order, { previousTrackings })`. In `resolveOneFulfillment`, when
   the 17track outcome is a Shopify-fallback case (null/error, quota, catch,
   `corroboration_mismatch`) **and** a previous fact for the same `trackingNumber` had
   `source: "seventeen_track"`, return that previous fact (preserve its data) with the
   new `last17trackAttempt`/`At` stamped so retry cadence still fires. Shopify fallback
   only when there is no prior 17track data. Never downgrade good data to Shopify on a
   blip.
2. **Treat HTTP 429 (and rate-limit) as transient, not destructive.** On 429, do a
   bounded retry honoring `Retry-After`; if still limited, return a `pending`-like
   state with `breakerSuccess` (the API is up, just throttled) instead of a breaker
   failure + `null`. A rate-limit must not trip the breaker or overwrite data.
3. **Reclassify `-18019902`.** Remove it from the quota classification; treat it as
   "not registered yet" → `pending` (fast retry), since we already register bare first.
   Narrow the quota code set to the real account/quota codes only.

These make a transient 17track failure non-destructive and self-healing, and stop the
feature's extra load from degrading display quality.

## Out of scope

- `changecarrier` (we use additive `register`; keep as a possible cleanup later).
- Scraping / crawl changes.
- Display-layer redesign beyond the existing `inferred` / unverified badge.
- Refreshing inactive (resolved/no_reply_needed) threads — they intentionally do not
  refresh; non-destructive refresh only protects them from a *future* downgrade.

## Related

- PR #32 — carrier hint from URL (introduced the `gettrackinfo`-filter regression
  this design fixes).
- PR #34 — multi-tracking fallback used the wrong number (independent, shipped).
