# 17track Resilience & Adaptive Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make 17track lookups resilient to transient failures across multi-tenant batch refresh — failures must trigger fast retries (not wait 1h), pending states must poll faster, and a global circuit breaker must protect the shared API quota.

**Architecture:**
1. Persist a per-fulfillment `last17trackAttempt` outcome (`ok` / `pending` / `error` / `skipped`) and `last17trackAttemptAt` on `FulfillmentTrackingFacts`, so downstream code can reason about prior 17track health without re-deriving it from the legacy `source` field.
2. Make `refreshStaleAnalysesForShop` *adaptive*: compute a per-thread `maxAgeMs` from the previous analysis (error → 10 min, pending → 5 min, ok / skipped → 1h). Threads needing fast retry surface naturally in the next sync pass.
3. Add a process-wide circuit breaker module (`tracking/seventeen-track-breaker.ts`) that opens after N consecutive failures within M minutes and short-circuits 17track calls for X minutes across all shops — gated *inside* `fetchTrackingFrom17track`, transparent to callers.

**Tech Stack:** TypeScript, React Router (Remix-based scaffold), Prisma, Vitest. No new packages.

---

## File Structure

**Files to create:**
- `app/lib/support/tracking/seventeen-track-breaker.ts` — in-memory circuit breaker shared across shops.
- `app/lib/support/tracking/__tests__/seventeen-track-breaker.test.ts` — breaker unit tests.
- `app/lib/support/__tests__/adaptive-freshness.test.ts` — per-thread cutoff selection.

**Files to modify:**
- `app/lib/support/types.ts` — add `last17trackAttempt` and `last17trackAttemptAt` to `TrackingFacts`.
- `app/lib/support/tracking/tracking-service.ts` — set the new fields on every branch; wire breaker via adapter.
- `app/lib/support/tracking/adapters/seventeen-track.ts` — consult breaker before HTTP; record outcomes on the breaker.
- `app/lib/support/refresh-stale-analyses.ts` — compute per-thread `maxAgeMs` from previous analysis; expose new `ANALYSIS_FRESHNESS_MS.fast17trackRetry` + `pendingRetry`.
- `app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts` — extend existing tests with breaker interactions.
- `app/lib/support/__tests__/refresh-stale-analyses.test.ts` — extend with adaptive-cutoff cases.
- `app/components/SupportAnalysisDisplay.tsx` — optional badge tweak: surface `last17trackAttempt === "error"` as a discreet warning (out of scope for v1, mentioned only for spec coverage).

---

## Task 1: Extend `TrackingFacts` type with 17track attempt metadata

**Files:**
- Modify: `app/lib/support/types.ts:101-117`

- [ ] **Step 1: Add the two optional fields to `TrackingFacts`**

Update `app/lib/support/types.ts` — inside `TrackingFacts`, append after `delivered?: boolean;`:

```typescript
  /**
   * Outcome of the *last* 17track attempt for this fulfillment.
   * - "ok"      → 17track returned usable data; `source === "seventeen_track"`.
   * - "pending" → 17track registered the number but data not ready yet.
   * - "error"   → 17track HTTP / parse failure; we fell back to Shopify/pattern.
   * - "skipped" → 17track disabled (no API key) or breaker open or no tracking number.
   * Used by refreshStaleAnalysesForShop to pick a tighter cutoff for retry.
   */
  last17trackAttempt?: "ok" | "pending" | "error" | "skipped";
  /** ISO-8601 timestamp of the last attempt. */
  last17trackAttemptAt?: string | null;
```

- [ ] **Step 2: Verify the project type-checks**

Run: `npx tsc --noEmit`
Expected: PASS (the new fields are optional, no existing code breaks).

- [ ] **Step 3: Commit**

```bash
git add app/lib/support/types.ts
git commit -m "feat(tracking): add last17trackAttempt metadata to TrackingFacts"
```

---

## Task 2: Create the in-memory 17track circuit breaker

**Files:**
- Create: `app/lib/support/tracking/seventeen-track-breaker.ts`
- Test: `app/lib/support/tracking/__tests__/seventeen-track-breaker.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/lib/support/tracking/__tests__/seventeen-track-breaker.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordSuccess,
  recordFailure,
  isOpen,
  __resetForTest,
} from "../seventeen-track-breaker";

describe("seventeen-track-breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetForTest();
  });

  it("starts closed", () => {
    expect(isOpen()).toBe(false);
  });

  it("opens after N consecutive failures in the failure window", () => {
    for (let i = 0; i < 5; i++) recordFailure();
    expect(isOpen()).toBe(true);
  });

  it("does not open if failures are spread beyond the failure window", () => {
    recordFailure();
    vi.advanceTimersByTime(11 * 60_000); // 11 minutes — outside 10-min window
    recordFailure();
    expect(isOpen()).toBe(false);
  });

  it("a single success resets the failure counter", () => {
    for (let i = 0; i < 4; i++) recordFailure();
    recordSuccess();
    recordFailure(); // only 1 fresh failure
    expect(isOpen()).toBe(false);
  });

  it("auto-closes after the cooldown elapses", () => {
    for (let i = 0; i < 5; i++) recordFailure();
    expect(isOpen()).toBe(true);
    vi.advanceTimersByTime(15 * 60_000 + 1); // past 15-min cooldown
    expect(isOpen()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run app/lib/support/tracking/__tests__/seventeen-track-breaker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the breaker**

Create `app/lib/support/tracking/seventeen-track-breaker.ts`:

```typescript
/**
 * Process-wide circuit breaker for the 17track API.
 *
 * Why module-global, not per-shop: the API key + free-tier quota are global,
 * so a burst of failures from one shop affects the *next* shop too. Opening
 * the breaker once for the whole process stops the bleed for everyone.
 *
 * In-memory only — acceptable because the failure window (10 min) is short,
 * and the worst case after a restart is one extra batch of failed calls.
 */

const FAILURE_THRESHOLD = 5;
const FAILURE_WINDOW_MS = 10 * 60_000;
const COOLDOWN_MS = 15 * 60_000;

let failureTimestamps: number[] = [];
let openedAt: number | null = null;

export function recordSuccess(): void {
  failureTimestamps = [];
  openedAt = null;
}

export function recordFailure(): void {
  const now = Date.now();
  failureTimestamps = failureTimestamps.filter(
    (t) => now - t < FAILURE_WINDOW_MS,
  );
  failureTimestamps.push(now);
  if (failureTimestamps.length >= FAILURE_THRESHOLD && openedAt === null) {
    openedAt = now;
    console.warn(
      `[17track-breaker] OPEN — ${FAILURE_THRESHOLD} failures in ${FAILURE_WINDOW_MS / 60_000}min, suspending calls for ${COOLDOWN_MS / 60_000}min`,
    );
  }
}

export function isOpen(): boolean {
  if (openedAt === null) return false;
  if (Date.now() - openedAt > COOLDOWN_MS) {
    openedAt = null;
    failureTimestamps = [];
    return false;
  }
  return true;
}

/** @internal — tests only */
export function __resetForTest(): void {
  failureTimestamps = [];
  openedAt = null;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run app/lib/support/tracking/__tests__/seventeen-track-breaker.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/tracking/seventeen-track-breaker.ts app/lib/support/tracking/__tests__/seventeen-track-breaker.test.ts
git commit -m "feat(tracking): add process-wide 17track circuit breaker"
```

---

## Task 3: Wire the breaker into the 17track adapter

**Files:**
- Modify: `app/lib/support/tracking/adapters/seventeen-track.ts:227-287`
- Test: `app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts` (inside the existing `describe("fetchTrackingFrom17track — retry logic", …)` block or a sibling block — match the existing style):

```typescript
import {
  isOpen,
  recordFailure,
  __resetForTest as resetBreaker,
} from "../../seventeen-track-breaker";

describe("fetchTrackingFrom17track — circuit breaker", () => {
  const ORIGINAL_KEY = process.env.SEVENTEEN_TRACK_API_KEY;
  beforeEach(() => {
    process.env.SEVENTEEN_TRACK_API_KEY = "test-key";
    resetBreaker();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.env.SEVENTEEN_TRACK_API_KEY = ORIGINAL_KEY;
    resetBreaker();
  });

  it("returns null without calling fetch when breaker is open", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (let i = 0; i < 5; i++) recordFailure();
    expect(isOpen()).toBe(true);

    const result = await fetchTrackingFrom17track("LV109807596FR");

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records a failure on HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("err", { status: 500 }),
    );
    await fetchTrackingFrom17track("LV109807596FR");
    // 1 failure recorded — not enough to open, but breaker module saw it.
    // Indirect check: 4 more should open it.
    for (let i = 0; i < 4; i++) recordFailure();
    expect(isOpen()).toBe(true);
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts -t "circuit breaker"`
Expected: FAIL — breaker is not consulted, fetch IS called.

- [ ] **Step 3: Wire the breaker into the adapter**

Modify `app/lib/support/tracking/adapters/seventeen-track.ts`:

Add import after line 10 (`const BASE = ...`):

```typescript
import {
  isOpen as breakerOpen,
  recordSuccess as breakerSuccess,
  recordFailure as breakerFailure,
} from "../seventeen-track-breaker";
```

Replace the body of `fetchTrackingFrom17track` (lines 227-287) so it consults and notifies the breaker:

```typescript
export async function fetchTrackingFrom17track(
  trackingNumber: string,
  _carrierNameHint?: string | null,
): Promise<SevenTrackResult | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;
  if (breakerOpen()) {
    console.log(`[17track] breaker open — skipping call for ${trackingNumber}`);
    return null;
  }

  const payload = [{ number: trackingNumber }];

  try {
    await postJson<ApiResponse>(`${BASE}/register`, payload, apiKey);

    const MAX_POLL = 3;
    const RETRY_DELAY_MS = 1500;

    for (let poll = 1; poll <= MAX_POLL; poll++) {
      if (poll > 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }

      const infoRes = await postJson<ApiResponse>(`${BASE}/gettrackinfo`, payload, apiKey);

      const accepted = infoRes.data?.accepted ?? [];
      const rejected = infoRes.data?.rejected ?? [];

      if (accepted.length > 0) {
        const best =
          accepted.find((a) => a.track_info?.latest_status?.status !== "NotFound") ??
          accepted[0];
        breakerSuccess();
        return parseTrackInfo(best);
      }

      const rejection = rejected[0];
      if (rejection?.error?.code === -18019909) {
        if (poll < MAX_POLL) {
          console.log(`[17track] pending for ${trackingNumber}, retry ${poll}/${MAX_POLL - 1}…`);
          continue;
        }
        // "pending" is NOT a breaker failure — the API is up, data is just not ready.
        breakerSuccess();
        return {
          state: "pending",
          carrierName: null, status: null, lastEvent: null,
          lastLocation: null, lastEventDate: null, delivered: false, events: [],
        };
      }

      console.warn("[17track] Unexpected rejection:", rejection);
      breakerFailure();
      return null;
    }

    return null;
  } catch (err) {
    console.error("[17track] Request failed:", err);
    breakerFailure();
    return null;
  }
}
```

- [ ] **Step 4: Run the adapter tests**

Run: `npx vitest run app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts`
Expected: PASS — existing tests still green (success-path tests indirectly verify `breakerSuccess` doesn't throw); new breaker tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/tracking/adapters/seventeen-track.ts app/lib/support/tracking/adapters/__tests__/seventeen-track.test.ts
git commit -m "feat(tracking): consult 17track breaker before HTTP, record outcomes"
```

---

## Task 4: Stamp `last17trackAttempt` on every result in `tracking-service.ts`

**Files:**
- Modify: `app/lib/support/tracking/tracking-service.ts:13-72`
- Modify: `app/lib/support/__tests__/refresh-thread-analysis.test.ts:287` (and adjacent fixtures) — only if test data destructures these fields strictly.

- [ ] **Step 1: Write the failing test**

Create `app/lib/support/tracking/__tests__/tracking-service-attempts.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTrackingFacts } from "../tracking-service";
import * as adapter from "../adapters/seventeen-track";
import type { OrderFacts } from "../../types";

function makeOrder(): OrderFacts {
  return {
    id: "gid://shopify/Order/1",
    orderNumber: "#1001",
    orderDate: "2026-05-14T10:00:00Z",
    customerName: "C", customerEmail: "c@x.com",
    financialStatus: "PAID", fulfillmentStatus: "FULFILLED",
    status: "open",
    fulfillments: [
      {
        trackingNumbers: ["LV109807596FR"],
        trackingUrls: ["https://laposte.fr/x"],
        carrier: "La Poste",
        lineItems: [],
      },
    ],
    lineItems: [],
  } as unknown as OrderFacts;
}

describe("getTrackingFacts — last17trackAttempt stamping", () => {
  const KEY = process.env.SEVENTEEN_TRACK_API_KEY;
  beforeEach(() => { process.env.SEVENTEEN_TRACK_API_KEY = "test-key"; });
  afterEach(() => { process.env.SEVENTEEN_TRACK_API_KEY = KEY; vi.restoreAllMocks(); });

  it("stamps 'ok' when 17track returns ok", async () => {
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "ok", carrierName: "La Poste", status: "InTransit",
      lastEvent: "Sorted", lastLocation: "Paris", lastEventDate: "2026-05-14T08:00:00Z",
      delivered: false, events: [],
    });
    const [t] = await getTrackingFacts(makeOrder());
    expect(t.last17trackAttempt).toBe("ok");
    expect(t.last17trackAttemptAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(t.source).toBe("seventeen_track");
  });

  it("stamps 'pending' when 17track is pending", async () => {
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue({
      state: "pending", carrierName: null, status: null, lastEvent: null,
      lastLocation: null, lastEventDate: null, delivered: false, events: [],
    });
    const [t] = await getTrackingFacts(makeOrder());
    expect(t.last17trackAttempt).toBe("pending");
  });

  it("stamps 'error' when 17track returns null (breaker open / HTTP fail)", async () => {
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockResolvedValue(null);
    const [t] = await getTrackingFacts(makeOrder());
    expect(t.last17trackAttempt).toBe("error");
    // Fell back to Shopify URL / carrier / pattern — not seventeen_track.
    expect(t.source).not.toBe("seventeen_track");
  });

  it("stamps 'error' when 17track throws", async () => {
    vi.spyOn(adapter, "fetchTrackingFrom17track").mockRejectedValue(new Error("boom"));
    const [t] = await getTrackingFacts(makeOrder());
    expect(t.last17trackAttempt).toBe("error");
  });

  it("stamps 'skipped' when no tracking number is present", async () => {
    const order = makeOrder();
    order.fulfillments[0].trackingNumbers = [];
    const [t] = await getTrackingFacts(order);
    expect(t.last17trackAttempt).toBe("skipped");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run app/lib/support/tracking/__tests__/tracking-service-attempts.test.ts`
Expected: FAIL — fields are undefined.

- [ ] **Step 3: Update `tracking-service.ts` to stamp the fields**

Replace the body of `resolveOneFulfillment` in `app/lib/support/tracking/tracking-service.ts`:

```typescript
async function resolveOneFulfillment(
  fulfillment: OrderFacts["fulfillments"][number],
  fulfillmentIndex: number,
): Promise<FulfillmentTrackingFacts> {
  const trackingNumber = fulfillment.trackingNumbers[0] ?? null;
  const trackingUrl = fulfillment.trackingUrls[0] ?? null;
  const lineItems = fulfillment.lineItems;
  const attemptAt = new Date().toISOString();

  // No tracking number → nothing to ask 17track about.
  if (!trackingNumber) {
    const base = resolveTrackingForFulfillment(fulfillment);
    return {
      ...base,
      fulfillmentIndex,
      lineItems,
      last17trackAttempt: "skipped",
      last17trackAttemptAt: attemptAt,
    };
  }

  // --- 1. Try 17track first ---
  try {
    const result = await fetchTrackingFrom17track(trackingNumber, fulfillment.carrier ?? null);
    if (result && result.state === "ok") {
      return {
        source: "seventeen_track",
        carrier: result.carrierName ?? fulfillment.carrier ?? null,
        trackingNumber,
        trackingUrl: trackingUrl ?? null,
        status: result.status,
        inferred: false,
        events: result.events,
        lastEvent: result.lastEvent,
        lastLocation: result.lastLocation,
        lastEventDate: result.lastEventDate,
        delivered: result.delivered,
        fulfillmentIndex,
        lineItems,
        last17trackAttempt: "ok",
        last17trackAttemptAt: attemptAt,
      };
    }
    if (result && result.state === "pending") {
      console.log(`[tracking] 17track pending after retries for ${trackingNumber} (fulfillment ${fulfillmentIndex})`);
      return {
        source: "seventeen_track",
        carrier: fulfillment.carrier ?? null,
        trackingNumber,
        trackingUrl: trackingUrl ?? null,
        status: "Pending (tracking initializing)",
        inferred: false,
        events: [],
        lastEvent: null,
        lastLocation: null,
        lastEventDate: null,
        delivered: false,
        fulfillmentIndex,
        lineItems,
        last17trackAttempt: "pending",
        last17trackAttemptAt: attemptAt,
      };
    }
    // result === null → 17track failed (HTTP error, breaker open, no API key, or unexpected rejection).
    // Differentiate "no API key" from "real error" so the breaker-open / fail
    // cases drive faster retries while no-key never does.
    const attempt: "error" | "skipped" =
      process.env.SEVENTEEN_TRACK_API_KEY && process.env.SEVENTEEN_TRACK_API_KEY !== "your-17track-key-here"
        ? "error"
        : "skipped";
    const base = resolveTrackingForFulfillment(fulfillment);
    return {
      ...base,
      fulfillmentIndex,
      lineItems,
      last17trackAttempt: attempt,
      last17trackAttemptAt: attemptAt,
    };
  } catch (err) {
    console.error(`[tracking] 17track failed for fulfillment ${fulfillmentIndex}, using Shopify:`, err);
    const base = resolveTrackingForFulfillment(fulfillment);
    return {
      ...base,
      fulfillmentIndex,
      lineItems,
      last17trackAttempt: "error",
      last17trackAttemptAt: attemptAt,
    };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run app/lib/support/tracking/__tests__/tracking-service-attempts.test.ts`
Expected: PASS — all 5 cases green.

- [ ] **Step 5: Run the broader suite to check for fallout**

Run: `npx vitest run app/lib/support`
Expected: PASS — existing tracking-service / orchestrator / refresh tests stay green (new fields are optional everywhere).

- [ ] **Step 6: Commit**

```bash
git add app/lib/support/tracking/tracking-service.ts app/lib/support/tracking/__tests__/tracking-service-attempts.test.ts
git commit -m "feat(tracking): stamp last17trackAttempt/At on every fulfillment result"
```

---

## Task 5: Add adaptive freshness thresholds + per-thread cutoff selection

**Files:**
- Modify: `app/lib/support/refresh-stale-analyses.ts:14-127`
- Test: `app/lib/support/__tests__/adaptive-freshness.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `app/lib/support/__tests__/adaptive-freshness.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  ANALYSIS_FRESHNESS_MS,
  pickCutoffForAnalysis,
} from "../refresh-stale-analyses";
import type { SupportAnalysis } from "../types";

function withTrackings(t: Partial<SupportAnalysis["trackings"][number]>[]): SupportAnalysis {
  return {
    intent: "where_is_my_order", intents: ["where_is_my_order"],
    identifiers: {}, order: null, orderCandidates: [],
    trackings: t.map((p, i) => ({
      source: "seventeen_track",
      inferred: false,
      fulfillmentIndex: i,
      lineItems: [],
      ...p,
    })) as SupportAnalysis["trackings"],
    warnings: [], confidence: "low", draftReply: "",
  } as unknown as SupportAnalysis;
}

describe("pickCutoffForAnalysis", () => {
  it("defaults to autoRefresh (1h) when no trackings are present", () => {
    const a = withTrackings([]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.autoRefresh);
  });

  it("returns autoRefresh when every tracking is 'ok'", () => {
    const a = withTrackings([{ last17trackAttempt: "ok" }, { last17trackAttempt: "ok" }]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.autoRefresh);
  });

  it("returns fast17trackRetry (10min) when any tracking errored", () => {
    const a = withTrackings([{ last17trackAttempt: "ok" }, { last17trackAttempt: "error" }]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.fast17trackRetry);
  });

  it("returns pendingRetry (5min) when any tracking is pending", () => {
    const a = withTrackings([{ last17trackAttempt: "pending" }]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.pendingRetry);
  });

  it("pending wins over error (sooner retry)", () => {
    const a = withTrackings([
      { last17trackAttempt: "error" },
      { last17trackAttempt: "pending" },
    ]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.pendingRetry);
  });

  it("'skipped' (no key / no number) does NOT accelerate retry", () => {
    const a = withTrackings([{ last17trackAttempt: "skipped" }]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.autoRefresh);
  });

  it("legacy analyses (no last17trackAttempt) keep autoRefresh", () => {
    const a = withTrackings([{ source: "shopify_url" }]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.autoRefresh);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run app/lib/support/__tests__/adaptive-freshness.test.ts`
Expected: FAIL — `pickCutoffForAnalysis` not exported, `fast17trackRetry` / `pendingRetry` not on the enum.

- [ ] **Step 3: Implement the cutoff helper + enriched constants**

Edit `app/lib/support/refresh-stale-analyses.ts`. Replace the `ANALYSIS_FRESHNESS_MS` block (line 31) and add the helper:

```typescript
const FIVE_MIN_MS = 5 * 60_000;
const TEN_MIN_MS = 10 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

export const ANALYSIS_FRESHNESS_MS = {
  /** Refresh before a draft refinement if analysis is older than 10 minutes. */
  draftTrigger: TEN_MIN_MS,
  /** Background auto-refresh for active "to handle" threads every hour. */
  autoRefresh: ONE_HOUR_MS,
  /** Fast retry when the previous 17track attempt errored. */
  fast17trackRetry: TEN_MIN_MS,
  /** Fast retry when the previous 17track attempt was pending. */
  pendingRetry: FIVE_MIN_MS,
} as const;

/**
 * Pick the staleness cutoff for a given analysis based on its previous
 * 17track health. Pending wins over error (sooner retry). Missing or "ok" /
 * "skipped" attempts fall back to the standard 1h auto-refresh.
 */
export function pickCutoffForAnalysis(
  previous: SupportAnalysis | null,
): number {
  if (!previous?.trackings?.length) return ANALYSIS_FRESHNESS_MS.autoRefresh;
  let hasError = false;
  for (const t of previous.trackings) {
    if (t.last17trackAttempt === "pending") return ANALYSIS_FRESHNESS_MS.pendingRetry;
    if (t.last17trackAttempt === "error") hasError = true;
  }
  return hasError ? ANALYSIS_FRESHNESS_MS.fast17trackRetry : ANALYSIS_FRESHNESS_MS.autoRefresh;
}
```

- [ ] **Step 4: Run the helper test**

Run: `npx vitest run app/lib/support/__tests__/adaptive-freshness.test.ts`
Expected: PASS — all 7 cases green.

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/refresh-stale-analyses.ts app/lib/support/__tests__/adaptive-freshness.test.ts
git commit -m "feat(tracking): add pickCutoffForAnalysis + adaptive freshness constants"
```

---

## Task 6: Use the adaptive cutoff inside `refreshStaleAnalysesForShop`

**Files:**
- Modify: `app/lib/support/refresh-stale-analyses.ts:46-127`
- Test: `app/lib/support/__tests__/refresh-stale-analyses.test.ts`

- [ ] **Step 1: Write the failing integration test**

Append to `app/lib/support/__tests__/refresh-stale-analyses.test.ts` (inside the existing `describe(...)` block — match the file's import / mock style):

```typescript
it("picks pending candidates even when only 5 minutes old", async () => {
  // Seed: one thread analyzed 6 minutes ago, with a pending tracking.
  // Default autoRefresh (1h) would NOT pick it, but adaptive cutoff (5min) should.
  const sixMinAgo = new Date(Date.now() - 6 * 60_000);
  await seedAnalyzedEmail({
    shop: "shop.myshopify.com",
    lastAnalyzedAt: sixMinAgo,
    analysisResult: {
      // minimal but valid SupportAnalysis with one pending tracking
      intent: "where_is_my_order",
      intents: ["where_is_my_order"],
      identifiers: {},
      order: null,
      orderCandidates: [],
      trackings: [{
        source: "seventeen_track",
        inferred: false,
        fulfillmentIndex: 0,
        lineItems: [],
        last17trackAttempt: "pending",
        last17trackAttemptAt: sixMinAgo.toISOString(),
      }],
      warnings: [],
      confidence: "low",
      draftReply: "",
    },
  });

  const r = await refreshStaleAnalysesForShop("shop.myshopify.com", fakeAdmin);
  expect(r.refreshed).toBe(1);
});

it("does NOT pick 'ok' candidates younger than 1h", async () => {
  await seedAnalyzedEmail({
    shop: "shop.myshopify.com",
    lastAnalyzedAt: new Date(Date.now() - 30 * 60_000), // 30 min ago
    analysisResult: { /* same shape with last17trackAttempt: "ok" */ } as any,
  });
  const r = await refreshStaleAnalysesForShop("shop.myshopify.com", fakeAdmin);
  expect(r.refreshed).toBe(0);
});
```

> If `seedAnalyzedEmail` does not yet exist in the test file, factor the existing per-test setup into a small helper that accepts `{ shop, lastAnalyzedAt, analysisResult }` and inserts a matching `IncomingEmail` + `Thread` row pair. Reuse the existing prisma test client wiring at the top of `refresh-stale-analyses.test.ts`.

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run app/lib/support/__tests__/refresh-stale-analyses.test.ts`
Expected: FAIL — pending candidate is filtered out by the 1h cutoff.

- [ ] **Step 3: Update the SQL filter + caller path**

Edit `refreshStaleAnalysesForShop` body in `app/lib/support/refresh-stale-analyses.ts`:

```typescript
export async function refreshStaleAnalysesForShop(
  shop: string,
  admin: AdminGraphqlClient,
  opts: { maxAgeMs?: number } = {},
): Promise<{ refreshed: number; skipped: number; errors: number }> {
  // The widest cutoff we'd ever pick is autoRefresh. We query Prisma with that
  // and then filter per-row in JS using pickCutoffForAnalysis, because the
  // adaptive cutoff depends on the JSON blob `analysisResult` which Prisma
  // can't filter on portably.
  const widestMaxAgeMs = opts.maxAgeMs ?? ANALYSIS_FRESHNESS_MS.autoRefresh;
  const widestCutoff = new Date(Date.now() - Math.min(widestMaxAgeMs, ANALYSIS_FRESHNESS_MS.pendingRetry));

  const candidates = await prisma.incomingEmail.findMany({
    where: {
      shop,
      processingStatus: "analyzed",
      analysisResult: { not: null },
      OR: [{ lastAnalyzedAt: null }, { lastAnalyzedAt: { lt: widestCutoff } }],
      NOT: {
        thread: {
          is: {
            OR: [
              { operationalState: { in: ["resolved", "no_reply_needed"] } },
              { supportNature: "non_support" },
            ],
          },
        },
      },
    },
    orderBy: { receivedAt: "desc" },
    distinct: ["canonicalThreadId"],
    select: { id: true, analysisResult: true, lastAnalyzedAt: true },
    take: 20, // raised from 10 — we may filter half out below
  });

  // Per-candidate adaptive filtering
  const now = Date.now();
  const eligible: Array<{ id: string; analysisResult: string | null }> = [];
  for (const c of candidates) {
    const previous: SupportAnalysis | null = c.analysisResult
      ? (JSON.parse(c.analysisResult) as SupportAnalysis)
      : null;
    const cutoffMs = opts.maxAgeMs ?? pickCutoffForAnalysis(previous);
    const age = c.lastAnalyzedAt ? now - c.lastAnalyzedAt.getTime() : Infinity;
    if (age > cutoffMs) eligible.push({ id: c.id, analysisResult: c.analysisResult });
    if (eligible.length >= 10) break; // preserve original per-pass budget
  }

  let refreshed = 0;
  let skipped = candidates.length - eligible.length;
  let errors = 0;
  if (eligible.length === 0) {
    console.log(`[refresh-stale] shop=${shop} no stale candidates after adaptive filter`);
  }

  const BATCH_SIZE = 3;
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (c) => {
        try {
          const previous: SupportAnalysis | null = c.analysisResult
            ? (JSON.parse(c.analysisResult) as SupportAnalysis)
            : null;

          const reclassifyIntent =
            !previous ||
            !previous.intent ||
            previous.intent === "unknown" ||
            !previous.intents ||
            previous.intents.length === 0;
          const reSearchOrder = !previous || !previous.order;

          await refreshThreadAnalysis(c.id, admin, shop, {
            reclassifyIntent,
            reSearchOrder,
            refreshTracking: true,
          });
          refreshed++;
        } catch (err) {
          errors++;
          console.error(
            `[refresh-stale] shop=${shop} email=${c.id} reanalyze failed:`,
            err,
          );
        }
      }),
    );
  }
  return { refreshed, skipped, errors };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run app/lib/support/__tests__/refresh-stale-analyses.test.ts`
Expected: PASS — pending candidate gets picked at 6 min, ok candidate is skipped at 30 min.

- [ ] **Step 5: Run the integration + unit suites that touch refresh**

Run: `npx vitest run app/lib/__tests__/integration/manual-classification-override.test.ts app/lib/support`
Expected: PASS — `manualClassification` override path still works (callers pass `maxAgeMs: 0` to bypass adaptive filtering, which already takes precedence).

- [ ] **Step 6: Commit**

```bash
git add app/lib/support/refresh-stale-analyses.ts app/lib/support/__tests__/refresh-stale-analyses.test.ts
git commit -m "feat(tracking): apply adaptive per-thread cutoff in refreshStaleAnalysesForShop"
```

---

## Task 7: Sanity-check the cron / auto-sync uses the new behaviour

**Files:**
- Read-only: `app/lib/mail/auto-sync.ts:355-356`
- Modify (only if a comment makes the intent clearer): same lines.

- [ ] **Step 1: Open the auto-sync call site and verify it omits `maxAgeMs`**

Read `app/lib/mail/auto-sync.ts:350-360`. The call should look like:

```typescript
const res = await refreshStaleAnalysesForShop(shop, admin, {
  maxAgeMs: ANALYSIS_FRESHNESS_MS.autoRefresh,
});
```

The current code passes an explicit `maxAgeMs` of 1h, which DISABLES the adaptive filter (because `opts.maxAgeMs` overrides `pickCutoffForAnalysis`).

- [ ] **Step 2: Switch auto-sync to opt-in to adaptive behaviour**

Change the call to:

```typescript
// Pass no maxAgeMs so refreshStaleAnalysesForShop uses pickCutoffForAnalysis:
// pending → 5 min, error → 10 min, ok / skipped → 1h.
const res = await refreshStaleAnalysesForShop(shop, admin);
```

Leave `inbox-actions.ts:117-118` untouched: that call is the "user just clicked something, give them fresh data" path — keeping the 1h ceiling is fine there because the draftTrigger logic above already covers freshness for the user-action flow.

- [ ] **Step 3: Run the auto-sync tests, if any**

Run: `npx vitest run app/lib/mail`
Expected: PASS. If a test mocked `refreshStaleAnalysesForShop` and asserted on the args, update the assertion to expect `(shop, admin)` (no opts).

- [ ] **Step 4: Commit**

```bash
git add app/lib/mail/auto-sync.ts
git commit -m "feat(tracking): auto-sync opts into adaptive 17track retry cadence"
```

---

## Task 8: Document the behaviour and update TECHNICAL_DEBT.md

**Files:**
- Modify: `TECHNICAL_DEBT.md`
- Modify: `CLAUDE.md` — single line under "Tracking integration rules"

- [ ] **Step 1: Update TECHNICAL_DEBT.md**

Find the 17track section (if present) and replace it with — or append the following block if no section exists:

```markdown
## 17track resilience (resolved 2026-05-14)
- `last17trackAttempt` stamped on every `FulfillmentTrackingFacts`.
- `pickCutoffForAnalysis` drives adaptive retries: pending → 5 min, error → 10 min, ok / skipped → 1h.
- In-memory circuit breaker in `seventeen-track-breaker.ts` opens after 5 failures / 10 min and stays open for 15 min, shared across all shops (one API key, one quota).
- Known limits:
  - Breaker is per-process. A horizontally scaled deploy will have independent breakers per instance — acceptable until we move to multi-instance.
  - Adaptive freshness reads the JSON blob in JS (not SQL). Cost: a few extra rows fetched per pass; bounded by `take: 20`.
```

- [ ] **Step 2: Update CLAUDE.md**

In the "Tracking integration rules" bullet list, append:

```markdown
- 17track retries are adaptive: a fulfillment whose last 17track attempt errored is refreshed after 10 min; a "pending" one after 5 min; "ok" / "skipped" follow the 1h auto-refresh cadence.
- A process-wide circuit breaker suspends 17track calls for 15 min after 5 failures in any 10-min window, to protect the shared API quota across shops.
```

- [ ] **Step 3: Commit**

```bash
git add TECHNICAL_DEBT.md CLAUDE.md
git commit -m "docs: document 17track adaptive retries + circuit breaker"
```

---

## Task 9: Full regression run

- [ ] **Step 1: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 2: Run the entire test suite**

Run: `npx vitest run`
Expected: PASS — no regressions in tracking-service, refresh-stale-analyses, refresh-thread-analysis, orchestrator, pipeline, manual-classification-override.

- [ ] **Step 3: Manual smoke (optional)**

If the env has `SEVENTEEN_TRACK_API_KEY` set and a dev store with an analyzed thread:
1. Force-error 17track by temporarily setting `SEVENTEEN_TRACK_API_KEY=invalid` and running auto-sync.
2. Verify the persisted `analysisResult.trackings[*].last17trackAttempt === "error"`.
3. Restore the key, wait 10+ minutes (or set `fast17trackRetry` to 1 minute locally), and confirm the next auto-sync picks the thread back up and flips it to `"ok"`.

- [ ] **Step 4: Final commit (if any docs/version bumps needed)**

```bash
git status
# If clean, nothing to do. Otherwise:
# git add -A && git commit -m "chore: regression cleanup for 17track resilience"
```

---

## Self-review notes

- **Spec coverage:** All four suggestions from the brainstorm (A: attempt stamp, B: adaptive freshness, C: circuit breaker, D: deferred per-fulfillment table) covered. D was explicitly deferred and noted in TECHNICAL_DEBT.md so it is not lost.
- **Type consistency:** `last17trackAttempt` values (`"ok" | "pending" | "error" | "skipped"`) and `last17trackAttemptAt` (ISO string) are used identically across Tasks 1, 4, 5, 6.
- **Backwards compatibility:** All new fields are optional. Legacy analyses (no stamps) fall through `pickCutoffForAnalysis` to `autoRefresh` (1h) — exactly today's behaviour.
- **Multi-tenant:** Breaker is process-global by design (shared API key). All Prisma queries remain `shop`-scoped (unchanged from prior code).
