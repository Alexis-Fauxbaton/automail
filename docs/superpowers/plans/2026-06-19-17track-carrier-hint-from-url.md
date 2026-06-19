# 17track Carrier Hint From URL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell 17track the real carrier (derived from the Shopify tracking URL host) so Cainiao-style `AP…` numbers resolve against Cainiao instead of being mis-detected as Australia Post / NotFound.

**Architecture:** Add a pure `carrierCodeFromTrackingUrl(url)` helper backed by a curated host→17track-code allowlist. Wire it into the `/register` payload of `fetchTrackingFrom17track` (a `carrier` field, added only when the host is recognised). Pass the Shopify tracking URL from `tracking-service` into the adapter. No other behaviour changes — unknown/custom/aggregator hosts produce no hint and fall back to today's 17track auto-detection.

**Tech Stack:** TypeScript, Vitest (unit, no DB), 17track v2.2 API.

Spec: [docs/superpowers/specs/2026-06-19-17track-carrier-hint-from-url-design.md](../specs/2026-06-19-17track-carrier-hint-from-url-design.md)

---

### Task 1: `carrierCodeFromTrackingUrl` pure helper

**Files:**
- Modify: `app/lib/support/tracking/adapters/seventeen-track.ts` (add near `guessCarrierCode`, ~line 256)
- Test: `app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts` (add to the existing pure-function section, before the `fetchTrackingFrom17track` describe block at line 344)

- [ ] **Step 1: Write the failing tests**

Add this `describe` block after the existing `guessCarrierCode` blocks (around line 175, before the `parseTrackInfo` section) in `seventeen-track.test.ts`. Also add `carrierCodeFromTrackingUrl` to the import from `../seventeen-track` at the top of the file (the import block at lines 21-25).

```ts
describe("carrierCodeFromTrackingUrl — host allowlist", () => {
  it("maps a global.cainiao.com URL to Cainiao (190271)", () => {
    expect(
      carrierCodeFromTrackingUrl(
        "https://global.cainiao.com/newDetail.htm?mailNoList=AP00819233764158",
      ),
    ).toBe(190271);
  });

  it("maps a bare cainiao.com host to Cainiao (190271)", () => {
    expect(carrierCodeFromTrackingUrl("https://cainiao.com/x")).toBe(190271);
  });

  it("maps laposte.fr to La Poste (100068)", () => {
    expect(carrierCodeFromTrackingUrl("https://www.laposte.fr/outils/suivre?code=x")).toBe(100068);
  });

  it("maps ups.com to UPS (100002)", () => {
    expect(carrierCodeFromTrackingUrl("https://www.ups.com/track?tracknum=x")).toBe(100002);
  });

  it("returns null for a merchant custom domain", () => {
    expect(carrierCodeFromTrackingUrl("https://shop.example.com/apps/track?n=x")).toBeNull();
  });

  it("returns null for an aggregator we do not map", () => {
    expect(carrierCodeFromTrackingUrl("https://t.17track.net/en#nums=x")).toBeNull();
  });

  it("does not match a look-alike suffix (notcainiao.com)", () => {
    expect(carrierCodeFromTrackingUrl("https://notcainiao.com/x")).toBeNull();
  });

  it("returns null for null, empty, or malformed input", () => {
    expect(carrierCodeFromTrackingUrl(null)).toBeNull();
    expect(carrierCodeFromTrackingUrl("")).toBeNull();
    expect(carrierCodeFromTrackingUrl("not a url")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- seventeen-track`
Expected: FAIL — `carrierCodeFromTrackingUrl is not exported` / not defined (compile error in the test file).

- [ ] **Step 3: Implement the helper**

In `seventeen-track.ts`, add immediately after the `guessCarrierCode` function (after line 256):

```ts
// ---------------------------------------------------------------------------
// Carrier hint from the Shopify tracking URL host.
//
// The tracking number alone is often ambiguous (e.g. an "AP…" Cainiao number
// looks like Australia Post), and Shopify's `company` field is frequently
// "Other". The Shopify tracking URL host, when it is a real carrier domain, is
// the merchant's de-facto declared carrier — the same link shown as "Voir le
// suivi". We map a curated allowlist of carrier hosts to 17track codes and pass
// that as a register hint. Unknown hosts return null → no hint → 17track
// auto-detects exactly as before. See spec 2026-06-19.
// ---------------------------------------------------------------------------
const CARRIER_URL_HOSTS: Array<{ host: string; code: number; name: string }> = [
  { host: "cainiao.com", code: 190271, name: "Cainiao" }, // covers global.cainiao.com
  { host: "laposte.fr",  code: 100068, name: "La Poste" },
  { host: "ups.com",     code: 100002, name: "UPS" },
];

/**
 * Return the 17track carrier code for a Shopify tracking URL whose host is a
 * known carrier domain, or null otherwise. Matches on exact host or exact
 * dot-boundary suffix (so "notcainiao.com" never matches "cainiao.com").
 */
export function carrierCodeFromTrackingUrl(
  url: string | null | undefined,
): number | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const { host: h, code } of CARRIER_URL_HOSTS) {
    if (host === h || host.endsWith("." + h)) return code;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- seventeen-track`
Expected: PASS — all `carrierCodeFromTrackingUrl` cases green, existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/tracking/adapters/seventeen-track.ts app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts
git commit -m "feat(tracking): carrierCodeFromTrackingUrl host allowlist helper"
```

---

### Task 2: Pass the carrier hint into the 17track register payload

**Files:**
- Modify: `app/lib/support/tracking/adapters/seventeen-track.ts:262-276` (`fetchTrackingFrom17track` signature + payload)
- Test: `app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts` (add to the `fetchTrackingFrom17track — retry logic` describe, after line 396)

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the existing `describe("fetchTrackingFrom17track — retry logic", ...)` block (after the "returns parsed result…" test at line 396):

```ts
it("adds the carrier code to the register payload when the tracking URL maps to a known carrier", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(mockOkFetch({ code: 0 }) as unknown as Response)   // register
    .mockResolvedValueOnce(mockOkFetch(OK_RESPONSE) as unknown as Response);  // gettrackinfo

  await fetchTrackingFrom17track(
    "AP00819233764158",
    null,
    "FR-91120",
    "https://global.cainiao.com/newDetail.htm?mailNoList=AP00819233764158",
  );

  const registerInit = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
  const body = JSON.parse(registerInit.body as string);
  expect(body[0].carrier).toBe(190271);
  expect(body[0].param).toBe("FR-91120");
});

it("omits the carrier code when the tracking URL is unknown/custom", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(mockOkFetch({ code: 0 }) as unknown as Response)
    .mockResolvedValueOnce(mockOkFetch(OK_RESPONSE) as unknown as Response);

  await fetchTrackingFrom17track(
    "LV109807596FR",
    null,
    null,
    "https://shop.example.com/apps/track?n=LV109807596FR",
  );

  const registerInit = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
  const body = JSON.parse(registerInit.body as string);
  expect(body[0].carrier).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- seventeen-track`
Expected: FAIL — `body[0].carrier` is `undefined` in the first test (payload doesn't include the hint yet).

- [ ] **Step 3: Implement the payload change**

In `seventeen-track.ts`, update the signature (lines 262-268) — rename the unused `_carrierNameHint` stays as-is, add a 4th `trackingUrl` param:

```ts
export async function fetchTrackingFrom17track(
  trackingNumber: string,
  _carrierNameHint?: string | null,
  /** "<Alpha-2 country>-<postal code>" (e.g. "FR-75001"). Required by some
   *  carriers (Cainiao / postal) to register a number; ignored by the rest. */
  param?: string | null,
  /** Shopify tracking URL — its host, when a known carrier domain, gives 17track
   *  a carrier hint so ambiguous numbers resolve against the right carrier. */
  trackingUrl?: string | null,
): Promise<SevenTrackResult | null> {
```

Then replace the payload line (currently line 276):

```ts
  const carrierCode = carrierCodeFromTrackingUrl(trackingUrl);
  const payload = [
    {
      number: trackingNumber,
      ...(param ? { param } : {}),
      ...(carrierCode ? { carrier: carrierCode } : {}),
    },
  ];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- seventeen-track`
Expected: PASS — both new tests green, all existing `fetchTrackingFrom17track` tests still green (they pass no `trackingUrl`, so `carrierCode` is null and the payload is unchanged).

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/tracking/adapters/seventeen-track.ts app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts
git commit -m "feat(tracking): pass URL-derived carrier hint to 17track register"
```

---

### Task 3: Wire the Shopify tracking URL through `tracking-service`

**Files:**
- Modify: `app/lib/support/tracking/tracking-service.ts:48` (the `fetchTrackingFrom17track` call inside `resolveOneFulfillment`)

- [ ] **Step 1: Update the call site**

In `tracking-service.ts`, `resolveOneFulfillment` already receives `trackingUrl` as a parameter (line 28). Update the call on line 48 from:

```ts
    const result = await fetchTrackingFrom17track(trackingNumber, fulfillment.carrier ?? null, param);
```

to:

```ts
    const result = await fetchTrackingFrom17track(trackingNumber, fulfillment.carrier ?? null, param, trackingUrl);
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no new errors from this change; pre-existing tracked errors in `app.inbox.tsx`/scripts are unrelated — do not fix them).

- [ ] **Step 3: Run the full tracking test suite**

Run: `npm test -- tracking`
Expected: PASS — `seventeen-track`, `provider-resolver`, and `tracking-service-attempts` suites all green.

- [ ] **Step 4: Commit**

```bash
git add app/lib/support/tracking/tracking-service.ts
git commit -m "feat(tracking): forward Shopify tracking URL to 17track for carrier hinting"
```

---

### Task 4: Full verification

- [ ] **Step 1: Run the whole unit suite**

Run: `npm test`
Expected: PASS — no regressions across the suite.

- [ ] **Step 2: Confirm the spec's reported case is covered**

The regression test in Task 2 (`AP00819233764158` + `global.cainiao.com` URL → `carrier: 190271` in the register payload) is the codified proof of the fix. Live 17track behaviour was already validated manually during design (returns Cainiao / Delivered). No further live call needed.

---

## Self-Review notes

- **Spec coverage:** host allowlist helper (Task 1), register-payload wiring (Task 2), URL forwarded from service (Task 3), no-regression fallback when host unknown (Task 2 second test + existing tests). All spec sections covered.
- **Out-of-scope items** (display-honesty layer, reactive re-register, number-pattern hint activation, unmapped-host logging) are intentionally NOT in this plan, matching the spec.
- **Type consistency:** `carrierCodeFromTrackingUrl(url: string | null | undefined): number | null` used identically in Task 1 (definition) and Task 2 (call). `fetchTrackingFrom17track` 4th param `trackingUrl?: string | null` matches the `trackingUrl` already typed in `resolveOneFulfillment`.
- **Codes reused** from existing `CARRIER_NAME_MAP`: Cainiao 190271, La Poste 100068, UPS 100002 — consistent.
