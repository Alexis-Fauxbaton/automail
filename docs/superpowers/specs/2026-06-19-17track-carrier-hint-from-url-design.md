# 17track carrier hint from Shopify tracking URL — design

> Date: 2026-06-19
> Status: approved, pending implementation

## Problem

For some shipments, 17track shows the wrong carrier and a `NotFound` status, while
the "Voir le suivi" link correctly opens the real carrier page. Observed on order
`#257371322` (shop ambienthome / automail-test):

| Numéro | Statut affiché | Lien "Voir le suivi" |
|---|---|---|
| `CNFR9010529191101HD` | Cainiao / Livré | `global.cainiao.com` |
| `AP00819233764158` | **Australia Post / NotFound** | `global.cainiao.com` |
| `AP00821989482226` | **Australia Post / NotFound** | `global.cainiao.com` |

The displayed carrier/status comes from 17track; the link comes from Shopify's
tracking URL. They disagree.

### Root cause

The `AP…` numbers are Cainiao shipments whose number format looks like Australia
Post. When we register a number with 17track we send **no carrier hint**, so
17track auto-detects from the number format and picks Australia Post → `NotFound`.

The two other signals we have don't help:
- The number itself: `AP…` genuinely looks like Australia Post — undeducible.
- Shopify's `trackingInfo.company`: it is `"Other"` for all three — useless.

The only reliable signal is the **Shopify tracking URL host**: all three point to
`global.cainiao.com`. The URL doesn't lie.

A carrier-hint mechanism already exists (`guessCarrierCode`) but is **dead code**:
the parameter in `fetchTrackingFrom17track` is prefixed `_` and never used, and the
`/register` payload only sends `{ number, param }`.

## Decision

Add **only** a URL-host → 17track carrier-code hint, tried first, as a safety net.
Everything else stays exactly as today. Specifically:

- We do **not** activate the existing number-pattern / company-name hint
  (`guessCarrierCode`) — it stays dead. This avoids any regression on cases that
  already resolve correctly via 17track auto-detection.
- We do **not** change carrier/status display logic. Once 17track is queried
  against the right carrier, it returns the correct name and status on its own.
- Custom / aggregator / merchant-domain tracking URLs we don't recognise →
  no hint → identical to current behaviour. No regression.

## Design

### New: `carrierCodeFromTrackingUrl(url)`

In [app/lib/support/tracking/adapters/seventeen-track.ts](../../../app/lib/support/tracking/adapters/seventeen-track.ts):

```ts
export function carrierCodeFromTrackingUrl(url: string | null | undefined): number | null
```

Backed by a curated allowlist of carrier hostnames → 17track numeric code. Matching
is on the URL **host** with an exact host or exact suffix (`host === h || host.endsWith("." + h)`),
never a loose substring, so a merchant's custom domain can't accidentally match.

Starter allowlist (extensible):

| Host | Code | Carrier |
|---|---|---|
| `global.cainiao.com` | 190271 | Cainiao |
| `cainiao.com` | 190271 | Cainiao |
| `laposte.fr` | 100068 | La Poste |
| `ups.com` | 100002 | UPS |

Returns `null` when the URL is absent, unparsable, or the host isn't in the allowlist.

### Wiring into 17track register

`fetchTrackingFrom17track` gains a real tracking-URL argument (replacing the unused
`_carrierNameHint`, or added alongside — implementation detail for the plan). Inside:

```ts
const carrierCode = carrierCodeFromTrackingUrl(trackingUrl);
const payload = [{
  number: trackingNumber,
  ...(param ? { param } : {}),
  ...(carrierCode ? { carrier: carrierCode } : {}),
}];
```

When `carrierCode` is `null` the payload is byte-for-byte what it is today.

[tracking-service.ts](../../../app/lib/support/tracking/tracking-service.ts) passes the
Shopify tracking URL (already resolved as `trackingUrl` in `resolveOneFulfillment`)
into the adapter call at line ~48.

### What stays unchanged

- `guessCarrierCode` and its number-pattern / company-name maps: untouched, still
  exported and tested, still not wired into the register call.
- Display priority in `tracking-service.ts` (`result.carrierName ?? fulfillment.carrier`)
  and `SupportAnalysisDisplay.tsx`: untouched.
- Adaptive retry / breaker / semaphore behaviour: untouched.

## Effect on the reported case

`AP00819233764158` has URL `global.cainiao.com` → code `190271` sent to 17track →
Cainiao network queried → real status instead of "Australia Post / NotFound".

## Testing

Unit tests in the existing
[adapters/__tests__/seventeen-track.test.ts](../../../app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts):

- `carrierCodeFromTrackingUrl("https://global.cainiao.com/newDetail.htm?...")` → `190271`
- exact-host match for `cainiao.com`, `laposte.fr`, `ups.com`
- merchant custom domain (e.g. `https://shop.example.com/apps/track?n=...`) → `null`
- aggregator we don't map (e.g. `https://t.17track.net/...`) → `null`
- `null` / `""` / malformed URL → `null`
- regression: an `AP…` number paired with a `global.cainiao.com` URL resolves to
  Cainiao (`190271`), not Australia Post.

No integration/DB test needed (pure function + payload shaping).

## Out of scope (explicitly deferred)

- Display-honesty layer (suppressing a misleading carrier/status on `NotFound`).
- Reactive re-register on `NotFound`.
- Activating the number-pattern / company-name hint.
- Logging unmapped tracking hosts to grow the allowlist (nice-to-have, later).
