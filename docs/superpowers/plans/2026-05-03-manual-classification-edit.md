# Manual Classification Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let support agents manually correct a thread's intents and linked Shopify order, with overrides surviving auto-refresh; refactor stale-analysis refresh to skip LLM/Shopify recomputation when the corresponding fields are already populated.

**Architecture:** Two parallel changes. (1) Add `manualOverrides` metadata to the persisted `SupportAnalysis` JSON blob, plus a server action that validates and persists user edits. (2) Refactor `refreshStaleAnalysesForShop` to call a new `refreshThreadAnalysis(emailId, admin, shop, options)` helper that selectively re-runs intent classification and order search only when those fields are empty; tracking is always refreshed.

**Tech Stack:** TypeScript, React Router, React, Prisma, Vitest.

**Reference:** [docs/superpowers/specs/2026-05-03-manual-classification-edit-design.md](../specs/2026-05-03-manual-classification-edit-design.md)

---

## Task 1: Add `manualOverrides` to the type contract

**Files:**
- Modify: `app/lib/support/types.ts`

- [ ] **Step 1: Add field to SupportAnalysis**

In [app/lib/support/types.ts](app/lib/support/types.ts), add the field to the `SupportAnalysis` interface (after the `conversation: ConversationMeta;` line):

```ts
export interface ManualOverrideMarker {
  /** ISO-8601 timestamp of when the user last edited this field. */
  editedAt: string;
}

export interface ManualOverrides {
  intents?: ManualOverrideMarker;
  order?: ManualOverrideMarker;
}

export interface SupportAnalysis {
  // ...existing fields unchanged...
  conversation: ConversationMeta;
  /**
   * Per-field markers indicating that the user manually set this field.
   * Used by the UI ("modified manually" badge) and by the auto-refresh
   * to skip recomputation. The value itself lives in the canonical field
   * (intent / intents / order) — this struct only records the edit.
   */
  manualOverrides?: ManualOverrides;
}
```

- [ ] **Step 2: Verify type-checks pass**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors). The field is optional, so all existing code continues to compile.

- [ ] **Step 3: Commit**

```bash
git add app/lib/support/types.ts
git commit -m "feat(types): add manualOverrides to SupportAnalysis

Optional per-field edit markers used by the upcoming manual classification
edit feature. No behavior change yet — only the contract."
```

---

## Task 2: Implement order search by exact number (server helper)

**Files:**
- Create: `app/lib/support/manual-classification.ts`
- Create: `app/lib/support/__tests__/manual-classification.test.ts`

This task creates a small pure module for the validation/transform logic used by the server action. The action wiring comes in Task 4.

- [ ] **Step 1: Write failing test for `validateIntentEdit`**

Create `app/lib/support/__tests__/manual-classification.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { validateIntentEdit } from "../manual-classification";

describe("validateIntentEdit", () => {
  test("rejects empty array", () => {
    expect(() => validateIntentEdit([])).toThrow(/at least one intent/i);
  });

  test("rejects unknown intent values", () => {
    expect(() => validateIntentEdit(["bogus" as never])).toThrow(/unknown intent/i);
  });

  test("dedups while preserving order", () => {
    const result = validateIntentEdit([
      "where_is_my_order",
      "delivery_delay",
      "where_is_my_order",
    ]);
    expect(result).toEqual(["where_is_my_order", "delivery_delay"]);
  });

  test("accepts a single valid intent", () => {
    expect(validateIntentEdit(["refund_request"])).toEqual(["refund_request"]);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run app/lib/support/__tests__/manual-classification.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement `validateIntentEdit`**

Create `app/lib/support/manual-classification.ts`:

```ts
// Pure helpers used by the manual classification edit server action.
// Keep this module dependency-light: no Prisma, no Shopify client.

import { SUPPORT_INTENTS, type SupportIntent } from "./types";

const ALLOWED = new Set<string>(SUPPORT_INTENTS);

/**
 * Validate and normalize an array of intents coming from the client.
 * Throws on empty array or unknown values. Dedups while preserving order
 * so the first occurrence wins (the first item is the primary intent).
 */
export function validateIntentEdit(input: readonly SupportIntent[]): SupportIntent[] {
  if (input.length === 0) {
    throw new Error("At least one intent is required");
  }
  const seen = new Set<SupportIntent>();
  const out: SupportIntent[] = [];
  for (const value of input) {
    if (!ALLOWED.has(value)) {
      throw new Error(`Unknown intent: ${String(value)}`);
    }
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/support/__tests__/manual-classification.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Add failing test for `findCandidateById`**

Append to the test file:

```ts
import { findCandidateById } from "../manual-classification";
import type { OrderFacts } from "../types";

const fakeOrder = (id: string, name: string): OrderFacts => ({
  id,
  name,
  createdAt: "2026-04-01T00:00:00Z",
  customerName: "Jane",
  customerEmail: "jane@example.com",
  lineItems: [],
  fulfillments: [],
});

describe("findCandidateById", () => {
  test("returns the matching candidate", () => {
    const candidates = [fakeOrder("gid://Order/1", "#1001"), fakeOrder("gid://Order/2", "#1002")];
    expect(findCandidateById(candidates, "gid://Order/2")?.name).toBe("#1002");
  });

  test("returns null when not found", () => {
    expect(findCandidateById([], "gid://Order/3")).toBeNull();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run app/lib/support/__tests__/manual-classification.test.ts`
Expected: FAIL — `findCandidateById` not exported.

- [ ] **Step 7: Implement `findCandidateById`**

Append to `app/lib/support/manual-classification.ts`:

```ts
import type { OrderFacts } from "./types";

export function findCandidateById(
  candidates: OrderFacts[],
  orderId: string,
): OrderFacts | null {
  return candidates.find((o) => o.id === orderId) ?? null;
}
```

- [ ] **Step 8: Run all manual-classification tests**

Run: `npx vitest run app/lib/support/__tests__/manual-classification.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 9: Commit**

```bash
git add app/lib/support/manual-classification.ts app/lib/support/__tests__/manual-classification.test.ts
git commit -m "feat(support): add validateIntentEdit and findCandidateById helpers

Pure helpers for the manual classification edit server action."
```

---

## Task 3: Add Shopify search by order number (one match required)

**Files:**
- Modify: `app/lib/support/manual-classification.ts`
- Modify: `app/lib/support/__tests__/manual-classification.test.ts`

The free-form input must search Shopify for an exact order number and return a single OrderFacts. Multiple matches must be reported as an error.

- [ ] **Step 1: Write failing test**

Append to `app/lib/support/__tests__/manual-classification.test.ts`:

```ts
import { searchOrderByExactNumber } from "../manual-classification";
import type { AdminGraphqlClient } from "../shopify/order-search";

function fakeAdmin(orders: Array<{ id: string; name: string }>): AdminGraphqlClient {
  return {
    graphql: async () => ({
      json: async () => ({
        data: {
          orders: {
            edges: orders.map((o) => ({
              node: {
                id: o.id,
                name: o.name,
                createdAt: "2026-04-01T00:00:00Z",
                displayFulfillmentStatus: "UNFULFILLED",
                displayFinancialStatus: "PAID",
                customer: { displayName: "Jane", email: "jane@example.com" },
                lineItems: { edges: [] },
                fulfillments: [],
              },
            })),
          },
        },
      }),
    }),
  } as unknown as AdminGraphqlClient;
}

describe("searchOrderByExactNumber", () => {
  test("returns the single match as OrderFacts", async () => {
    const admin = fakeAdmin([{ id: "gid://Order/1", name: "#1001" }]);
    const result = await searchOrderByExactNumber(admin, "1001");
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.order.name).toBe("#1001");
  });

  test("returns 'not_found' on zero matches", async () => {
    const admin = fakeAdmin([]);
    const result = await searchOrderByExactNumber(admin, "9999");
    expect(result.kind).toBe("not_found");
  });

  test("returns 'ambiguous' on multiple matches", async () => {
    const admin = fakeAdmin([
      { id: "gid://Order/1", name: "#1001" },
      { id: "gid://Order/2", name: "#1001" },
    ]);
    const result = await searchOrderByExactNumber(admin, "1001");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates).toHaveLength(2);
  });

  test("strips leading # from input", async () => {
    const admin = fakeAdmin([{ id: "gid://Order/1", name: "#1001" }]);
    const result = await searchOrderByExactNumber(admin, "#1001");
    expect(result.kind).toBe("found");
  });

  test("rejects empty input", async () => {
    const admin = fakeAdmin([]);
    await expect(searchOrderByExactNumber(admin, "")).rejects.toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/support/__tests__/manual-classification.test.ts`
Expected: FAIL (`searchOrderByExactNumber` not exported).

- [ ] **Step 3: Implement `searchOrderByExactNumber`**

Append to `app/lib/support/manual-classification.ts`:

```ts
import { searchOrders, type AdminGraphqlClient } from "./shopify/order-search";
import { normalizeOrder } from "./shopify/order-normalizer";

export type ExactOrderSearchResult =
  | { kind: "found"; order: OrderFacts }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: OrderFacts[] };

/**
 * Search Shopify for an exact order number (with or without the leading `#`).
 * - 0 matches → "not_found"
 * - 1 match → "found"
 * - >1 matches → "ambiguous" (caller must show candidates and ask the user
 *   to pick one)
 */
export async function searchOrderByExactNumber(
  admin: AdminGraphqlClient,
  rawNumber: string,
): Promise<ExactOrderSearchResult> {
  const trimmed = rawNumber.trim().replace(/^#/, "");
  if (trimmed.length === 0) {
    throw new Error("Order number cannot be empty");
  }
  const result = await searchOrders(admin, { orderNumber: trimmed });
  if (result.orders.length === 0) return { kind: "not_found" };
  if (result.orders.length > 1) {
    return { kind: "ambiguous", candidates: result.orders.map(normalizeOrder) };
  }
  return { kind: "found", order: normalizeOrder(result.orders[0]) };
}
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run app/lib/support/__tests__/manual-classification.test.ts`
Expected: PASS — 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/manual-classification.ts app/lib/support/__tests__/manual-classification.test.ts
git commit -m "feat(support): add searchOrderByExactNumber for manual order linking"
```

---

## Task 4: Implement the persistence function for classification edits

**Files:**
- Modify: `app/lib/support/manual-classification.ts`
- Modify: `app/lib/support/__tests__/manual-classification.test.ts`

This is the heart of the server logic: load the analysis JSON, mutate the requested fields, set/clear the override markers, persist back. Pure-data part is testable; the Prisma wrapper is in Task 5.

- [ ] **Step 1: Write failing test for `applyClassificationEditToAnalysis`**

Append to `app/lib/support/__tests__/manual-classification.test.ts`:

```ts
import { applyClassificationEditToAnalysis } from "../manual-classification";
import type { SupportAnalysis } from "../types";

const baseAnalysis = (overrides: Partial<SupportAnalysis> = {}): SupportAnalysis => ({
  intent: "where_is_my_order",
  intents: ["where_is_my_order"],
  identifiers: {},
  order: null,
  orderCandidates: [],
  trackings: [],
  confidence: "low",
  warnings: [],
  draftReply: "",
  conversation: {
    messageCount: 1,
    incomingCount: 1,
    outgoingCount: 0,
    lastMessageDirection: "incoming",
    noReplyNeeded: false,
  },
  ...overrides,
});

describe("applyClassificationEditToAnalysis", () => {
  test("setting intents updates intent + intents and adds override marker", () => {
    const a = baseAnalysis();
    const out = applyClassificationEditToAnalysis(a, {
      intents: ["refund_request", "damaged_product"],
      now: new Date("2026-05-03T10:00:00Z"),
    });
    expect(out.intent).toBe("refund_request");
    expect(out.intents).toEqual(["refund_request", "damaged_product"]);
    expect(out.manualOverrides?.intents?.editedAt).toBe("2026-05-03T10:00:00.000Z");
  });

  test("resetting intents clears value AND override", () => {
    const a = baseAnalysis({
      intent: "refund_request",
      intents: ["refund_request"],
      manualOverrides: { intents: { editedAt: "2026-05-02T00:00:00.000Z" } },
    });
    const out = applyClassificationEditToAnalysis(a, { resetIntents: true, now: new Date() });
    expect(out.intent).toBe("unknown");
    expect(out.intents).toEqual([]);
    expect(out.manualOverrides?.intents).toBeUndefined();
  });

  test("setting order to a new value adds override marker", () => {
    const a = baseAnalysis();
    const newOrder: SupportAnalysis["order"] = {
      id: "gid://Order/1",
      name: "#1001",
      createdAt: "2026-04-01T00:00:00Z",
      customerName: "Jane",
      customerEmail: "jane@example.com",
      lineItems: [],
      fulfillments: [],
    };
    const out = applyClassificationEditToAnalysis(a, {
      order: newOrder,
      now: new Date("2026-05-03T10:00:00Z"),
    });
    expect(out.order).toEqual(newOrder);
    expect(out.manualOverrides?.order?.editedAt).toBe("2026-05-03T10:00:00.000Z");
  });

  test("detaching order sets it to null and adds override marker", () => {
    const a = baseAnalysis({
      order: {
        id: "gid://Order/1",
        name: "#1001",
        createdAt: "2026-04-01T00:00:00Z",
        customerName: "Jane",
        customerEmail: null,
        lineItems: [],
        fulfillments: [],
      },
    });
    const out = applyClassificationEditToAnalysis(a, { detachOrder: true, now: new Date() });
    expect(out.order).toBeNull();
    expect(out.manualOverrides?.order?.editedAt).toBeDefined();
  });

  test("resetting order clears value AND override", () => {
    const a = baseAnalysis({
      manualOverrides: { order: { editedAt: "2026-05-02T00:00:00.000Z" } },
    });
    const out = applyClassificationEditToAnalysis(a, { resetOrder: true, now: new Date() });
    expect(out.order).toBeNull();
    expect(out.manualOverrides?.order).toBeUndefined();
  });

  test("preserves unrelated fields (tracking, draft, candidates)", () => {
    const a = baseAnalysis({
      draftReply: "Hello",
      orderCandidates: [
        {
          id: "gid://Order/9",
          name: "#9",
          createdAt: "2026-04-01T00:00:00Z",
          customerName: null,
          customerEmail: null,
          lineItems: [],
          fulfillments: [],
        },
      ],
    });
    const out = applyClassificationEditToAnalysis(a, {
      intents: ["damaged_product"],
      now: new Date(),
    });
    expect(out.draftReply).toBe("Hello");
    expect(out.orderCandidates).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/support/__tests__/manual-classification.test.ts`
Expected: FAIL — `applyClassificationEditToAnalysis` not exported.

- [ ] **Step 3: Implement `applyClassificationEditToAnalysis`**

Append to `app/lib/support/manual-classification.ts`:

```ts
import type { ManualOverrides, SupportAnalysis } from "./types";

export interface ClassificationEdit {
  /** Replace the intents array. Mutually exclusive with resetIntents. */
  intents?: SupportIntent[];
  /** Clear intents and remove the intents override. */
  resetIntents?: boolean;
  /** Replace the linked order. Mutually exclusive with detachOrder/resetOrder. */
  order?: OrderFacts | null;
  /** Set order to null while keeping the override marker (manual detach). */
  detachOrder?: boolean;
  /** Clear order and remove the order override. */
  resetOrder?: boolean;
  /** Injected for deterministic tests. */
  now?: Date;
}

/**
 * Pure transform of an analysis JSON given a classification edit.
 * Caller is responsible for persisting the returned object.
 */
export function applyClassificationEditToAnalysis(
  current: SupportAnalysis,
  edit: ClassificationEdit,
): SupportAnalysis {
  const now = (edit.now ?? new Date()).toISOString();
  const next: SupportAnalysis = { ...current };
  const overrides: ManualOverrides = { ...(current.manualOverrides ?? {}) };

  // Intents
  if (edit.resetIntents) {
    next.intent = "unknown";
    next.intents = [];
    delete overrides.intents;
  } else if (edit.intents) {
    const validated = validateIntentEdit(edit.intents);
    next.intent = validated[0];
    next.intents = validated;
    overrides.intents = { editedAt: now };
  }

  // Order
  if (edit.resetOrder) {
    next.order = null;
    delete overrides.order;
  } else if (edit.detachOrder) {
    next.order = null;
    overrides.order = { editedAt: now };
  } else if (edit.order !== undefined) {
    next.order = edit.order;
    overrides.order = { editedAt: now };
  }

  next.manualOverrides = Object.keys(overrides).length > 0 ? overrides : undefined;
  return next;
}
```

Note: the existing imports at the top of the file already cover `SupportIntent`, `OrderFacts`. If TypeScript complains about `SupportIntent` not being imported, add it to the existing `import { SUPPORT_INTENTS, type SupportIntent } from "./types";` line.

- [ ] **Step 4: Run all manual-classification tests**

Run: `npx vitest run app/lib/support/__tests__/manual-classification.test.ts`
Expected: PASS — all tests green (11 + 6 = 17).

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/manual-classification.ts app/lib/support/__tests__/manual-classification.test.ts
git commit -m "feat(support): add applyClassificationEditToAnalysis pure transform"
```

---

## Task 5: Wire the persistence wrapper that loads/mutates/saves the analysis

**Files:**
- Modify: `app/lib/support/manual-classification.ts`

This wrapper handles the Prisma round-trip. We test it via integration in Task 8 (it touches the DB), so no unit test here — it's straightforward orchestration.

- [ ] **Step 1: Add the persistence function**

Append to `app/lib/support/manual-classification.ts`:

```ts
import prisma from "../../db.server";
import type { Prisma } from "@prisma/client";

export interface PersistClassificationEditInput {
  shop: string;
  threadId: string;
  edit: ClassificationEdit;
}

/**
 * Load the anchor email for the thread, apply the edit to its analysis JSON,
 * and persist the result. Returns the updated analysis.
 *
 * "Anchor" = the latest analyzed incoming email of the thread. This is the
 * email that holds the canonical analysisResult for the inbox UI.
 */
export async function persistClassificationEdit(
  input: PersistClassificationEditInput,
): Promise<SupportAnalysis> {
  const { shop, threadId, edit } = input;

  const anchor = await prisma.incomingEmail.findFirst({
    where: {
      shop,
      canonicalThreadId: threadId,
      processingStatus: "analyzed",
      analysisResult: { not: null },
    },
    orderBy: { receivedAt: "desc" },
    select: { id: true, analysisResult: true },
  });

  if (!anchor || !anchor.analysisResult) {
    throw new Error("Thread has no analyzed email to edit");
  }

  const current = JSON.parse(anchor.analysisResult) as SupportAnalysis;
  const next = applyClassificationEditToAnalysis(current, edit);

  const data: Prisma.IncomingEmailUpdateInput = {
    analysisResult: JSON.stringify(next),
    detectedIntent: next.intent,
  };

  await prisma.incomingEmail.update({
    where: { id: anchor.id },
    data,
  });

  return next;
}
```

- [ ] **Step 2: Verify type-checks**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/lib/support/manual-classification.ts
git commit -m "feat(support): persist classification edits to the anchor email"
```

---

## Task 6: Add the `updateClassification` server action in app.inbox.tsx

**Files:**
- Modify: `app/routes/app.inbox.tsx`

The existing action uses a `_action` form field discriminator. We follow the same pattern.

- [ ] **Step 1: Add the action branch**

In [app/routes/app.inbox.tsx](app/routes/app.inbox.tsx), locate the `action` function (line 321). Add a new branch — place it next to the other thread-scoped actions like `reanalyze` (line 435). Insert the following code after the `reanalyze` branch closes:

```ts
  if (intent === "updateClassification") {
    const threadId = String(formData.get("threadId") ?? "");
    if (!threadId) {
      return {
        classificationError: "missing_thread_id",
        report: null,
        disconnected: false,
        reanalyzed: null,
        refined: null,
        stopped: false,
      };
    }

    // Parse the optional fields. The client may send any subset.
    const rawIntents = formData.get("intents");
    const resetIntents = formData.get("resetIntents") === "1";
    const orderChangeType = String(formData.get("orderChangeType") ?? "");

    const edit: import("../lib/support/manual-classification").ClassificationEdit = {};

    if (resetIntents) {
      edit.resetIntents = true;
    } else if (typeof rawIntents === "string" && rawIntents.length > 0) {
      try {
        edit.intents = JSON.parse(rawIntents);
      } catch {
        return {
          classificationError: "invalid_intents_payload",
          report: null,
          disconnected: false,
          reanalyzed: null,
          refined: null,
          stopped: false,
        };
      }
    }

    try {
      if (orderChangeType === "candidate") {
        const orderId = String(formData.get("orderId") ?? "");
        // The client passes the candidate's full OrderFacts JSON so we
        // don't need to re-load the analysis here.
        const candidateJson = String(formData.get("candidate") ?? "");
        const candidate = candidateJson ? JSON.parse(candidateJson) : null;
        if (!candidate || candidate.id !== orderId) {
          return {
            classificationError: "candidate_mismatch",
            report: null,
            disconnected: false,
            reanalyzed: null,
            refined: null,
            stopped: false,
          };
        }
        edit.order = candidate;
      } else if (orderChangeType === "search") {
        const { searchOrderByExactNumber } = await import(
          "../lib/support/manual-classification"
        );
        const number = String(formData.get("orderNumber") ?? "");
        const result = await searchOrderByExactNumber(admin, number);
        if (result.kind === "not_found") {
          return {
            classificationError: "order_not_found",
            report: null,
            disconnected: false,
            reanalyzed: null,
            refined: null,
            stopped: false,
          };
        }
        if (result.kind === "ambiguous") {
          return {
            classificationError: "order_ambiguous",
            report: null,
            disconnected: false,
            reanalyzed: null,
            refined: null,
            stopped: false,
          };
        }
        edit.order = result.order;
      } else if (orderChangeType === "detach") {
        edit.detachOrder = true;
      } else if (orderChangeType === "reset") {
        edit.resetOrder = true;
      }

      const { persistClassificationEdit } = await import(
        "../lib/support/manual-classification"
      );
      const analysis = await persistClassificationEdit({
        shop: session.shop,
        threadId,
        edit,
      });

      return {
        classificationUpdated: analysis,
        report: null,
        disconnected: false,
        reanalyzed: null,
        refined: null,
        stopped: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      return {
        classificationError: message,
        report: null,
        disconnected: false,
        reanalyzed: null,
        refined: null,
        stopped: false,
      };
    }
  }
```

- [ ] **Step 2: Verify type-checks pass**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Smoke-test by running the app**

Run: `npm run dev` in one terminal. Open the inbox page in the embedded admin. Verify the page still loads (no runtime errors). The new action is dormant until the UI calls it (Task 11).

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat(inbox): add updateClassification action

Validates and persists manual edits to thread intent + linked order.
The UI to drive this action ships in a later task."
```

---

## Task 7: Write the granular `refreshThreadAnalysis` helper

**Files:**
- Create: `app/lib/support/refresh-thread-analysis.ts`
- Create: `app/lib/support/__tests__/refresh-thread-analysis.test.ts`

This helper is the new entry point for selective refresh. It must:
- Always refresh tracking when stale.
- Skip LLM intent classification when `intent` is non-empty and not `"unknown"`.
- Skip Shopify order search when `order` is already set.
- Reuse the existing `analyzeSupportEmail` orchestrator BUT pass flags that let it short-circuit. We'll add those flags in Task 7b if needed.

> **Pipeline risk note (from spec):** the orchestrator may not currently expose granular skip flags for intent and order. Step 1 of this task is a discovery step that decides whether we add minimal flags to `analyzeSupportEmail` or whether we wrap a full `reanalyzeEmail` call and post-filter the result. Both paths are acceptable; the test contract for `refreshThreadAnalysis` does not change.

- [ ] **Step 1: Investigate orchestrator skip points**

Read [app/lib/support/orchestrator.ts](app/lib/support/orchestrator.ts) end-to-end and answer in a 5–10 line note (write it as a comment at the top of `app/lib/support/refresh-thread-analysis.ts` when you create it):

- Does `analyzeSupportEmail` already accept flags that could let us reuse the previous `intents` and `order` values? (`skipDraft` and `skipTracking` exist; we may need `reuseIntents` and `reuseOrder`.)
- If yes → Task 7 implements `refreshThreadAnalysis` by passing those flags.
- If no → Task 7 takes the **post-filter approach**: call `reanalyzeEmail` (full pipeline), then merge fields from the previous analysis when their corresponding refresh flag is `false`. Write the merge logic explicitly.

Choose one path and document the choice in a top-of-file comment so the next reviewer understands the tradeoff.

- [ ] **Step 2: Write the failing test (path-agnostic contract)**

Create `app/lib/support/__tests__/refresh-thread-analysis.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";

// We mock prisma and the orchestrator/pipeline pieces. The exact mocks
// depend on the path chosen in Step 1 — adjust if the implementation
// uses analyzeSupportEmail directly vs. reanalyzeEmail.

vi.mock("../../../db.server", () => ({
  default: {
    incomingEmail: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    mailConnection: {
      findUnique: vi.fn(),
    },
  },
}));

describe("refreshThreadAnalysis flag matrix", () => {
  test("skips intent reclassification when reclassifyIntent=false (preserves previous intents)", async () => {
    // See implementation comments — assertion on the persisted JSON's intents
  });

  test("skips order search when reSearchOrder=false (preserves previous order)", async () => {
    // ...
  });

  test("always refreshes tracking when refreshTracking=true", async () => {
    // ...
  });

  test("preserves manualOverrides field across refresh", async () => {
    // ...
  });
});
```

> **Note:** we keep the test cases as TODO descriptions in step 2 so that the implementer in step 3 fills in the precise mocks against the chosen path. This is intentional — the discovery in step 1 changes which mocks are needed.

- [ ] **Step 3: Implement `refreshThreadAnalysis` (one of the two paths)**

Path A (orchestrator flags exist or are added):

```ts
// app/lib/support/refresh-thread-analysis.ts
// Path A: orchestrator accepts reuseIntents/reuseOrder flags.
// See investigation note above.

import prisma from "../../db.server";
import { analyzeSupportEmail } from "./orchestrator";
import type { AdminGraphqlClient } from "./shopify/order-search";
import type { SupportAnalysis } from "./types";

export interface RefreshThreadAnalysisOptions {
  reclassifyIntent: boolean;
  reSearchOrder: boolean;
  refreshTracking: boolean;
}

export async function refreshThreadAnalysis(
  emailId: string,
  admin: AdminGraphqlClient,
  shop: string,
  options: RefreshThreadAnalysisOptions,
): Promise<SupportAnalysis> {
  const record = await prisma.incomingEmail.findUnique({ where: { id: emailId } });
  if (!record || record.shop !== shop) throw new Error("Email not found");
  const previous: SupportAnalysis | null = record.analysisResult
    ? JSON.parse(record.analysisResult)
    : null;

  // Build the pipeline call with reuse flags.
  // (Implementation depends on exact orchestrator API.)
  // …call analyzeSupportEmail with the appropriate flags…
  // …merge `manualOverrides` from previous into the fresh analysis…
  // …persist…
  throw new Error("TODO: fill in based on Step 1 investigation");
}
```

Path B (post-filter with previous values):

```ts
// app/lib/support/refresh-thread-analysis.ts
// Path B: reanalyzeEmail runs in full; we restore previous values for
// fields whose refresh flag is false.

import prisma from "../../db.server";
import { reanalyzeEmail } from "../gmail/pipeline";
import type { AdminGraphqlClient } from "./shopify/order-search";
import type { SupportAnalysis } from "./types";

export interface RefreshThreadAnalysisOptions {
  reclassifyIntent: boolean;
  reSearchOrder: boolean;
  refreshTracking: boolean;
}

export async function refreshThreadAnalysis(
  emailId: string,
  admin: AdminGraphqlClient,
  shop: string,
  options: RefreshThreadAnalysisOptions,
): Promise<SupportAnalysis> {
  const before = await prisma.incomingEmail.findUnique({
    where: { id: emailId },
    select: { analysisResult: true },
  });
  const previous: SupportAnalysis | null = before?.analysisResult
    ? JSON.parse(before.analysisResult)
    : null;

  // Run the full pipeline — this re-classifies, re-searches, re-tracks, re-drafts.
  // This costs LLM/Shopify calls even on fields we plan to discard. Path B is the
  // simpler implementation; cost-optimisation requires Path A.
  const fresh = await reanalyzeEmail(emailId, admin, shop, { skipDraft: true });

  // Restore previous values where the corresponding flag is false.
  const merged: SupportAnalysis = { ...fresh };
  if (!options.reclassifyIntent && previous) {
    merged.intent = previous.intent;
    merged.intents = previous.intents;
  }
  if (!options.reSearchOrder && previous) {
    merged.order = previous.order;
    merged.orderCandidates = previous.orderCandidates;
  }
  if (!options.refreshTracking && previous) {
    merged.trackings = previous.trackings;
  }
  // Preserve the override markers themselves.
  if (previous?.manualOverrides) {
    merged.manualOverrides = previous.manualOverrides;
  }

  await prisma.incomingEmail.update({
    where: { id: emailId },
    data: {
      analysisResult: JSON.stringify(merged),
      detectedIntent: merged.intent,
    },
  });

  return merged;
}
```

Choose the path that matches your Step 1 investigation. **If Path B**, document in a comment that this is the temporary implementation pending an orchestrator refactor (the LLM cost optimisation goal of the spec is only partially met).

- [ ] **Step 4: Fill in the test cases against the chosen path**

Replace the TODO test bodies with concrete assertions matching your chosen implementation. Each test should:
- mock the previous analysis JSON,
- call `refreshThreadAnalysis` with the relevant flags,
- assert that the persisted JSON has the expected fields preserved or replaced.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run app/lib/support/__tests__/refresh-thread-analysis.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 6: Commit**

```bash
git add app/lib/support/refresh-thread-analysis.ts app/lib/support/__tests__/refresh-thread-analysis.test.ts
git commit -m "feat(support): add refreshThreadAnalysis with selective refresh flags

Selectively skips intent reclassification or order search when those
fields are already populated. Manual overrides (and previous intent/
order values when their refresh flag is false) are preserved across
the refresh."
```

---

## Task 8: Refactor `refreshStaleAnalysesForShop` to compute per-thread flags

**Files:**
- Modify: `app/lib/support/refresh-stale-analyses.ts`
- Modify: `app/lib/support/__tests__/` (new test file if absent)

- [ ] **Step 1: Update the loop to derive flags from current state**

Replace the body of the `for (const c of candidates)` loop in [app/lib/support/refresh-stale-analyses.ts](app/lib/support/refresh-stale-analyses.ts) (around line 88):

```ts
  for (const c of candidates) {
    try {
      // Read the current analysis to decide which fields are already populated
      // by the user (manual override) or by a prior pipeline run. We only
      // re-run the expensive LLM/Shopify steps when the corresponding field
      // is empty.
      const previous = c.analysisResult
        ? (JSON.parse(c.analysisResult) as SupportAnalysis)
        : null;

      const reclassifyIntent =
        !previous || !previous.intent || previous.intent === "unknown" ||
        !previous.intents || previous.intents.length === 0;
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
  }
```

Also update the `select` clause of the `findMany` to include `analysisResult`:

```ts
    select: { id: true, analysisResult: true },
```

And add the imports at the top of the file:

```ts
import { refreshThreadAnalysis } from "./refresh-thread-analysis";
import type { SupportAnalysis } from "./types";
```

Remove the now-unused `reanalyzeEmail` import.

- [ ] **Step 2: Verify type-checks**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run the existing test suite touching refresh-stale**

Run: `npx vitest run --testPathPattern refresh-stale`
Expected: existing tests (if any) still pass. If they were tightly coupled to `reanalyzeEmail` mocks, update them to mock `refreshThreadAnalysis` instead.

- [ ] **Step 4: Add a test for the flag derivation**

Create or extend a test file that asserts:
- when the previous analysis has `intent = "unknown"`, `reclassifyIntent` is true;
- when it has `intent = "refund_request"`, `reclassifyIntent` is false;
- when it has `order = null`, `reSearchOrder` is true;
- when it has `order = {…}`, `reSearchOrder` is false;
- `refreshTracking` is always true.

The cleanest way is to mock `refreshThreadAnalysis` and assert on the options it was called with. Pseudo-code:

```ts
import { vi } from "vitest";
vi.mock("../refresh-thread-analysis", () => ({
  refreshThreadAnalysis: vi.fn().mockResolvedValue({}),
}));
import { refreshThreadAnalysis } from "../refresh-thread-analysis";
import { refreshStaleAnalysesForShop } from "../refresh-stale-analyses";

// …seed prisma mocks with one candidate having a known analysisResult,
// call refreshStaleAnalysesForShop, and assert
// (refreshThreadAnalysis as Mock).mock.calls[0][3] equals the expected
// options object.
```

Implement the test following the patterns in existing files under `app/lib/support/__tests__/`.

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/refresh-stale-analyses.ts app/lib/support/__tests__/
git commit -m "feat(support): refresh-stale only re-runs LLM/Shopify when fields are empty

Tracking still refreshes hourly. Intent classification and order search
are skipped when the persisted analysis already has values. This makes
manual overrides survive auto-refresh and saves LLM cost on stable
threads."
```

---

## Task 9: Add the pencil button + override indicator to SupportAnalysisDisplay

**Files:**
- Modify: `app/components/SupportAnalysisDisplay.tsx`

- [ ] **Step 1: Locate the intent badge rendering**

In [app/components/SupportAnalysisDisplay.tsx](app/components/SupportAnalysisDisplay.tsx), find the section where the intent badges are rendered (search for "intent" — it's typically near the top of the analysis card, alongside `ConfidenceBadge`). Note the exact JSX structure so the new pencil button sits visually beside the badges.

- [ ] **Step 2: Add the pencil button + indicator**

Render a small pencil button after the intent badges. When the parent passes an `onEdit` callback, the button shows; otherwise the analysis is read-only (legacy callers).

Add this near the top of the component file, after the existing imports:

```tsx
function PencilButton({ onClick, hasOverrides }: { onClick: () => void; hasOverrides: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hasOverrides ? "Modifié manuellement — cliquer pour modifier" : "Modifier la classification"}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: "2px 4px",
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        color: hasOverrides ? "#6d7175" : "#8c9196",
        fontSize: "12px",
      }}
    >
      <span aria-hidden>✎</span>
      {hasOverrides && <span style={{ fontSize: "10px" }}>•</span>}
    </button>
  );
}
```

Then update the analysis component's signature and JSX to accept `onEdit`:

```tsx
export function AnalysisDisplay({
  analysis,
  onEdit,
  // …existing props…
}: {
  analysis: SupportAnalysisExtended;
  onEdit?: () => void;
  // …existing prop types…
}) {
  const hasOverrides = Boolean(analysis.manualOverrides &&
    (analysis.manualOverrides.intents || analysis.manualOverrides.order));

  // …in the JSX, beside the intent badges:
  // {onEdit && <PencilButton onClick={onEdit} hasOverrides={hasOverrides} />}
}
```

The exact location for the button insertion depends on the existing JSX — place it inside the same row that already renders the intent badge(s).

- [ ] **Step 3: Verify type-checks pass**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Smoke-test in the browser**

Run: `npm run dev`. Open the inbox, open a thread. The pencil button is not yet wired by the page (Task 11), so it won't appear yet. Verify the page still renders cleanly.

- [ ] **Step 5: Commit**

```bash
git add app/components/SupportAnalysisDisplay.tsx
git commit -m "feat(ui): add pencil button + override indicator to AnalysisDisplay

The button is only rendered when the parent passes an onEdit callback.
Wiring of the modal in app.inbox.tsx ships in a later task."
```

---

## Task 10: Build the ClassificationEditModal component

**Files:**
- Create: `app/components/ClassificationEditModal.tsx`

This is the heaviest UI piece. We build it incrementally with placeholder local state, then wire it to the action in Task 11.

- [ ] **Step 1: Skeleton with intents editor**

Create `app/components/ClassificationEditModal.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORT_INTENTS, type SupportIntent } from "../lib/support/types";
import type { OrderFacts, SupportAnalysis } from "../lib/support/types";

export interface ClassificationEditSubmit {
  intents?: SupportIntent[];
  resetIntents?: boolean;
  orderChange?:
    | { type: "candidate"; orderId: string; candidate: OrderFacts }
    | { type: "search"; orderNumber: string }
    | { type: "detach" }
    | { type: "reset" };
}

export function ClassificationEditModal({
  analysis,
  onSubmit,
  onClose,
  isSubmitting,
  errorCode,
}: {
  analysis: SupportAnalysis;
  onSubmit: (edit: ClassificationEditSubmit) => void;
  onClose: () => void;
  isSubmitting: boolean;
  errorCode?: string;
}) {
  const { t } = useTranslation();
  const [intents, setIntents] = useState<SupportIntent[]>(
    analysis.intents && analysis.intents.length > 0 ? [...analysis.intents] : [analysis.intent],
  );
  const [resetIntents, setResetIntents] = useState(false);

  // Order state
  const initialOrderId = analysis.order?.id ?? null;
  const [orderMode, setOrderMode] = useState<"candidate" | "search" | "detach" | "reset">(
    initialOrderId ? "candidate" : "detach",
  );
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(initialOrderId);
  const [searchInput, setSearchInput] = useState("");

  const moveIntent = (idx: number, delta: -1 | 1) => {
    const next = [...intents];
    const target = idx + delta;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setIntents(next);
    setResetIntents(false);
  };

  const removeIntent = (idx: number) => {
    setIntents(intents.filter((_, i) => i !== idx));
    setResetIntents(false);
  };

  const addIntent = (value: SupportIntent) => {
    if (intents.includes(value)) return;
    setIntents([...intents, value]);
    setResetIntents(false);
  };

  const available = SUPPORT_INTENTS.filter((v) => !intents.includes(v));

  const handleSubmit = () => {
    const payload: ClassificationEditSubmit = {};
    if (resetIntents) {
      payload.resetIntents = true;
    } else if (
      JSON.stringify(intents) !== JSON.stringify(analysis.intents ?? [analysis.intent])
    ) {
      payload.intents = intents;
    }

    if (orderMode === "candidate") {
      if (selectedCandidateId && selectedCandidateId !== initialOrderId) {
        const cand = analysis.orderCandidates.find((o) => o.id === selectedCandidateId)
          ?? (analysis.order?.id === selectedCandidateId ? analysis.order : null);
        if (cand) {
          payload.orderChange = { type: "candidate", orderId: cand.id, candidate: cand };
        }
      }
    } else if (orderMode === "search" && searchInput.trim().length > 0) {
      payload.orderChange = { type: "search", orderNumber: searchInput.trim() };
    } else if (orderMode === "detach" && initialOrderId) {
      payload.orderChange = { type: "detach" };
    } else if (orderMode === "reset") {
      payload.orderChange = { type: "reset" };
    }

    onSubmit(payload);
  };

  const canSubmit = !resetIntents ? intents.length > 0 : true;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: "12px",
          padding: "24px",
          width: "min(560px, 92vw)",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: "18px" }}>
          {t("classification.editTitle", "Modifier la classification")}
        </h2>

        {/* Intents editor */}
        <section style={{ marginTop: "16px" }}>
          <h3 style={{ fontSize: "13px", textTransform: "uppercase", color: "#6d7175" }}>
            {t("classification.intents", "Intentions")}
          </h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" }}>
            {intents.map((value, idx) => (
              <span
                key={value}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  padding: "4px 8px",
                  background: idx === 0 ? "#e3f1df" : "#f1f1f1",
                  borderRadius: "999px",
                  fontSize: "12px",
                }}
              >
                <span>{value}</span>
                <button type="button" onClick={() => moveIntent(idx, -1)} disabled={idx === 0} aria-label="Move up">↑</button>
                <button
                  type="button"
                  onClick={() => moveIntent(idx, 1)}
                  disabled={idx === intents.length - 1}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button type="button" onClick={() => removeIntent(idx)} aria-label="Remove">×</button>
              </span>
            ))}
          </div>
          {available.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) addIntent(e.target.value as SupportIntent);
              }}
              style={{ marginTop: "8px" }}
            >
              <option value="">+ {t("classification.addIntent", "Ajouter une intention")}</option>
              {available.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          )}
          {analysis.manualOverrides?.intents && (
            <button
              type="button"
              onClick={() => {
                setResetIntents(true);
                setIntents([]);
              }}
              style={{ marginTop: "8px", fontSize: "12px" }}
            >
              {t("classification.resetIntents", "Réinitialiser les intentions")}
            </button>
          )}
        </section>

        {/* Order editor */}
        <section style={{ marginTop: "20px" }}>
          <h3 style={{ fontSize: "13px", textTransform: "uppercase", color: "#6d7175" }}>
            {t("classification.linkedOrder", "Commande liée")}
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "8px" }}>
            {analysis.orderCandidates.map((cand) => (
              <label key={cand.id} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <input
                  type="radio"
                  name="orderChoice"
                  checked={orderMode === "candidate" && selectedCandidateId === cand.id}
                  onChange={() => {
                    setOrderMode("candidate");
                    setSelectedCandidateId(cand.id);
                  }}
                />
                <span>{cand.name} — {cand.customerName ?? "—"} — {new Date(cand.createdAt).toLocaleDateString()}</span>
              </label>
            ))}
            <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <input
                type="radio"
                name="orderChoice"
                checked={orderMode === "search"}
                onChange={() => setOrderMode("search")}
              />
              <span>{t("classification.otherOrderNumber", "Autre numéro de commande")}</span>
            </label>
            {orderMode === "search" && (
              <div style={{ display: "flex", gap: "6px", paddingLeft: "20px" }}>
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="#1234"
                  style={{ flex: 1 }}
                />
              </div>
            )}
            <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <input
                type="radio"
                name="orderChoice"
                checked={orderMode === "detach"}
                onChange={() => setOrderMode("detach")}
              />
              <span>{t("classification.detach", "Aucune commande (détacher)")}</span>
            </label>
            {analysis.manualOverrides?.order && (
              <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <input
                  type="radio"
                  name="orderChoice"
                  checked={orderMode === "reset"}
                  onChange={() => setOrderMode("reset")}
                />
                <span>{t("classification.resetOrder", "Réinitialiser (laisser l'app rechercher)")}</span>
              </label>
            )}
          </div>
        </section>

        {errorCode && (
          <div style={{ marginTop: "12px", color: "#bb2222", fontSize: "13px" }}>
            {t(`classification.errors.${errorCode}`, errorCode)}
          </div>
        )}

        <div style={{ marginTop: "20px", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button type="button" onClick={onClose} disabled={isSubmitting}>
            {t("common.cancel", "Annuler")}
          </button>
          <button type="button" onClick={handleSubmit} disabled={!canSubmit || isSubmitting}>
            {t("common.save", "Enregistrer")}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify type-checks pass**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/components/ClassificationEditModal.tsx
git commit -m "feat(ui): add ClassificationEditModal

Inline editor for thread intents (multi-select with reorder) and linked
order (candidates / free-form search / detach / reset). Submission
wiring to app.inbox.tsx ships in a later task."
```

---

## Task 11: Wire the modal into app.inbox.tsx

**Files:**
- Modify: `app/routes/app.inbox.tsx`

- [ ] **Step 1: Import the modal and submit handler**

At the top of [app/routes/app.inbox.tsx](app/routes/app.inbox.tsx), add the import:

```ts
import { ClassificationEditModal, type ClassificationEditSubmit } from "../components/ClassificationEditModal";
```

- [ ] **Step 2: Add modal state inside the page component**

Inside the inbox component (where the thread detail view is rendered), add:

```ts
const [editingClassification, setEditingClassification] = useState(false);
const classificationFetcher = useFetcher<typeof action>();
const isSubmittingClassification = classificationFetcher.state !== "idle";
const classificationErrorCode =
  classificationFetcher.data && "classificationError" in classificationFetcher.data
    ? (classificationFetcher.data.classificationError as string | undefined)
    : undefined;
```

- [ ] **Step 3: Define the submit handler**

```ts
const submitClassificationEdit = (edit: ClassificationEditSubmit) => {
  const fd = new FormData();
  fd.set("_action", "updateClassification");
  fd.set("threadId", currentThreadId); // resolve from the open thread
  if (edit.resetIntents) fd.set("resetIntents", "1");
  if (edit.intents) fd.set("intents", JSON.stringify(edit.intents));
  if (edit.orderChange) {
    fd.set("orderChangeType", edit.orderChange.type);
    if (edit.orderChange.type === "candidate") {
      fd.set("orderId", edit.orderChange.orderId);
      fd.set("candidate", JSON.stringify(edit.orderChange.candidate));
    } else if (edit.orderChange.type === "search") {
      fd.set("orderNumber", edit.orderChange.orderNumber);
    }
  }
  classificationFetcher.submit(fd, { method: "post" });
};
```

Replace `currentThreadId` with the actual variable holding the currently-open thread's canonical id in the existing component (locate it by searching for `canonicalThreadId` or the existing thread-detail props).

- [ ] **Step 4: Pass `onEdit` to AnalysisDisplay and render the modal**

In the JSX, when rendering `<AnalysisDisplay …>` for the open thread, add:

```tsx
<AnalysisDisplay
  analysis={analysis}
  onEdit={() => setEditingClassification(true)}
  // …existing props…
/>

{editingClassification && (
  <ClassificationEditModal
    analysis={analysis}
    onSubmit={submitClassificationEdit}
    onClose={() => setEditingClassification(false)}
    isSubmitting={isSubmittingClassification}
    errorCode={classificationErrorCode}
  />
)}
```

- [ ] **Step 5: Close the modal on successful save**

Add a `useEffect` near the other effects in the component:

```ts
useEffect(() => {
  if (
    classificationFetcher.state === "idle" &&
    classificationFetcher.data &&
    "classificationUpdated" in classificationFetcher.data &&
    classificationFetcher.data.classificationUpdated
  ) {
    setEditingClassification(false);
    revalidator.revalidate();
  }
}, [classificationFetcher.state, classificationFetcher.data]);
```

The `revalidator` is already imported at the top of the file. If not, add `useRevalidator`.

- [ ] **Step 6: Smoke-test the flow end-to-end**

Run: `npm run dev`. Open a thread, click the pencil, edit intents, save. Verify:
- modal closes,
- new badges render correctly,
- pencil shows the "modified manually" indicator after save.

Repeat for: change candidate, free-form search (valid number), free-form search (invalid number → see error), detach, reset.

- [ ] **Step 7: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat(inbox): wire ClassificationEditModal to updateClassification action"
```

---

## Task 12: Add i18n keys (FR + EN)

**Files:**
- Modify: `app/locales/fr/translation.json` (or wherever the locale files live)
- Modify: `app/locales/en/translation.json`

- [ ] **Step 1: Identify the locale file location**

Run: `git ls-files | grep -i locale`
Use the discovered paths in the next step.

- [ ] **Step 2: Add the keys to both files**

Add a `classification` section to each locale file:

FR:
```json
"classification": {
  "editTitle": "Modifier la classification",
  "intents": "Intentions",
  "addIntent": "Ajouter une intention",
  "resetIntents": "Réinitialiser les intentions",
  "linkedOrder": "Commande liée",
  "otherOrderNumber": "Autre numéro de commande",
  "detach": "Aucune commande (détacher)",
  "resetOrder": "Réinitialiser (laisser l'app rechercher)",
  "manuallyEdited": "Modifié manuellement",
  "errors": {
    "missing_thread_id": "Erreur interne : identifiant de fil manquant.",
    "invalid_intents_payload": "Données d'intentions invalides.",
    "candidate_mismatch": "La commande sélectionnée n'existe plus.",
    "order_not_found": "Aucune commande trouvée pour ce numéro.",
    "order_ambiguous": "Plusieurs commandes correspondent — précisez le numéro.",
    "Thread has no analyzed email to edit": "Ce fil n'a pas encore d'analyse — impossible de l'éditer."
  }
},
"common": { "cancel": "Annuler", "save": "Enregistrer" }
```

EN: same keys, with English values. Reuse `common.cancel`/`common.save` if they already exist in the file.

- [ ] **Step 3: Verify the modal renders the FR text in dev**

Run: `npm run dev`, open the modal, confirm all labels are translated and no raw keys leak through.

- [ ] **Step 4: Commit**

```bash
git add app/locales/
git commit -m "i18n: classification edit keys (fr + en)"
```

---

## Task 13: Integration test — manual override survives auto-refresh

**Files:**
- Create: `app/lib/__tests__/integration/manual-classification-override.test.ts`

- [ ] **Step 1: Write the integration test**

Follow the patterns in `app/lib/__tests__/integration/` (look at `reply-draft.test.ts` for setup boilerplate, especially `helpers/db.ts` usage). The test scenario:

1. Seed a shop, a canonical thread, and one analyzed incoming email whose `analysisResult` has `intent = "where_is_my_order"`, `intents = ["where_is_my_order"]`, and a populated `order` object.
2. Apply a classification edit: `intents = ["refund_request"]`. Verify the persisted analysis has `intent = "refund_request"` and `manualOverrides.intents` set.
3. Mock the orchestrator/`reanalyzeEmail` to return a fresh analysis with `intent = "where_is_my_order"` (simulating what the LLM would say). Set `lastAnalyzedAt` to 2 hours ago.
4. Call `refreshStaleAnalysesForShop(shop, fakeAdmin)`.
5. Assert: persisted analysis still has `intent = "refund_request"` and `intents = ["refund_request"]`. The override survived.
6. Reset the intents override (call the edit function with `resetIntents: true`).
7. Re-run `refreshStaleAnalysesForShop`. Assert: the LLM mock was called this time and the persisted analysis now reflects the fresh value.

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run app/lib/__tests__/integration/manual-classification-override.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full test suite to catch regressions**

Run: `npm test` (or the project's standard test command — check `package.json` scripts).
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add app/lib/__tests__/integration/manual-classification-override.test.ts
git commit -m "test(integration): manual override survives auto-refresh"
```

---

## Task 14: Manual end-to-end smoke test and final commit

- [ ] **Step 1: Manual flow**

Run: `npm run dev`. Open the embedded admin inbox in the dev store. Pick a thread that has an analysis. Verify each:

1. Pencil button visible next to intent badge.
2. Click → modal opens with current intents pre-selected and current order pre-selected.
3. Add a secondary intent, reorder, save → badges update, "modified manually" indicator appears.
4. Re-open modal, change order to a different candidate → save → order block updates.
5. Re-open, choose "Autre numéro" with a valid number → search → save → updated.
6. Re-open, "Autre numéro" with an invalid number → inline error shown.
7. Re-open, "Détacher" → order disappears.
8. Re-open, "Réinitialiser les intentions" → intents go back to unknown, override indicator gone.
9. Wait or trigger sync → confirm the field that was reset gets re-classified, the field that's still overridden does not change.

- [ ] **Step 2: Type-check + tests**

Run: `npx tsc --noEmit && npm test`
Expected: all green.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin feat/manual-classification-edit
```

Open a PR titled `feat: manual classification edit (intents + order)` referencing the spec.

---

## Notes for the implementer

- **Path A vs Path B in Task 7** is the most consequential choice. Path A delivers the LLM-cost optimisation goal; Path B is a stopgap that still preserves overrides but keeps the LLM cost. If Path A turns out to require non-trivial changes to `analyzeSupportEmail`, prefer landing Path B and opening a follow-up issue rather than blocking the whole feature.
- **Identifying the open thread id in Task 11** is the only place where you need to read existing inbox state. Search for the variable name in the current implementation (likely `selectedThreadId` or similar). Don't introduce new state for it.
- **Don't regenerate the draft on save** — this is an explicit non-goal from the spec (see Q2 of the brainstorm). The user clicks the existing "Regénérer" button if they want a new draft.
