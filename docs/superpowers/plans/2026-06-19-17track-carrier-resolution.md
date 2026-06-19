# 17track Carrier Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the correct carrier + live status for a tracking number reliably — auto-detect, query carrier-agnostically, recover mis-detected carriers via an additive hint, and never show another customer's parcel — with production metrics to measure it.

**Architecture:** The 17track adapter registers a number bare (auto-detect), reads `gettrackinfo` **without** a carrier filter (returns all registered carriers), and — only when the result is `NotFound` and a carrier hint is derivable — additively `register`s the hinted carrier and re-reads. A pure selection module corroborates each candidate's destination country against the order and picks a stable winner. New counters record resolution/hint/corroboration outcomes.

**Tech Stack:** TypeScript, Vitest (unit, no DB), 17track v2.2 API, in-process Prometheus registry.

Spec: [docs/superpowers/specs/2026-06-19-17track-carrier-resolution-design.md](../specs/2026-06-19-17track-carrier-resolution-design.md)

## Global Constraints

- TypeScript only. Run unit tests with `npm test -- <pattern>` (vitest, no DB). Full suite: `npm test`. Typecheck: `npm run typecheck`.
- Windows host; Bash tool is Git Bash. Use the project's npm scripts.
- Pre-existing typecheck errors in `app.inbox.tsx` and some scripts are tracked in `TECHNICAL_DEBT.md` — do NOT fix unrelated ones; only ensure your change adds none.
- Multi-tenant: nothing here is shop-scoped state, but the 17track key/breaker/semaphore are process-wide shared across shops — preserve the existing breaker/semaphore machinery exactly.
- Truth-seeking: never show a status for a carrier whose destination country contradicts the order. Prefer "unverified" over a confident wrong answer.
- Official 17track carrier codes (from `res.17track.net/asset/carrier/info/apicarrier.all.json`, retrieved 2026-06-19): Cainiao `190271`, La Poste/Colissimo `6051`, Australia Post `1151`, PostNL `14041`, Colis Privé `100027`, Chronopost `100273`, UPS `100002`.
- One commit per task, exactly as written. Do not squash.

## Shipping checkpoints (PR boundaries)

- **PR-1 (core, ship together):** Tasks 1–6. Fixes the #32 regression AND recovers AP/CK mis-detections. Tasks 1–5 are inert until Task 6 wires them, so they can land in one PR.
- **PR-2 (suivi):** Task 7 (metrics + dashboard doc).

Do not ship Tasks 1–5 alone to prod as a behaviour change; they only take effect once Task 6 wires the new flow.

---

### Task 1: Correct the carrier codes + guard them with a test

**Files:**
- Modify: `app/lib/support/tracking/adapters/seventeen-track.ts` (the `CARRIER_CODE_HINTS`, `CARRIER_NAME_MAP`, and `CARRIER_URL_HOSTS` tables)
- Test: `app/lib/support/tracking/adapters/__tests__/carrier-codes.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: corrected constants `CARRIER_CODE_HINTS`, `CARRIER_NAME_MAP`, `CARRIER_URL_HOSTS` exported for testing.

- [ ] **Step 1: Write the failing test**

Create `app/lib/support/tracking/adapters/__tests__/carrier-codes.test.ts`:

```ts
/**
 * Guards our hard-coded 17track carrier codes against the official list
 * (res.17track.net/asset/carrier/info/apicarrier.all.json, retrieved 2026-06-19).
 * No network: the official codes are pinned here as literals; if our tables
 * drift, this test fails and forces an intentional update.
 */
import { describe, it, expect } from "vitest";
import {
  CARRIER_CODE_HINTS,
  CARRIER_NAME_MAP,
  CARRIER_URL_HOSTS,
} from "../seventeen-track";

// name → official 17track code
const OFFICIAL: Record<string, number> = {
  Cainiao: 190271,
  "La Poste": 6051,
  "Australia Post": 1151,
  PostNL: 14041,
  "Colis Privé": 100027,
  Chronopost: 100273,
  UPS: 100002,
};

describe("carrier codes match the official 17track list", () => {
  it("CARRIER_URL_HOSTS use official codes", () => {
    const laposte = CARRIER_URL_HOSTS.find((h) => h.host === "laposte.fr");
    expect(laposte?.code).toBe(OFFICIAL["La Poste"]);
    const cainiao = CARRIER_URL_HOSTS.find((h) => h.host === "cainiao.com");
    expect(cainiao?.code).toBe(OFFICIAL["Cainiao"]);
    const ups = CARRIER_URL_HOSTS.find((h) => h.host === "ups.com");
    expect(ups?.code).toBe(OFFICIAL["UPS"]);
  });

  it("La Poste pattern hint uses 6051 (Colissimo), not 100068", () => {
    const laposteHints = CARRIER_CODE_HINTS.filter((h) => h.code === 100068);
    expect(laposteHints).toHaveLength(0);
    expect(CARRIER_CODE_HINTS.some((h) => h.code === 6051)).toBe(true);
  });

  it("Chronopost uses 100273, not 100174", () => {
    expect(CARRIER_CODE_HINTS.some((h) => h.code === 100174)).toBe(false);
    expect(CARRIER_CODE_HINTS.some((h) => h.code === 100273)).toBe(true);
  });

  it("CARRIER_NAME_MAP La Poste maps to 6051", () => {
    const entry = CARRIER_NAME_MAP.find((m) => m.keywords.test("Colissimo"));
    expect(entry?.code).toBe(6051);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- carrier-codes`
Expected: FAIL — current codes are `100068` (La Poste) and `100174` (Chronopost); `CARRIER_*` may not be exported yet.

- [ ] **Step 3: Correct the codes and export the tables**

In `seventeen-track.ts`:
- Add `export` to `CARRIER_CODE_HINTS`, `CARRIER_NAME_MAP`, and `CARRIER_URL_HOSTS` if not already exported.
- In `CARRIER_CODE_HINTS`: change the two La Poste entries `code: 100068` → `code: 6051`, and the Chronopost entry `code: 100174` → `code: 100273`.
- In `CARRIER_NAME_MAP`: change `{ keywords: /colissimo|la.?poste/i, code: 100068 }` → `code: 6051`, and `{ keywords: /chronopost/i, code: 100174 }` → `code: 100273`.
- In `CARRIER_URL_HOSTS`: change `{ host: "laposte.fr", code: 100068, ... }` → `code: 6051`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- carrier-codes seventeen-track provider-resolver`
Expected: PASS — codes corrected; existing `guessCarrierCode` tests for La Poste still pass (they assert the code value `6051`/`100273` indirectly only via the constants, so update any existing test that hard-codes `100068`/`100174` to the new values in the same commit).

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/tracking/adapters/seventeen-track.ts app/lib/support/tracking/adapters/__tests__/
git commit -m "fix(tracking): correct 17track carrier codes (Colissimo 6051, Chronopost 100273) + guard test"
```

---

### Task 2: Expose the recipient country from 17track (for corroboration)

**Files:**
- Modify: `app/lib/support/tracking/adapters/seventeen-track.ts` (`TrackInfo` interface + `parseTrackInfo` + `SevenTrackResult`)
- Test: `app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts` (the existing `parseTrackInfo` section)

**Interfaces:**
- Consumes: nothing.
- Produces: `SevenTrackResult` gains `recipientCountry: string | null` and `carrierCode: number | null`. `parseTrackInfoForTest(item)` returns them.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe("parseTrackInfo …")` block in `seventeen-track.test.ts`:

```ts
it("extracts recipient country and carrier code", () => {
  const result = parseTrackInfo({
    number: "X",
    carrier: 190271,
    track_info: {
      latest_status: { status: "Delivered" },
      latest_event: { description: "Delivered", time_iso: "2026-06-12T00:00:00Z" },
      shipping_info: { recipient_address: { country: "FR" } },
      tracking: { providers: [{ provider: { name: "Cainiao" }, events: [] }] },
    },
  } as unknown as Parameters<typeof parseTrackInfo>[0]);
  expect(result.recipientCountry).toBe("FR");
  expect(result.carrierCode).toBe(190271);
});

it("recipientCountry is null when absent", () => {
  const result = parseTrackInfo({
    number: "X",
    track_info: { latest_status: { status: "InTransit" } },
  } as unknown as Parameters<typeof parseTrackInfo>[0]);
  expect(result.recipientCountry).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- seventeen-track`
Expected: FAIL — `recipientCountry`/`carrierCode` are not on `SevenTrackResult`.

- [ ] **Step 3: Implement**

In `seventeen-track.ts`:
- Add to the `TrackInfo` interface: `shipping_info?: { recipient_address?: { country?: string }; shipper_address?: { country?: string } };`
- Add to `SevenTrackResult`: `recipientCountry: string | null;` and `carrierCode: number | null;`
- In `parseTrackInfo(item)`:
  - compute `const recipientCountry = info.shipping_info?.recipient_address?.country ?? null;`
  - add `recipientCountry` and `carrierCode: item.carrier ?? null` to the returned object.
  - In the early `if (!info)` return and any other `SevenTrackResult` literal in the file (the `pending` / `quota_exhausted` returns in `fetchTrackingFrom17track`), add `recipientCountry: null, carrierCode: null,` so the type compiles.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- seventeen-track`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/tracking/adapters/seventeen-track.ts app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts
git commit -m "feat(tracking): expose recipient country + carrier code from 17track"
```

---

### Task 3: Pure carrier-selection module (corroboration + stable pick)

**Files:**
- Create: `app/lib/support/tracking/carrier-selection.ts`
- Test: `app/lib/support/tracking/__tests__/carrier-selection.test.ts` (new)

**Interfaces:**
- Consumes: `SevenTrackResult` from `./adapters/seventeen-track` (has `status`, `recipientCountry`, `carrierCode`, `delivered`).
- Produces:
  ```ts
  export interface CarrierSelection { chosen: SevenTrackResult | null; unverified: boolean; corroborationMismatch: boolean; }
  export function selectCarrierCandidate(
    candidates: SevenTrackResult[],
    orderCountry: string | null,
    opts?: { hintCarrierCode?: number | null; previousCarrierCode?: number | null },
  ): CarrierSelection
  ```

- [ ] **Step 1: Write the failing tests**

Create `app/lib/support/tracking/__tests__/carrier-selection.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectCarrierCandidate } from "../carrier-selection";
import type { SevenTrackResult } from "../adapters/seventeen-track";

function cand(p: Partial<SevenTrackResult>): SevenTrackResult {
  return {
    state: "ok", carrierName: null, carrierCode: null, status: null,
    recipientCountry: null, lastEvent: null, lastLocation: null,
    lastEventDate: null, delivered: false, events: [], ...p,
  };
}

describe("selectCarrierCandidate", () => {
  it("drops a candidate whose recipient country contradicts the order", () => {
    const dpdDE = cand({ carrierCode: 100016, carrierName: "DPD (DE)", status: "Delivered", recipientCountry: "DE", delivered: true });
    const r = selectCarrierCandidate([dpdDE], "FR");
    expect(r.chosen).toBeNull();
    expect(r.corroborationMismatch).toBe(true);
  });

  it("picks the non-NotFound candidate over a NotFound one", () => {
    const postnl = cand({ carrierCode: 14041, status: "NotFound" });
    const cainiao = cand({ carrierCode: 190271, status: "InTransit", recipientCountry: "FR" });
    const r = selectCarrierCandidate([postnl, cainiao], "FR");
    expect(r.chosen?.carrierCode).toBe(190271);
    expect(r.unverified).toBe(false);
  });

  it("prefers a Delivered candidate (terminal, stable)", () => {
    const a = cand({ carrierCode: 1, status: "InTransit", recipientCountry: "FR", lastEventDate: "2026-06-18T00:00:00Z" });
    const b = cand({ carrierCode: 2, status: "Delivered", recipientCountry: "FR", delivered: true, lastEventDate: "2026-06-10T00:00:00Z" });
    const r = selectCarrierCandidate([a, b], "FR");
    expect(r.chosen?.carrierCode).toBe(2);
  });

  it("among non-delivered, prefers the hint carrier (stable identity, not recency)", () => {
    const a = cand({ carrierCode: 1, status: "InTransit", recipientCountry: "FR", lastEventDate: "2026-06-18T00:00:00Z" });
    const b = cand({ carrierCode: 190271, status: "InTransit", recipientCountry: "FR", lastEventDate: "2026-06-10T00:00:00Z" });
    const r = selectCarrierCandidate([a, b], "FR", { hintCarrierCode: 190271 });
    expect(r.chosen?.carrierCode).toBe(190271);
  });

  it("among non-delivered with no hint, prefers the previously chosen carrier", () => {
    const a = cand({ carrierCode: 1, status: "InTransit", recipientCountry: "FR" });
    const b = cand({ carrierCode: 2, status: "InTransit", recipientCountry: "FR" });
    const r = selectCarrierCandidate([a, b], "FR", { previousCarrierCode: 2 });
    expect(r.chosen?.carrierCode).toBe(2);
  });

  it("flags unverified when the chosen candidate has no recipient country", () => {
    const c = cand({ carrierCode: 190271, status: "InTransit", recipientCountry: null });
    const r = selectCarrierCandidate([c], "FR");
    expect(r.chosen?.carrierCode).toBe(190271);
    expect(r.unverified).toBe(true);
  });

  it("returns NotFound (chosen) when only NotFound candidates remain", () => {
    const c = cand({ carrierCode: 14041, status: "NotFound" });
    const r = selectCarrierCandidate([c], "FR");
    expect(r.chosen?.status).toBe("NotFound");
  });

  it("returns null chosen when there are no candidates", () => {
    expect(selectCarrierCandidate([], "FR").chosen).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- carrier-selection`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `app/lib/support/tracking/carrier-selection.ts`:

```ts
import type { SevenTrackResult } from "./adapters/seventeen-track";

export interface CarrierSelection {
  chosen: SevenTrackResult | null;
  /** Chosen but its recipient country was absent, so we could not corroborate. */
  unverified: boolean;
  /** Every candidate with data contradicted the order country (likely wrong parcel). */
  corroborationMismatch: boolean;
}

/**
 * Choose the carrier whose data we trust for a tracking number.
 *
 * 1. Corroboration: drop any candidate whose recipient country is present and
 *    differs from the order country (catches another customer's parcel).
 * 2. Among survivors with data (status !== "NotFound"), pick by a STABLE rule —
 *    never recency, which would make the displayed carrier oscillate between
 *    refreshes: Delivered (terminal) > hint carrier > previously-chosen carrier
 *    > first.
 * 3. If no survivor has data, return the first NotFound survivor (still NotFound).
 */
export function selectCarrierCandidate(
  candidates: SevenTrackResult[],
  orderCountry: string | null,
  opts: { hintCarrierCode?: number | null; previousCarrierCode?: number | null } = {},
): CarrierSelection {
  if (candidates.length === 0) {
    return { chosen: null, unverified: false, corroborationMismatch: false };
  }

  const contradicts = (c: SevenTrackResult) =>
    !!orderCountry && !!c.recipientCountry && c.recipientCountry !== orderCountry;

  const withData = candidates.filter((c) => c.status !== "NotFound");
  const corroborated = withData.filter((c) => !contradicts(c));

  if (withData.length > 0 && corroborated.length === 0) {
    // Every candidate with data points to a different country → likely wrong parcel.
    return { chosen: null, unverified: false, corroborationMismatch: true };
  }

  if (corroborated.length > 0) {
    const delivered = corroborated.find((c) => c.delivered || c.status === "Delivered");
    const hinted =
      opts.hintCarrierCode != null
        ? corroborated.find((c) => c.carrierCode === opts.hintCarrierCode)
        : undefined;
    const previous =
      opts.previousCarrierCode != null
        ? corroborated.find((c) => c.carrierCode === opts.previousCarrierCode)
        : undefined;
    const chosen = delivered ?? hinted ?? previous ?? corroborated[0];
    return { chosen, unverified: chosen.recipientCountry == null, corroborationMismatch: false };
  }

  // No candidate has data → keep a NotFound (prefer a corroboration-neutral one).
  const notFound = candidates.find((c) => !contradicts(c)) ?? candidates[0];
  return { chosen: notFound, unverified: false, corroborationMismatch: false };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- carrier-selection`
Expected: PASS — all 8 cases.

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/tracking/carrier-selection.ts app/lib/support/tracking/__tests__/carrier-selection.test.ts
git commit -m "feat(tracking): pure carrier-selection with country corroboration + stable pick"
```

---

### Task 4: Combined carrier hint (URL host + number pattern)

**Files:**
- Modify: `app/lib/support/tracking/adapters/seventeen-track.ts` (add `deriveCarrierHint`)
- Test: `app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts`

**Interfaces:**
- Consumes: existing `carrierCodeFromTrackingUrl` and `guessCarrierCode` (same file).
- Produces: `export function deriveCarrierHint(trackingNumber: string, trackingUrl?: string | null): number | null` — URL host first, then number pattern.

- [ ] **Step 1: Write the failing tests**

Add a `describe("deriveCarrierHint")` block to `seventeen-track.test.ts` (import `deriveCarrierHint` from `../seventeen-track`):

```ts
describe("deriveCarrierHint — URL host first, then number pattern", () => {
  it("uses the URL host when it is a known carrier (AP… + cainiao URL → Cainiao)", () => {
    expect(deriveCarrierHint("AP00819233764158", "https://global.cainiao.com/x")).toBe(190271);
  });
  it("falls back to the number pattern when the URL is unknown (CK… + postnl URL → Cainiao)", () => {
    expect(deriveCarrierHint("CK094884943NL", "https://jouw.postnl.nl/track-and-trace/")).toBe(190271);
  });
  it("uses the number pattern when there is no URL", () => {
    expect(deriveCarrierHint("CNFR9010529191101HD", null)).toBe(190271);
  });
  it("returns null when neither signal recognises the carrier", () => {
    expect(deriveCarrierHint("ZZ999", "https://shop.example.com/track")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- seventeen-track`
Expected: FAIL — `deriveCarrierHint` not defined.

- [ ] **Step 3: Implement**

In `seventeen-track.ts`, after `carrierCodeFromTrackingUrl`:

```ts
/**
 * Best-effort 17track carrier code for a number: the Shopify tracking-URL host
 * first (the merchant's de-facto declared carrier), then the number-format
 * pattern. Neither alone is sufficient — "AP…" has only the URL signal,
 * "CK…NL" has only the number-pattern signal (its URL is a misleading
 * last-mile page). Returns null when neither recognises the carrier.
 */
export function deriveCarrierHint(
  trackingNumber: string,
  trackingUrl?: string | null,
): number | null {
  return carrierCodeFromTrackingUrl(trackingUrl) ?? guessCarrierCode(trackingNumber);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- seventeen-track`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/tracking/adapters/seventeen-track.ts app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts
git commit -m "feat(tracking): deriveCarrierHint combines URL host and number pattern"
```

---

### Task 5: Rewrite the adapter flow — bare register, carrier-agnostic read, reactive additive hint

**Files:**
- Modify: `app/lib/support/tracking/adapters/seventeen-track.ts` (`fetchTrackingFrom17track`)
- Test: `app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts` (the `fetchTrackingFrom17track` describes)

**Interfaces:**
- Consumes: `deriveCarrierHint` (Task 4), `selectCarrierCandidate` (Task 3), `parseTrackInfo` with `recipientCountry`/`carrierCode` (Task 2).
- Produces: new signature
  ```ts
  export async function fetchTrackingFrom17track(
    trackingNumber: string,
    opts?: { param?: string | null; trackingUrl?: string | null; orderCountry?: string | null; previousCarrierCode?: number | null },
  ): Promise<SevenTrackResult | null>
  ```
  Returns the **selected** `SevenTrackResult` (with `recipientCountry`/`carrierCode`), or `null` on API failure, or a `state: "corroboration_mismatch"` result when every data candidate contradicts the order country.

- [ ] **Step 1: Write the failing tests**

First, **delete the two now-obsolete tests PR #32 added** (they assert the carrier code is in the *register* payload, but the baseline register is now bare — the hint only rides the reactive second register): remove `it("adds the carrier code to the register payload when the tracking URL maps to a known carrier", …)` and `it("omits the carrier code when the tracking URL is unknown/custom", …)`. Their intent is replaced by the new "does NOT send a carrier filter in the gettrackinfo payload" and "register-adds the hint" cases below.

Then, replace the body of `describe("fetchTrackingFrom17track — retry logic", …)` setup helpers so responses can carry multiple accepted carriers, and add these cases (keep the existing breaker tests, adapting calls to the new `opts` signature — e.g. `fetchTrackingFrom17track("LV109807596FR")` stays valid since `opts` is optional):

```ts
const MULTI_RESPONSE = {
  code: 0,
  data: {
    accepted: [
      { number: "CK1", carrier: 14041, track_info: { latest_status: { status: "NotFound" } } },
      { number: "CK1", carrier: 190271, track_info: {
        latest_status: { status: "InTransit" },
        latest_event: { description: "In transit", time_iso: "2026-06-11T00:00:00Z" },
        shipping_info: { recipient_address: { country: "FR" } },
        tracking: { providers: [{ provider: { name: "Cainiao" }, events: [] }] },
      } },
    ],
  },
};

it("does NOT send a carrier filter in the gettrackinfo payload", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(mockOkFetch({ code: 0 }) as unknown as Response)   // register
    .mockResolvedValueOnce(mockOkFetch(OK_RESPONSE) as unknown as Response);  // gettrackinfo
  await fetchTrackingFrom17track("LV109807596FR", { trackingUrl: "https://www.laposte.fr/x", param: "FR-75001" });
  const getInit = vi.mocked(fetch).mock.calls[1][1] as RequestInit; // 2nd call = gettrackinfo
  const body = JSON.parse(getInit.body as string);
  expect(body[0].carrier).toBeUndefined();
});

it("selects the non-NotFound carrier when gettrackinfo returns several", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(mockOkFetch({ code: 0 }) as unknown as Response)
    .mockResolvedValueOnce(mockOkFetch(MULTI_RESPONSE) as unknown as Response);
  const r = await fetchTrackingFrom17track("CK1", { orderCountry: "FR" });
  expect(r?.carrierCode).toBe(190271);
  expect(r?.status).toBe("InTransit");
});

it("on NotFound with a derivable hint, register-adds the hint and re-reads", async () => {
  const NF = { code: 0, data: { accepted: [{ number: "AP1", carrier: 1151, track_info: { latest_status: { status: "NotFound" } } }] } };
  const RECOVERED = { code: 0, data: { accepted: [
    { number: "AP1", carrier: 1151, track_info: { latest_status: { status: "NotFound" } } },
    { number: "AP1", carrier: 190271, track_info: { latest_status: { status: "Delivered" }, shipping_info: { recipient_address: { country: "FR" } }, tracking: { providers: [{ provider: { name: "Cainiao" }, events: [] }] } } },
  ] } };
  vi.mocked(fetch)
    .mockResolvedValueOnce(mockOkFetch({ code: 0 }) as unknown as Response)  // register bare
    .mockResolvedValueOnce(mockOkFetch(NF) as unknown as Response)           // gettrackinfo → NotFound
    .mockResolvedValueOnce(mockOkFetch({ code: 0 }) as unknown as Response)  // register-add hint
    .mockResolvedValueOnce(mockOkFetch(RECOVERED) as unknown as Response);   // gettrackinfo → recovered
  const r = await fetchTrackingFrom17track("AP1", { trackingUrl: "https://global.cainiao.com/x", orderCountry: "FR" });
  expect(r?.carrierCode).toBe(190271);
  expect(r?.status).toBe("Delivered");
  // the register-add call (3rd fetch) carried the hint code
  const addInit = vi.mocked(fetch).mock.calls[2][1] as RequestInit;
  expect(JSON.parse(addInit.body as string)[0].carrier).toBe(190271);
});

it("returns a corroboration_mismatch result when the only data contradicts the order country", async () => {
  const DE = { code: 0, data: { accepted: [{ number: "X", carrier: 100016, track_info: { latest_status: { status: "Delivered" }, shipping_info: { recipient_address: { country: "DE" } }, tracking: { providers: [{ provider: { name: "DPD (DE)" }, events: [] }] } } }] } };
  vi.mocked(fetch)
    .mockResolvedValueOnce(mockOkFetch({ code: 0 }) as unknown as Response)
    .mockResolvedValueOnce(mockOkFetch(DE) as unknown as Response);
  const r = await fetchTrackingFrom17track("X", { orderCountry: "FR" });
  expect(r?.state).toBe("corroboration_mismatch");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- seventeen-track`
Expected: FAIL — old signature/flow (carrier in gettrackinfo, single-pick, no reactive hint).

- [ ] **Step 3: Implement the new flow**

In `seventeen-track.ts`:
- Add `"corroboration_mismatch"` to the `SevenTrackResult.state` union.
- Import `selectCarrierCandidate` from `../carrier-selection`.
- Replace `fetchTrackingFrom17track` with the new signature and flow below. Keep the breaker/semaphore/`postJson`/poll machinery exactly; only the payloads, the multi-candidate handling, and the reactive hint change.

```ts
export async function fetchTrackingFrom17track(
  trackingNumber: string,
  opts: {
    param?: string | null;
    trackingUrl?: string | null;
    orderCountry?: string | null;
    previousCarrierCode?: number | null;
  } = {},
): Promise<SevenTrackResult | null> {
  const { param = null, trackingUrl = null, orderCountry = null, previousCarrierCode = null } = opts;
  const apiKey = getApiKey();
  if (!apiKey) return null;
  if (breakerOpen()) {
    console.log(`[17track] breaker open — skipping call for ${trackingNumber}`);
    return null;
  }

  const bare = [{ number: trackingNumber, ...(param ? { param } : {}) }];

  seventeenTrackQueued.inc();
  const release = await sevenTrackSem.acquire();
  seventeenTrackQueued.dec();
  seventeenTrackInFlight.inc();
  if (breakerOpen()) {
    seventeenTrackInFlight.dec();
    release();
    return null;
  }

  // Poll gettrackinfo (carrier-agnostic) up to MAX_POLL; returns the typed
  // outcome. `null` = API failure; "pending" / "quota_exhausted" passthrough;
  // otherwise the array of parsed candidates (possibly empty).
  const MAX_POLL = 3;
  const RETRY_DELAY_MS = 1500;
  async function poll(): Promise<SevenTrackResult[] | "pending" | "quota" | null> {
    for (let p = 1; p <= MAX_POLL; p++) {
      if (p > 1) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      const res = await postJson<ApiResponse>(`${BASE}/gettrackinfo`, bare, apiKey);
      const accepted = res.data?.accepted ?? [];
      const rejected = res.data?.rejected ?? [];
      if (accepted.length > 0) { breakerSuccess(); return accepted.map(parseTrackInfo); }
      const code = rejected[0]?.error?.code;
      if (code === -18019909) { if (p < MAX_POLL) continue; breakerSuccess(); return "pending"; }
      if (typeof code === "number" && (code === -18010008 || code === -18010009 || code === -18019902 || (code <= -18010000 && code >= -18019999))) {
        breakerSuccess(); return "quota";
      }
      console.warn("[17track] Unexpected rejection:", rejected[0]);
      breakerFailure(); return null;
    }
    return null;
  }

  function emptyState(state: SevenTrackResult["state"]): SevenTrackResult {
    return { state, carrierName: null, carrierCode: null, status: null, recipientCountry: null,
      lastEvent: null, lastLocation: null, lastEventDate: null, delivered: false, events: [] };
  }

  try {
    await postJson<ApiResponse>(`${BASE}/register`, bare, apiKey);
    let candidates = await poll();
    if (candidates === "pending") return emptyState("pending");
    if (candidates === "quota") return emptyState("quota_exhausted");
    if (candidates === null) return null;

    let selection = selectCarrierCandidate(candidates, orderCountry, { previousCarrierCode });

    // Reactive recovery: nothing usable AND we can derive a carrier hint not
    // already among the candidates → register-add the hint and re-read once.
    const noData = !selection.chosen || selection.chosen.status === "NotFound";
    const hint = deriveCarrierHint(trackingNumber, trackingUrl);
    const alreadyHave = hint != null && candidates.some((c) => c.carrierCode === hint);
    if (noData && hint != null && !alreadyHave && !selection.corroborationMismatch) {
      await postJson<ApiResponse>(`${BASE}/register`, [{ number: trackingNumber, carrier: hint, ...(param ? { param } : {}) }], apiKey);
      const recovered = await poll();
      if (Array.isArray(recovered)) {
        candidates = recovered;
        selection = selectCarrierCandidate(candidates, orderCountry, { hintCarrierCode: hint, previousCarrierCode });
      }
    }

    if (selection.corroborationMismatch) return emptyState("corroboration_mismatch");
    if (!selection.chosen) return emptyState("pending"); // registered but no data yet
    return { ...selection.chosen, inferredCarrier: selection.unverified } as SevenTrackResult;
  } catch (err) {
    console.error("[17track] Request failed:", err);
    breakerFailure();
    return null;
  } finally {
    release();
    seventeenTrackInFlight.dec();
  }
}
```

Also add `inferredCarrier?: boolean;` to `SevenTrackResult`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- seventeen-track`
Expected: PASS — new flow tests green; the existing breaker tests still pass (they call `fetchTrackingFrom17track("LV109807596FR")` with no opts and assert `null` when breaker open / fetch fails).

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/tracking/adapters/seventeen-track.ts app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts
git commit -m "feat(tracking): carrier-agnostic 17track read + reactive additive hint recovery"
```

---

### Task 6: Wire tracking-service to the new adapter (turns the flow on)

**Files:**
- Modify: `app/lib/support/tracking/tracking-service.ts`
- Test: `app/lib/support/tracking/__tests__/tracking-service-attempts.test.ts`

**Interfaces:**
- Consumes: new `fetchTrackingFrom17track(trackingNumber, opts)` (Task 5), `FulfillmentTrackingFacts` (existing).
- Produces: `resolveOneFulfillment` passes `{ param, trackingUrl, orderCountry, previousCarrierCode }`; maps `corroboration_mismatch` → Shopify fallback marked unverified; threads `inferredCarrier` into `inferred`.

- [ ] **Step 1: Write the failing test**

Add to `tracking-service-attempts.test.ts` (the mock already uses `vi.spyOn(adapter, "fetchTrackingFrom17track")`):

```ts
it("passes orderCountry and tracking URL to the adapter", async () => {
  const spy = vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
    state: "ok", carrierName: "Cainiao", carrierCode: 190271, status: "Delivered",
    recipientCountry: "FR", lastEvent: null, lastLocation: null, lastEventDate: null,
    delivered: true, events: [],
  } as unknown as Awaited<ReturnType<typeof adapter.fetchTrackingFrom17track>>);
  const order = makeOrder();
  (order as unknown as { destinationCountry: string }).destinationCountry = "FR";
  order.fulfillments[0].trackingUrls = ["https://global.cainiao.com/x"];
  await getTrackingFacts(order);
  expect(spy).toHaveBeenCalledWith("LV109807596FR", expect.objectContaining({ orderCountry: "FR", trackingUrl: "https://global.cainiao.com/x" }));
});

it("marks the fact unverified when the adapter returns corroboration_mismatch", async () => {
  vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
    state: "corroboration_mismatch", carrierName: null, carrierCode: null, status: null,
    recipientCountry: null, lastEvent: null, lastLocation: null, lastEventDate: null,
    delivered: false, events: [],
  } as unknown as Awaited<ReturnType<typeof adapter.fetchTrackingFrom17track>>);
  const [t] = await getTrackingFacts(makeOrder());
  expect(t.source).not.toBe("seventeen_track");
  expect(t.inferred).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tracking-service-attempts`
Expected: FAIL — adapter currently called with positional args; no `corroboration_mismatch` handling.

- [ ] **Step 3: Implement**

In `tracking-service.ts`, inside `resolveOneFulfillment`:
- Add `orderCountry` and `previousCarrierCode` parameters threaded from `getTrackingFacts` (the order has `destinationCountry`; `previousCarrierCode` may be `null` for now — leave a typed param defaulting to `null`).
- Change the adapter call to:
  ```ts
  const result = await fetchTrackingFrom17track(trackingNumber, {
    param,
    trackingUrl,
    orderCountry,
    previousCarrierCode,
  });
  ```
- Handle the new `state`:
  - `result.state === "corroboration_mismatch"` → use the Shopify fallback (`resolveTrackingForFulfillment(fulfillment, trackingNumber, trackingUrl)`), set `inferred: true`, `last17trackAttempt: "ok"`.
  - In the `state === "ok"` branch, set `inferred: result.inferredCarrier ?? false` (instead of `false`).
- In `getTrackingFacts`, pass `order.destinationCountry ?? null` as `orderCountry` for every fulfillment task; pass `previousCarrierCode: null`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tracking-service-attempts tracking provider-resolver`
Expected: PASS — including the existing attempt-stamping tests.

- [ ] **Step 5: Run the whole suite + typecheck**

Run: `npm test` then `npm run typecheck`
Expected: PASS (no new typecheck errors).

- [ ] **Step 6: Commit**

```bash
git add app/lib/support/tracking/tracking-service.ts app/lib/support/tracking/__tests__/tracking-service-attempts.test.ts
git commit -m "feat(tracking): wire tracking-service to carrier-agnostic resolution + corroboration"
```

---

### Task 7: Production metrics — the "suivi"

**Files:**
- Modify: `app/lib/metrics/definitions.ts` (add 3 counters)
- Modify: `app/lib/support/tracking/tracking-service.ts` (increment them)
- Modify: `docs/metrics-dashboard.md` (document them)
- Test: `app/lib/support/tracking/__tests__/tracking-service-attempts.test.ts`

**Interfaces:**
- Consumes: the metrics registry pattern already used for `seventeenTrackInFlight` etc. in `definitions.ts`.
- Produces: counters `trackingResolutionTotal`, `trackingHintTotal`, `trackingCorroborationTotal`.

- [ ] **Step 1: Inspect the existing counter pattern**

Run: `npm test -- tracking-service-attempts` is not needed here; first read `app/lib/metrics/definitions.ts` and copy the exact factory used for an existing labelled counter (e.g. how `seventeenTrackInFlight` is declared). Use the same `registry`/`counter(...)` helper and naming convention.

- [ ] **Step 2: Write the failing test**

Add to `tracking-service-attempts.test.ts`:

```ts
import { trackingResolutionTotal } from "../../../metrics/definitions";

it("increments tracking_resolution_total with the outcome", async () => {
  const before = trackingResolutionTotal.labels({ outcome: "ok_auto" }).get?.() ?? 0;
  vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
    state: "ok", carrierName: "Cainiao", carrierCode: 190271, status: "Delivered",
    recipientCountry: "FR", lastEvent: null, lastLocation: null, lastEventDate: null,
    delivered: true, events: [],
  } as unknown as Awaited<ReturnType<typeof adapter.fetchTrackingFrom17track>>);
  await getTrackingFacts(makeOrder());
  const after = trackingResolutionTotal.labels({ outcome: "ok_auto" }).get?.() ?? 0;
  expect(after).toBeGreaterThan(before);
});
```

(If the registry's counter API differs from `.labels().get()`, adapt the assertion to the existing test helpers used elsewhere for counters — check `app/lib/metrics/__tests__` for the read pattern.)

- [ ] **Step 3: Implement**

- In `definitions.ts`, declare (matching the existing factory signature):
  ```ts
  export const trackingResolutionTotal = counter("tracking_resolution_total", "17track resolution outcome", ["outcome"]);
  export const trackingHintTotal = counter("tracking_hint_total", "carrier hint outcome", ["source", "result"]);
  export const trackingCorroborationTotal = counter("tracking_corroboration_total", "country corroboration outcome", ["result"]);
  ```
- In `tracking-service.ts` `resolveOneFulfillment`, after the adapter returns, increment `trackingResolutionTotal` with `outcome`:
  - `state==="ok"` & `inferredCarrier` falsy → `ok_auto` (or `ok_hint_recovered` if you can tell a hint was used — keep it simple: `ok_auto` for now, refine later).
  - `status==="NotFound"` → `notfound`; `state==="pending"` → `pending`; `state==="corroboration_mismatch"` → increment `trackingCorroborationTotal{result:"mismatch_rejected"}`; `result===null`/error → `error`.
  - when `inferredCarrier` is set → `trackingCorroborationTotal{result:"absent_unverified"}`; when country matched → `{result:"match"}`.

  Keep the increments minimal and outside the hot loop's error paths so a metrics bug can never break tracking (wrap in nothing fancy — these are sync counter `.inc()` calls).

- In `docs/metrics-dashboard.md`, add a short "Tracking carrier resolution" subsection listing the three counters, their labels, and what a healthy vs degrading reading looks like (rising `notfound` with low `ok_hint_recovered` = hint coverage gap; rising `mismatch_rejected` = wrong-parcel catches).

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tracking-service-attempts` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/metrics/definitions.ts app/lib/support/tracking/tracking-service.ts docs/metrics-dashboard.md app/lib/support/tracking/__tests__/tracking-service-attempts.test.ts
git commit -m "feat(tracking): metrics for resolution/hint/corroboration outcomes (suivi)"
```

---

## Self-Review notes

- **Spec coverage:** Step 1 carrier-agnostic read (Task 5/6); Step 2 reactive additive hint (Tasks 4+5); Step 3 stable selection + corroboration (Task 3); Step 4 unverified honesty (Tasks 3/5/6); correct codes + guard (Task 1); recipient country (Task 2); monitoring (Task 7); generalization is behavioural (graceful degradation falls out of `deriveCarrierHint` returning null + corroboration). All covered.
- **changecarrier / re-registration of `-18019902` / scraping** are explicitly out of scope per the spec — not in the plan.
- **Type consistency:** `SevenTrackResult` gains `recipientCountry`, `carrierCode`, `inferredCarrier`, and the `state` union gains `"corroboration_mismatch"` (Tasks 2 & 5). `selectCarrierCandidate` signature is identical in Task 3 (definition) and Task 5 (call). `fetchTrackingFrom17track(trackingNumber, opts)` is identical in Task 5 (definition) and Task 6 (call).
- **Carefulness:** the breaker/semaphore/poll machinery is preserved; metrics increments are pure counter `.inc()` and never gate tracking; nothing ships as a behaviour change until Task 6 wires it; corroboration prevents confident-wrong output (the core-of-app safety property).
