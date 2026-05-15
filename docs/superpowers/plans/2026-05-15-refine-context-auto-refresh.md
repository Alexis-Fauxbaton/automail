# Refine context auto-refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the merchant edits thread identifiers, immediately refresh the Shopify order and tracking data on the latest analysis so the next Refine call sees up-to-date context. Pass that context (curated text block) into the Refine LLM prompt.

**Architecture:** Edit handler diffs incoming identifiers vs current Thread row, then calls `refreshThreadAnalysis` (the existing LLM-free refresh path) on the thread anchor. Refine handler reads the freshly-refreshed `analysisResult`, builds a compact text block via a new pure helper `buildRefineContext`, and threads it through `refineDraft` to the OpenAI prompt.

**Tech Stack:** TypeScript, React Router 7, Prisma, vitest (unit + integration), OpenAI SDK (existing `trackedChatCompletion`).

**Spec:** [docs/superpowers/specs/2026-05-14-refine-context-auto-refresh-design.md](../specs/2026-05-14-refine-context-auto-refresh-design.md)

---

## File map

**New files:**
- `app/lib/support/refine-context.ts` — pure helper `buildRefineContext(analysis: SupportAnalysis): string | null`
- `app/lib/support/__tests__/refine-context.test.ts` — unit tests for the helper
- `app/lib/__tests__/integration/refine-context-refresh.test.ts` — integration coverage of edit-time refresh and Refine context wiring

**Modified files:**
- `app/lib/gmail/refine-draft.ts` — add optional `contextSummary` param, update system + user prompts
- `app/lib/support/inbox-actions.ts` — diff + `refreshThreadAnalysis` in `handleEditThreadIdentifiers`; build + pass `contextSummary` in `handleRefine`
- `app/lib/metrics/definitions.ts` — declare new counter `refineContextRefreshTotal`

**Optional UI tweak (Task 9):**
- `app/routes/app.inbox.tsx` — toast on `refreshed: "error"` outcome

---

## Conventions

- Each task ends with a commit. Use `feat(...)` for new behaviour, `test(...)` for test-only changes, `refactor(...)` for restructuring.
- Run unit tests with `npm test` and integration tests with `npm run test:integration`. Typecheck with `npm run typecheck`.
- Use `Prisma` and `vi` exactly as existing tests do — see `app/lib/__tests__/integration/production-hardening.test.ts` for an example of the integration pattern.

---

## Task 1: Scaffold `buildRefineContext` + failing tests

**Files:**
- Create: `app/lib/support/refine-context.ts`
- Create: `app/lib/support/__tests__/refine-context.test.ts`

- [ ] **Step 1: Write the first failing test (null when analysis is empty)**

Create `app/lib/support/__tests__/refine-context.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { SupportAnalysis } from "../types";
import { buildRefineContext } from "../refine-context";

function baseAnalysis(): SupportAnalysis {
  return {
    intent: "unknown",
    intents: ["unknown"],
    identifiers: {},
    order: null,
    orderCandidates: [],
    trackings: [],
    warnings: [],
    confidence: "low",
    draftReply: "",
    conversation: {
      messageCount: 0,
      incomingCount: 0,
      outgoingCount: 0,
      lastMessageDirection: "incoming",
      noReplyNeeded: false,
    },
  };
}

describe("buildRefineContext", () => {
  it("returns null when nothing useful to summarise", () => {
    expect(buildRefineContext(baseAnalysis())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- app/lib/support/__tests__/refine-context.test.ts`
Expected: FAIL with `Cannot find module '../refine-context'`.

- [ ] **Step 3: Write minimal implementation**

Create `app/lib/support/refine-context.ts`:

```ts
import type { SupportAnalysis } from "./types";

/**
 * Build a compact, English plain-text summary of the verified facts in
 * `analysis`. Fed into the Refine LLM call so it can rewrite the draft
 * without inventing or contradicting order/tracking data.
 *
 * Returns `null` when there is nothing useful to say — caller should
 * then omit the context block from the prompt entirely.
 *
 * Section labels stay in English on purpose: the LLM handles stable
 * tags ("ORDER", "TRACKING") more reliably than translated headers,
 * and the surrounding draft language is enforced by the system prompt
 * in refineDraft.
 */
export function buildRefineContext(analysis: SupportAnalysis): string | null {
  void analysis;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- app/lib/support/__tests__/refine-context.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/refine-context.ts app/lib/support/__tests__/refine-context.test.ts
git commit -m "feat(refine-context): scaffold buildRefineContext helper"
```

---

## Task 2: Render the `=== ORDER ===` section

**Files:**
- Modify: `app/lib/support/refine-context.ts`
- Modify: `app/lib/support/__tests__/refine-context.test.ts`

- [ ] **Step 1: Add failing test for order-only analysis**

Append to `app/lib/support/__tests__/refine-context.test.ts`:

```ts
  it("renders an ORDER section when analysis.order is present", () => {
    const a = baseAnalysis();
    a.order = {
      id: "gid://shopify/Order/1",
      name: "#1234",
      createdAt: "2026-03-14T10:00:00Z",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "FULFILLED",
      customerName: "John Doe",
      customerEmail: "john@example.com",
      lineItems: [
        { title: "Blue T-Shirt L", quantity: 2 },
        { title: "Sneakers 42", quantity: 1 },
      ],
      fulfillments: [],
    };
    const out = buildRefineContext(a);
    expect(out).not.toBeNull();
    expect(out).toContain("=== ORDER ===");
    expect(out).toContain("Order: #1234");
    expect(out).toContain("2× Blue T-Shirt L");
    expect(out).toContain("1× Sneakers 42");
    expect(out).toContain("Status: FULFILLED (PAID)");
    expect(out).toContain("Customer: John Doe <john@example.com>");
  });

  it("caps line items at 5 with a trailing summary line", () => {
    const a = baseAnalysis();
    a.order = {
      id: "gid://1", name: "#1", createdAt: "2026-01-01T00:00:00Z",
      displayFinancialStatus: null, displayFulfillmentStatus: null,
      customerName: null, customerEmail: null,
      lineItems: Array.from({ length: 8 }, (_, i) => ({
        title: `Item ${i + 1}`,
        quantity: 1,
      })),
      fulfillments: [],
    };
    const out = buildRefineContext(a) ?? "";
    expect(out).toContain("Item 1");
    expect(out).toContain("Item 5");
    expect(out).not.toContain("Item 6");
    expect(out).toContain("+ 3 more");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/lib/support/__tests__/refine-context.test.ts`
Expected: FAIL (2 of 3 tests).

- [ ] **Step 3: Implement the ORDER section**

Replace the contents of `app/lib/support/refine-context.ts`:

```ts
import type { OrderFacts, SupportAnalysis } from "./types";

const MAX_LINE_ITEMS = 5;

function renderOrderSection(order: OrderFacts): string {
  const lines: string[] = ["=== ORDER ==="];

  const created = order.createdAt
    ? ` — placed ${order.createdAt.slice(0, 10)}`
    : "";
  lines.push(`Order: ${order.name}${created}`);

  const status = order.displayFulfillmentStatus ?? "unknown";
  const financial = order.displayFinancialStatus
    ? ` (${order.displayFinancialStatus})`
    : "";
  lines.push(`Status: ${status}${financial}`);

  if (order.lineItems.length > 0) {
    lines.push("Items:");
    const shown = order.lineItems.slice(0, MAX_LINE_ITEMS);
    for (const item of shown) {
      lines.push(`  • ${item.quantity}× ${item.title}`);
    }
    if (order.lineItems.length > MAX_LINE_ITEMS) {
      lines.push(`  + ${order.lineItems.length - MAX_LINE_ITEMS} more`);
    }
  }

  if (order.customerName || order.customerEmail) {
    const name = order.customerName ?? "";
    const email = order.customerEmail ? `<${order.customerEmail}>` : "";
    lines.push(`Customer: ${[name, email].filter(Boolean).join(" ")}`);
  }

  return lines.join("\n");
}

export function buildRefineContext(analysis: SupportAnalysis): string | null {
  const sections: string[] = [];

  if (analysis.order) {
    sections.push(renderOrderSection(analysis.order));
  }

  if (sections.length === 0) return null;
  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app/lib/support/__tests__/refine-context.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/refine-context.ts app/lib/support/__tests__/refine-context.test.ts
git commit -m "feat(refine-context): render ORDER section"
```

---

## Task 3: Render the `=== TRACKING ===` section(s)

**Files:**
- Modify: `app/lib/support/refine-context.ts`
- Modify: `app/lib/support/__tests__/refine-context.test.ts`

- [ ] **Step 1: Add failing tests for tracking rendering**

Append to `app/lib/support/__tests__/refine-context.test.ts`:

```ts
  it("renders a TRACKING section with carrier, status, last event and ETA", () => {
    const a = baseAnalysis();
    a.trackings = [
      {
        fulfillmentIndex: 0,
        lineItems: [],
        source: "seventeen_track",
        carrier: "La Poste",
        trackingNumber: "LP123456789FR",
        trackingUrl: "https://laposte.fr/x",
        status: "in_transit",
        inferred: false,
        lastEvent: "Out for delivery",
        lastLocation: "Paris",
        lastEventDate: "2026-05-13T08:00:00Z",
        agentStatus: {
          lastEvent: "Out for delivery",
          lastLocation: "Paris",
          estimatedDelivery: "2026-05-14",
          delivered: false,
        },
        last17trackAttempt: "ok",
        last17trackAttemptAt: "2026-05-13T08:01:00Z",
      },
    ];
    const out = buildRefineContext(a) ?? "";
    expect(out).toContain("=== TRACKING ===");
    expect(out).toContain("LP123456789FR (La Poste)");
    expect(out).toContain("Status: in_transit");
    expect(out).toContain("Last event: 2026-05-13 — Out for delivery (Paris)");
    expect(out).toContain("ETA: 2026-05-14");
  });

  it("emits one TRACKING block per fulfillment, separated by blank lines", () => {
    const a = baseAnalysis();
    a.trackings = [
      {
        fulfillmentIndex: 0, lineItems: [],
        source: "shopify_url", trackingNumber: "AAA", carrier: null,
        trackingUrl: null, status: null, inferred: false,
      },
      {
        fulfillmentIndex: 1, lineItems: [],
        source: "shopify_url", trackingNumber: "BBB", carrier: null,
        trackingUrl: null, status: null, inferred: false,
      },
    ];
    const out = buildRefineContext(a) ?? "";
    expect(out.match(/=== TRACKING ===/g)).toHaveLength(2);
    expect(out).toContain("AAA");
    expect(out).toContain("BBB");
  });

  it("omits TRACKING section entirely when no useful tracking number", () => {
    const a = baseAnalysis();
    a.trackings = [
      {
        fulfillmentIndex: 0, lineItems: [],
        source: "none", trackingNumber: null, carrier: null,
        trackingUrl: null, status: null, inferred: false,
      },
    ];
    expect(buildRefineContext(a)).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/lib/support/__tests__/refine-context.test.ts`
Expected: FAIL (3 new tests).

- [ ] **Step 3: Add the TRACKING renderer**

Edit `app/lib/support/refine-context.ts`:

```ts
import type { FulfillmentTrackingFacts, OrderFacts, SupportAnalysis } from "./types";

const MAX_LINE_ITEMS = 5;

function renderOrderSection(order: OrderFacts): string {
  // ... (unchanged)
}

function renderTrackingSection(t: FulfillmentTrackingFacts): string | null {
  if (!t.trackingNumber) return null;

  const lines: string[] = ["=== TRACKING ==="];
  const carrier = t.carrier ? ` (${t.carrier})` : "";
  lines.push(`${t.trackingNumber}${carrier}`);

  if (t.status) lines.push(`Status: ${t.status}`);

  // Prefer agentStatus (richer) over the raw last* fields when present.
  const lastDate = (t.agentStatus?.lastEvent ? t.lastEventDate : t.lastEventDate) ?? null;
  const lastEvent = t.agentStatus?.lastEvent ?? t.lastEvent ?? null;
  const lastLocation = t.agentStatus?.lastLocation ?? t.lastLocation ?? null;
  if (lastEvent) {
    const dateStr = lastDate ? `${lastDate.slice(0, 10)} — ` : "";
    const locStr = lastLocation ? ` (${lastLocation})` : "";
    lines.push(`Last event: ${dateStr}${lastEvent}${locStr}`);
  }

  const eta = t.agentStatus?.estimatedDelivery;
  if (eta) lines.push(`ETA: ${eta}`);

  return lines.join("\n");
}

export function buildRefineContext(analysis: SupportAnalysis): string | null {
  const sections: string[] = [];

  if (analysis.order) {
    sections.push(renderOrderSection(analysis.order));
  }

  for (const t of analysis.trackings) {
    const block = renderTrackingSection(t);
    if (block) sections.push(block);
  }

  if (sections.length === 0) return null;
  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app/lib/support/__tests__/refine-context.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/refine-context.ts app/lib/support/__tests__/refine-context.test.ts
git commit -m "feat(refine-context): render TRACKING section per fulfillment"
```

---

## Task 4: Render `=== WARNINGS ===` with an allowlist filter

**Files:**
- Modify: `app/lib/support/refine-context.ts`
- Modify: `app/lib/support/__tests__/refine-context.test.ts`

- [ ] **Step 1: Add failing tests for warnings allowlist**

Append to `app/lib/support/__tests__/refine-context.test.ts`:

```ts
  it("renders WARNINGS only for codes that affect what to say to the customer", () => {
    const a = baseAnalysis();
    a.order = {
      id: "gid://1", name: "#1", createdAt: "2026-01-01T00:00:00Z",
      displayFinancialStatus: null, displayFulfillmentStatus: null,
      customerName: null, customerEmail: null, lineItems: [], fulfillments: [],
    };
    a.warnings = [
      { code: "ambiguous_match", message: "2 orders match" },
      { code: "no_order_match", message: "No order found" },
      { code: "inferred_carrier", message: "Carrier guessed" },
      { code: "llm_fallback", message: "LLM unavailable" },        // filtered
      { code: "crawl_partial_failure", message: "Carrier site slow" }, // filtered
    ];
    const out = buildRefineContext(a) ?? "";
    expect(out).toContain("=== WARNINGS ===");
    expect(out).toContain("ambiguous_match");
    expect(out).toContain("no_order_match");
    expect(out).toContain("inferred_carrier");
    expect(out).not.toContain("llm_fallback");
    expect(out).not.toContain("crawl_partial_failure");
  });

  it("omits WARNINGS section when none pass the allowlist", () => {
    const a = baseAnalysis();
    a.order = {
      id: "gid://1", name: "#1", createdAt: "2026-01-01T00:00:00Z",
      displayFinancialStatus: null, displayFulfillmentStatus: null,
      customerName: null, customerEmail: null, lineItems: [], fulfillments: [],
    };
    a.warnings = [{ code: "llm_fallback", message: "x" }];
    const out = buildRefineContext(a) ?? "";
    expect(out).not.toContain("=== WARNINGS ===");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/lib/support/__tests__/refine-context.test.ts`
Expected: FAIL (2 new tests).

- [ ] **Step 3: Add the WARNINGS renderer**

Edit `app/lib/support/refine-context.ts`:

```ts
import type { FulfillmentTrackingFacts, OrderFacts, SupportAnalysis, Warning } from "./types";

const MAX_LINE_ITEMS = 5;

// Warning codes worth surfacing to the Refine LLM. Cosmetic/infra codes
// (llm_fallback, crawl_*) are excluded — they don't change what the
// merchant should write to the customer.
const REFINE_VISIBLE_WARNINGS = new Set([
  "ambiguous_match",
  "no_order_match",
  "no_identifiers",
  "no_fulfillment",
  "inferred_carrier",
  "shopify_api_error",
  "tracking_lookup_error",
]);

// renderOrderSection — unchanged
// renderTrackingSection — unchanged

function renderWarningsSection(warnings: Warning[]): string | null {
  const visible = warnings.filter((w) => REFINE_VISIBLE_WARNINGS.has(w.code));
  if (visible.length === 0) return null;
  return ["=== WARNINGS ===", ...visible.map((w) => `- ${w.code}: ${w.message}`)].join("\n");
}

export function buildRefineContext(analysis: SupportAnalysis): string | null {
  const sections: string[] = [];

  if (analysis.order) {
    sections.push(renderOrderSection(analysis.order));
  }

  for (const t of analysis.trackings) {
    const block = renderTrackingSection(t);
    if (block) sections.push(block);
  }

  const warningsBlock = renderWarningsSection(analysis.warnings);
  if (warningsBlock) sections.push(warningsBlock);

  if (sections.length === 0) return null;
  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app/lib/support/__tests__/refine-context.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/refine-context.ts app/lib/support/__tests__/refine-context.test.ts
git commit -m "feat(refine-context): filtered WARNINGS section"
```

---

## Task 5: Wire `contextSummary` through `refineDraft`

**Files:**
- Modify: `app/lib/gmail/refine-draft.ts`

- [ ] **Step 1: Read the existing tests to make sure the change won't break them**

Run: `grep -rn "refineDraft" app/lib app/routes`
Expected: callers list. Confirm only `inbox-actions.ts` calls it externally.

- [ ] **Step 2: Add the optional param + update the prompt**

Edit `app/lib/gmail/refine-draft.ts`:

```ts
import { getOpenAIClient, trackedChatCompletion, type TrackedCallContext } from "../llm/client";
import { markdownToHtml } from "../support/markdown-to-html";

function htmlToPlainText(html: string): string {
  // ... unchanged
}

export async function refineDraft(
  currentDraft: string,
  instructions: string,
  context?: { subject?: string; body?: string; contextSummary?: string },
  ctx?: Partial<TrackedCallContext>,
): Promise<string> {
  const client = getOpenAIClient();
  if (!client) throw new Error("OpenAI API key not configured");

  const currentDraftText = htmlToPlainText(currentDraft);

  const systemPrompt = `You are a customer support email editor for an e-commerce store.
You will receive:
- The current draft reply to a customer (as plain text)
- The user's instructions on how to modify it
- Optionally, the original customer email for context
- Optionally, a "Verified facts" block summarising the matched order
  and shipment data

Apply the requested changes while keeping the reply:
- Professional and concise
- Factual (never invent information)
- In the same language as the current draft

When a "Verified facts" block is present, treat it as the authoritative
source for order numbers, statuses, tracking numbers, and delivery
information. Do not invent or contradict it, but do not blindly recite
it either — only reference its details when relevant to the user's
instructions.

Use light Markdown formatting where it helps readability:
- **bold** for key information
- bullet lists (- item) for multiple steps or items
- numbered lists (1. item) for sequential steps

Return ONLY the updated email text. No explanation, no quotes.`;

  let userMessage = `Current draft:\n${currentDraftText}\n\nInstructions: ${instructions}`;
  if (context?.subject || context?.body) {
    const original = [
      context.subject ? `Subject: ${context.subject}` : "",
      context.body ? `Body:\n${context.body.slice(0, 800)}` : "",
    ].filter(Boolean).join("\n");
    userMessage += `\n\nOriginal customer email:\n${original}`;
  }
  if (context?.contextSummary) {
    userMessage += `\n\nVerified facts about this customer's order:\n${context.contextSummary}`;
  }

  const response = await trackedChatCompletion(
    client,
    {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 600,
    },
    { callSite: "refine-draft", ...ctx },
  );

  const markdown = response.choices[0]?.message?.content?.trim() ?? currentDraft;
  return markdownToHtml(markdown);
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "refine-draft"`
Expected: empty output (no errors in this file).

- [ ] **Step 4: Run existing tests to confirm no regression**

Run: `npm test`
Expected: all suites green, same counts as before.

- [ ] **Step 5: Commit**

```bash
git add app/lib/gmail/refine-draft.ts
git commit -m "feat(refine-draft): accept optional contextSummary in the prompt"
```

---

## Task 6: Build + pass `contextSummary` from `handleRefine`

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`

- [ ] **Step 1: Add a static import for `buildRefineContext` at the top of `inbox-actions.ts`**

Add alongside the other top-level imports:

```ts
import { buildRefineContext } from "./refine-context";
```

- [ ] **Step 2: Edit `handleRefine` to build and pass the summary**

In `app/lib/support/inbox-actions.ts`, locate the `handleRefine` function. Right after `await maybeRefreshAnalysis(emailId, admin, shop);`, insert the parse + build, then pass it through.

Replace this block:

```ts
  await maybeRefreshAnalysis(emailId, admin, shop);

  const guarded = await withDraftQuota({
    shop,
    limit: ent.quotaStatus.limit,
    generator: async () => {
      const newDraft = await refineDraft(currentDraft, instructions, {
        subject: record.subject,
        body: record.bodyText,
      }, {
        shop,
        emailId,
        threadId: record.threadId,
      });
```

With:

```ts
  await maybeRefreshAnalysis(emailId, admin, shop);

  // Reload AFTER the refresh so we see fresh analysisResult.
  const fresh = await prisma.incomingEmail.findUnique({
    where: { id: emailId },
    select: { analysisResult: true },
  });
  let contextSummary: string | undefined;
  if (fresh?.analysisResult) {
    try {
      const analysis = JSON.parse(fresh.analysisResult);
      contextSummary = buildRefineContext(analysis) ?? undefined;
    } catch (err) {
      console.error(`[refine] malformed analysisResult for email=${emailId}:`, err);
    }
  }

  const guarded = await withDraftQuota({
    shop,
    limit: ent.quotaStatus.limit,
    generator: async () => {
      const newDraft = await refineDraft(currentDraft, instructions, {
        subject: record.subject,
        body: record.bodyText,
        contextSummary,
      }, {
        shop,
        emailId,
        threadId: record.threadId,
      });
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "inbox-actions"`
Expected: empty output.

- [ ] **Step 4: Run existing unit + integration tests**

Run: `npm test && npm run test:integration`
Expected: green. No assertions changed yet — this just wires data through.

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/inbox-actions.ts
git commit -m "feat(refine): pass refreshed analysis context to refineDraft"
```

---

## Task 7: Add the metrics counter

**Files:**
- Modify: `app/lib/metrics/definitions.ts`

- [ ] **Step 1: Declare the new counter**

Edit `app/lib/metrics/definitions.ts`, append after the existing counters block (before `startTimer`):

```ts
// --- Refine context refresh (edit-time) ---
export const refineContextRefreshTotal = metrics.counter(
  "refine_context_refresh_total",
  "Outcomes of the edit-time analysis refresh triggered by handleEditThreadIdentifiers.",
);
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "metrics/definitions"`
Expected: empty output.

- [ ] **Step 3: Run unit tests**

Run: `npm test -- app/lib/metrics`
Expected: green (existing metrics tests still pass — we only added).

- [ ] **Step 4: Commit**

```bash
git add app/lib/metrics/definitions.ts
git commit -m "feat(metrics): declare refine_context_refresh_total counter"
```

---

## Task 8: Refactor `handleEditThreadIdentifiers` with diff + sync refresh

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`

- [ ] **Step 1: Replace the body of `handleEditThreadIdentifiers`**

Locate `handleEditThreadIdentifiers` in `app/lib/support/inbox-actions.ts` (around line 448). Replace its full body with:

```ts
export async function handleEditThreadIdentifiers(params: {
  shop: string;
  admin: AdminGraphqlClient;
  canonicalThreadId: string;
  resolvedOrderNumber: string | null;
  resolvedTrackingNumber: string | null;
  resolvedEmail: string | null;
  resolvedCustomerName: string | null;
}) {
  const {
    shop, admin, canonicalThreadId,
    resolvedOrderNumber, resolvedTrackingNumber, resolvedEmail, resolvedCustomerName,
  } = params;
  if (!canonicalThreadId) {
    return { report: null, disconnected: false, reanalyzed: null, refined: null };
  }
  const before = await prisma.thread.findUnique({
    where: { id: canonicalThreadId },
    select: {
      shop: true,
      resolvedOrderNumber: true,
      resolvedTrackingNumber: true,
      resolvedEmail: true,
      resolvedCustomerName: true,
    },
  });
  if (!before || before.shop !== shop) {
    return { report: null, disconnected: false, reanalyzed: null, refined: null };
  }

  const orderChanged    = (before.resolvedOrderNumber    ?? null) !== resolvedOrderNumber;
  const trackingChanged = (before.resolvedTrackingNumber ?? null) !== resolvedTrackingNumber;
  const emailChanged    = (before.resolvedEmail          ?? null) !== resolvedEmail;
  const nameChanged     = (before.resolvedCustomerName   ?? null) !== resolvedCustomerName;
  const anyChange = orderChanged || trackingChanged || emailChanged || nameChanged;

  if (!anyChange) {
    refineContextRefreshTotal.inc({ shop, outcome: "skipped_noop" });
    return {
      editedThread: { canonicalThreadId },
      refreshed: "skipped_noop" as const,
      report: null, disconnected: false, reanalyzed: null, refined: null,
    };
  }

  await prisma.thread.update({
    where: { id: canonicalThreadId },
    data: {
      resolvedOrderNumber,
      resolvedTrackingNumber,
      resolvedEmail,
      resolvedCustomerName,
      resolutionConfidence: "high",
    },
  });

  // refreshTracking follows reSearchOrder because a different order on
  // Shopify means different fulfillments and tracking numbers.
  const reSearchOrder = orderChanged || trackingChanged || emailChanged;
  const refreshTracking = reSearchOrder;

  const anchor = await prisma.incomingEmail.findFirst({
    where: { canonicalThreadId, shop, processingStatus: "analyzed" },
    orderBy: { receivedAt: "desc" },
    select: { id: true },
  });
  if (!anchor) {
    refineContextRefreshTotal.inc({ shop, outcome: "no_anchor" });
    return {
      editedThread: { canonicalThreadId },
      refreshed: "no_anchor" as const,
      report: null, disconnected: false, reanalyzed: null, refined: null,
    };
  }

  try {
    const { refreshThreadAnalysis } = await import("./refresh-thread-analysis");
    await refreshThreadAnalysis(anchor.id, admin, shop, {
      reclassifyIntent: false,
      reSearchOrder,
      refreshTracking,
    });
    refineContextRefreshTotal.inc({ shop, outcome: "ok" });
    return {
      editedThread: { canonicalThreadId },
      refreshed: "ok" as const,
      report: null, disconnected: false, reanalyzed: null, refined: null,
    };
  } catch (err) {
    console.error(
      `[edit-identifiers] shop=${shop} canonicalThreadId=${canonicalThreadId} refresh failed:`,
      err,
    );
    refineContextRefreshTotal.inc({ shop, outcome: "error" });
    return {
      editedThread: { canonicalThreadId },
      refreshed: "error" as const,
      report: null, disconnected: false, reanalyzed: null, refined: null,
    };
  }
}
```

- [ ] **Step 2: Import the metric at the top of `inbox-actions.ts`**

Add the import alongside the other imports:

```ts
import { refineContextRefreshTotal } from "../metrics/definitions";
```

- [ ] **Step 3: Update the route action to pass `admin`**

In `app/routes/app.inbox.tsx`, locate the `editThreadIdentifiers` branch in the action (around line 371). Update the call to `handleEditThreadIdentifiers` so it passes `admin`:

Find:

```ts
return handleEditThreadIdentifiers({ shop, canonicalThreadId, resolvedOrderNumber, resolvedTrackingNumber, resolvedEmail, resolvedCustomerName });
```

Replace with:

```ts
return handleEditThreadIdentifiers({ shop, admin, canonicalThreadId, resolvedOrderNumber, resolvedTrackingNumber, resolvedEmail, resolvedCustomerName });
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "inbox-actions|app\.inbox"`
Expected: empty output (or only pre-existing unrelated errors).

- [ ] **Step 5: Run existing tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add app/lib/support/inbox-actions.ts app/routes/app.inbox.tsx
git commit -m "feat(edit-identifiers): sync refreshThreadAnalysis on change"
```

---

## Task 9: Integration tests for edit-time refresh

**Files:**
- Create: `app/lib/__tests__/integration/refine-context-refresh.test.ts`

- [ ] **Step 1: Write the integration test file**

Create `app/lib/__tests__/integration/refine-context-refresh.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
  createTestThread,
} from "./helpers/db";
import { handleEditThreadIdentifiers, handleRefine } from "../../support/inbox-actions";

const refreshSpy = vi.fn(async () => undefined);
vi.mock("../../support/refresh-thread-analysis", () => ({
  refreshThreadAnalysis: refreshSpy,
}));
const refineDraftSpy = vi.fn(async () => "<p>refined</p>");
vi.mock("../../gmail/refine-draft", () => ({
  refineDraft: refineDraftSpy,
}));
vi.mock("../../billing/entitlements", () => ({
  resolveEntitlements: async () => ({
    canGenerateDraft: true,
    quotaStatus: { used: 0, limit: 999 },
    state: "active",
    isSyncSuspended: false,
  }),
  __resetCacheForTests: () => undefined,
}));
vi.mock("../../billing/draft-guard", () => ({
  withDraftQuota: async ({ generator }: { generator: () => Promise<unknown> }) => {
    const value = await generator();
    return { ok: true as const, value, newCount: 1 };
  },
}));

const fakeAdmin = { graphql: async () => ({ json: async () => ({}) }) } as any;

beforeEach(async () => {
  await cleanTestShop();
  refreshSpy.mockClear();
  refineDraftSpy.mockClear();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function seedAnalyzedAnchor(canonicalThreadId: string) {
  return testDb.incomingEmail.create({
    data: {
      shop: TEST_SHOP,
      externalMessageId: `ext-${canonicalThreadId}`,
      threadId: "tid",
      canonicalThreadId,
      fromAddress: "c@x.com",
      subject: "S",
      bodyText: "B",
      receivedAt: new Date(),
      processingStatus: "analyzed",
      analysisResult: JSON.stringify({
        intent: "where_is_my_order",
        intents: ["where_is_my_order"],
        identifiers: {},
        order: {
          id: "gid://Order/1", name: "#42", createdAt: "2026-01-01T00:00:00Z",
          displayFinancialStatus: null, displayFulfillmentStatus: null,
          customerName: null, customerEmail: null, lineItems: [], fulfillments: [],
        },
        orderCandidates: [], trackings: [], warnings: [], confidence: "high",
      }),
    },
    select: { id: true },
  });
}

describe("handleEditThreadIdentifiers — refresh decisions", () => {
  it("calls refreshThreadAnalysis with reSearchOrder=true and refreshTracking=true when order changes", async () => {
    const thread = await createTestThread({});
    await seedAnalyzedAnchor(thread.id);
    await testDb.thread.update({
      where: { id: thread.id },
      data: { resolvedOrderNumber: "1000" },
    });

    const res = await handleEditThreadIdentifiers({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      canonicalThreadId: thread.id,
      resolvedOrderNumber: "2000",          // changed
      resolvedTrackingNumber: null,
      resolvedEmail: null,
      resolvedCustomerName: null,
    });

    expect(res.refreshed).toBe("ok");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    const call = refreshSpy.mock.calls[0];
    expect(call[3]).toMatchObject({
      reclassifyIntent: false,
      reSearchOrder: true,
      refreshTracking: true,
    });
  });

  it("does not call refreshThreadAnalysis when only customer name changed", async () => {
    const thread = await createTestThread({});
    await seedAnalyzedAnchor(thread.id);

    const res = await handleEditThreadIdentifiers({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      canonicalThreadId: thread.id,
      resolvedOrderNumber: null,
      resolvedTrackingNumber: null,
      resolvedEmail: null,
      resolvedCustomerName: "Alice",
    });

    expect(res.refreshed).toBe("ok");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.calls[0][3]).toMatchObject({
      reclassifyIntent: false,
      reSearchOrder: false,
      refreshTracking: false,
    });
  });

  it("returns skipped_noop and never calls refreshThreadAnalysis when nothing changed", async () => {
    const thread = await createTestThread({});
    await seedAnalyzedAnchor(thread.id);
    await testDb.thread.update({
      where: { id: thread.id },
      data: { resolvedOrderNumber: "5", resolvedCustomerName: "Bob" },
    });

    const res = await handleEditThreadIdentifiers({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      canonicalThreadId: thread.id,
      resolvedOrderNumber: "5",
      resolvedTrackingNumber: null,
      resolvedEmail: null,
      resolvedCustomerName: "Bob",
    });

    expect(res.refreshed).toBe("skipped_noop");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("returns no_anchor when thread has no analyzed email", async () => {
    const thread = await createTestThread({});
    // No anchor seeded.

    const res = await handleEditThreadIdentifiers({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      canonicalThreadId: thread.id,
      resolvedOrderNumber: "1",
      resolvedTrackingNumber: null,
      resolvedEmail: null,
      resolvedCustomerName: null,
    });

    expect(res.refreshed).toBe("no_anchor");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("persists the edit even when refreshThreadAnalysis throws", async () => {
    const thread = await createTestThread({});
    await seedAnalyzedAnchor(thread.id);
    refreshSpy.mockRejectedValueOnce(new Error("shopify down"));

    const res = await handleEditThreadIdentifiers({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      canonicalThreadId: thread.id,
      resolvedOrderNumber: "9",
      resolvedTrackingNumber: null,
      resolvedEmail: null,
      resolvedCustomerName: null,
    });

    expect(res.refreshed).toBe("error");
    const row = await testDb.thread.findUnique({ where: { id: thread.id } });
    expect(row?.resolvedOrderNumber).toBe("9");
  });
});

describe("handleRefine — context wiring", () => {
  it("passes a contextSummary derived from analysisResult", async () => {
    const thread = await createTestThread({});
    const anchor = await seedAnalyzedAnchor(thread.id);

    await handleRefine({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      emailId: anchor.id,
      instructions: "Add the order number.",
      currentDraft: "<p>hi</p>",
    });

    expect(refineDraftSpy).toHaveBeenCalledTimes(1);
    const passedContext = refineDraftSpy.mock.calls[0][2] as {
      contextSummary?: string;
    };
    expect(passedContext.contextSummary).toBeDefined();
    expect(passedContext.contextSummary).toContain("Order: #42");
  });

  it("passes contextSummary=undefined when analysisResult is null", async () => {
    const thread = await createTestThread({});
    const anchor = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: "no-analysis",
        threadId: "tid",
        canonicalThreadId: thread.id,
        fromAddress: "c@x.com",
        subject: "S",
        bodyText: "B",
        receivedAt: new Date(),
        processingStatus: "analyzed",
        analysisResult: null,
      },
      select: { id: true },
    });

    await handleRefine({
      shop: TEST_SHOP,
      admin: fakeAdmin,
      emailId: anchor.id,
      instructions: "Fix typo.",
      currentDraft: "<p>hi</p>",
    });

    expect(refineDraftSpy).toHaveBeenCalledTimes(1);
    const passedContext = refineDraftSpy.mock.calls[0][2] as {
      contextSummary?: string;
    };
    expect(passedContext.contextSummary).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the integration suite**

Run: `npm run test:integration -- app/lib/__tests__/integration/refine-context-refresh.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 3: Run the full integration suite to verify no cross-test interference**

Run: `npm run test:integration`
Expected: all suites green.

- [ ] **Step 4: Commit**

```bash
git add app/lib/__tests__/integration/refine-context-refresh.test.ts
git commit -m "test(refine-context): integration coverage for edit-time refresh + refine wiring"
```

---

## Task 10: UI toast on `refreshed: "error"`

**Files:**
- Modify: `app/routes/app.inbox.tsx`

The identifier panel already shows a `submitting` state on the Save button — the spec's "spinner" is satisfied by that existing behaviour. The remaining piece is a non-blocking toast when the refresh fails so the user knows the edit was saved but the context is stale.

- [ ] **Step 1: Locate the existing toast pattern in `app.inbox.tsx`**

Run: `grep -n "Toast\|toast" app/routes/app.inbox.tsx | head -10`
Note the existing import + pattern. If the file already imports `Toast` / `useToast` from app-bridge, reuse it. If not, fall back to a temporary inline banner near the identifier panel.

- [ ] **Step 2: Read the fetcher result after the identifier-edit form submits**

In the IdentifiersPanel component, after `<fetcher.Form …>`, add a `useEffect` that watches `fetcher.data?.refreshed`:

```tsx
useEffect(() => {
  if (fetcher.state !== "idle") return;
  const r = (fetcher.data as { refreshed?: string } | undefined)?.refreshed;
  if (r === "error") {
    // Reuse whatever toast helper the file already has. Example with app-bridge:
    shopify.toast.show(
      t("inbox.identifiersRefreshFailed", {
        defaultValue:
          "Identifiers saved. Order/tracking refresh failed — will retry on next sync.",
      }),
      { isError: true, duration: 6000 },
    );
  }
}, [fetcher.state, fetcher.data]);
```

Notes for the implementer:
- `shopify` is the app-bridge global already used elsewhere in this file (search for `shopify.toast` to confirm).
- If app-bridge toast isn't imported here, use the simplest pattern already present in the file (a state-driven `<s-banner>` near the panel works fine).
- Do NOT toast on `ok` or `skipped_noop` — silent success is the right UX.

- [ ] **Step 3: Add the i18n key**

Edit the two locale files used by this app (search for `inbox.save` to find them — likely `app/i18n/locales/en.json` and `app/i18n/locales/fr.json`). Add the key in both:

- en: `"identifiersRefreshFailed": "Identifiers saved. Order/tracking refresh failed — will retry on next sync."`
- fr: `"identifiersRefreshFailed": "Identifiants enregistrés. Échec du rafraîchissement commande/tracking — nouvelle tentative à la prochaine synchronisation."`

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "app\.inbox"`
Expected: no new errors in `app.inbox.tsx` (pre-existing errors documented in TECHNICAL_DEBT.md are OK).

- [ ] **Step 5: Run all tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.inbox.tsx app/i18n/locales/en.json app/i18n/locales/fr.json
git commit -m "feat(inbox): toast when identifier refresh fails after save"
```

---

## Task 11: Lighten `maybeRefreshAnalysis` (drop LLM, keep safety net)

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`

**Why:** With the edit-time auto-refresh shipped, the 10-minute time-based trigger inside `handleRefine` / `handleRedraft` only catches Shopify-side drift on idle threads. We can keep the safety net but replace the engine (`reanalyzeEmail`, which costs ~1-2 LLM calls) with `refreshThreadAnalysis({reclassifyIntent: false, reSearchOrder: true, refreshTracking: true})` (zero LLM).

- [ ] **Step 1: Read the existing `maybeRefreshAnalysis` to confirm the structure**

Run: `grep -n "function maybeRefreshAnalysis\|reanalyzeEmail" app/lib/support/inbox-actions.ts`

You should see it near the top of the file (around line 20).

- [ ] **Step 2: Replace the function body**

Replace `maybeRefreshAnalysis` in `app/lib/support/inbox-actions.ts` with:

```ts
async function maybeRefreshAnalysis(
  emailId: string,
  admin: AdminGraphqlClient,
  shop: string,
): Promise<void> {
  if (!emailId) return;
  const record = await prisma.incomingEmail.findUnique({
    where: { id: emailId },
    select: { shop: true, lastAnalyzedAt: true, processingStatus: true },
  });
  if (!record || record.shop !== shop) return;
  if (record.processingStatus !== "analyzed") return;
  if (!isAnalysisStale(record.lastAnalyzedAt, ANALYSIS_FRESHNESS_MS.draftTrigger)) return;
  try {
    // Lightweight refresh: Shopify + 17track, no LLM. The intent stays
    // intact (the customer's message hasn't changed), only the order /
    // tracking facts are re-fetched in case Shopify-side state drifted
    // (e.g. order shipped between two refines).
    const { refreshThreadAnalysis } = await import("./refresh-thread-analysis");
    await refreshThreadAnalysis(emailId, admin, shop, {
      reclassifyIntent: false,
      reSearchOrder: true,
      refreshTracking: true,
    });
  } catch (err) {
    console.error(`[inbox] auto-refresh before draft failed for email=${emailId}:`, err);
  }
}
```

The `reanalyzeEmail` import at the top of the file may now become unused — but it is also called by `handleReanalyze` (separate handler), so leave the import alone.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "inbox-actions"`
Expected: empty.

- [ ] **Step 4: Run unit + integration tests**

Run: `npm test && npm run test:integration`
Expected: green. Existing tests covered the function's contract — they should still pass since we only changed the engine, not the trigger or the return type.

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/inbox-actions.ts
git commit -m "perf(refine): drop LLM cost from maybeRefreshAnalysis safety net"
```

---

## Task 12: Add `handleGenerateDraft` branching handler

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`

- [ ] **Step 1: Add the new handler at the end of the file**

Append to `app/lib/support/inbox-actions.ts` (after the last existing export):

```ts
/**
 * Unified entry point for the "Generate / Refine" merged UI affordance.
 * Branches on whether the user typed instructions:
 *   - empty (after trim) → redraft path (no LLM rewrite, just re-emit
 *     the draft from the existing analysisResult).
 *   - non-empty          → refine path (LLM rewrite using the user's
 *     instructions and the curated contextSummary).
 *
 * Both legacy handlers (handleRefine / handleRedraft) remain exported
 * for any internal caller — this wrapper picks one and forwards.
 */
export async function handleGenerateDraft(params: {
  shop: string;
  admin: AdminGraphqlClient;
  emailId: string;
  instructions: string;
  currentDraft: string;
}) {
  const wantsRefine = params.instructions.trim().length > 0;
  if (wantsRefine) {
    return handleRefine(params);
  }
  return handleRedraft({
    shop: params.shop,
    admin: params.admin,
    emailId: params.emailId,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "inbox-actions"`
Expected: empty.

- [ ] **Step 3: Run tests**

Run: `npm test && npm run test:integration`
Expected: green, unchanged counts (this is purely additive).

- [ ] **Step 4: Commit**

```bash
git add app/lib/support/inbox-actions.ts
git commit -m "feat(inbox): handleGenerateDraft branching wrapper for unified UI"
```

---

## Task 13: Wire the `generateDraft` action intent in the route

**Files:**
- Modify: `app/routes/app.inbox.tsx`

- [ ] **Step 1: Find the existing action intent block**

Run: `grep -n 'intent === "refine"\|intent === "redraft"\|handleRedraft\|handleRefine' app/routes/app.inbox.tsx`

You should see two `if (intent === "...")` blocks (around lines 348 and 358) plus the imports.

- [ ] **Step 2: Add the import for the new handler**

Locate the import line that pulls handlers from `inbox-actions`:

```ts
import {
  ...
  handleRefine,
  ...
} from "../lib/support/inbox-actions";
```

Add `handleGenerateDraft,` alongside the other names. Leave `handleRefine` and `handleRedraft` imports in place — the old action intents stay wired.

- [ ] **Step 3: Add the new action branch**

In the action function, BEFORE the existing `if (intent === "redraft")` block, add:

```ts
  if (intent === "generateDraft") {
    const emailId = String(formData.get("emailId") ?? "");
    const instructions = String(formData.get("instructions") ?? "");
    const currentDraft = String(formData.get("currentDraft") ?? "");
    return handleGenerateDraft({ shop, admin, emailId, instructions, currentDraft });
  }
```

Place it immediately above `if (intent === "redraft")` so both new and old intents coexist. Make NO changes to the two existing intent branches in this task.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "app\.inbox\.tsx"`
Expected: no new errors at the lines you just added. Pre-existing Polaris errors stay.

- [ ] **Step 5: Run tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat(inbox): generateDraft action intent for unified UI"
```

---

## Task 14: Merge the UI buttons (single affordance with dynamic label + spinner)

**Files:**
- Modify: `app/routes/app.inbox.tsx`
- Modify: `app/i18n/locales/en.json`
- Modify: `app/i18n/locales/fr.json`

- [ ] **Step 1: Locate the current Regenerate + Refine UI**

Run: `grep -n '"refine"\|"redraft"\|Refine with AI\|Regenerate' app/routes/app.inbox.tsx | head -30`

Identify the JSX block that contains:
- The Refine textarea (prompt input).
- The "Refine with AI" submit button.
- The "Regenerate" submit button.

Read 30 lines around that area to understand the form structure. Note the component name that contains it.

- [ ] **Step 2: Plan the local diff**

Inside that component, you will:
- Replace the two separate buttons with ONE submit button.
- Add a `useState` to track the textarea value.
- Compute `const wantsRefine = instructions.trim().length > 0;` on every render.
- Change the form's hidden `_action` value to `generateDraft`.
- The form must include `instructions` (the textarea) AND `currentDraft` (a hidden input with the current draft body — find the existing `currentDraft` source by reading nearby code; both Refine and Redraft branches need it today).
- Drive `loading={fetcher.state !== "idle"}` on the button.
- Replace the button label with `t(wantsRefine ? "inbox.refineButton" : "inbox.regenerateButton")`. Show `…ing` variant during loading via the same translation keys with a suffix or a separate key.
- Add `onKeyDown` on the textarea that submits the form when `(e.metaKey || e.ctrlKey) && e.key === "Enter"`.
- Update the placeholder via `t("inbox.generateInputPlaceholder")`.

Use the existing `<fetcher.Form>` shape from the file rather than introducing a new component pattern.

- [ ] **Step 3: Apply the changes**

The exact JSX depends on the current structure. Use these patterns (adapt names to match the component):

State + derived flag near the component top (alongside existing state):

```tsx
const [instructions, setInstructions] = useState("");
const wantsRefine = instructions.trim().length > 0;
const submitting = fetcher.state !== "idle";
```

Form (replace the two button forms with this single one — keep the existing TextField components from the file's idiom):

```tsx
<fetcher.Form method="post">
  <input type="hidden" name="_action" value="generateDraft" />
  <input type="hidden" name="emailId" value={email.id} />
  <input type="hidden" name="currentDraft" value={currentDraftValue} />
  <s-stack direction="block" gap="small-200">
    <s-text-area
      name="instructions"
      value={instructions}
      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
        setInstructions(e.target.value)
      }
      onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
        }
      }}
      placeholder={t("inbox.generateInputPlaceholder")}
      rows={2}
      disabled={submitting}
    />
    <s-button type="submit" variant="primary" loading={submitting} disabled={submitting}>
      {submitting
        ? t(wantsRefine ? "inbox.refiningButton" : "inbox.regeneratingButton")
        : t(wantsRefine ? "inbox.refineButton" : "inbox.regenerateButton")}
    </s-button>
  </s-stack>
</fetcher.Form>
```

If the file already uses HTML `<textarea>` or a different Polaris control, mirror its idiom rather than introducing `<s-text-area>` blindly. The key requirements are: a textarea-like input named `instructions`, a hidden `_action=generateDraft`, a hidden `emailId`, a hidden `currentDraft`, and one submit button with `loading={submitting}`.

Remove the OLD "Refine with AI" and "Regenerate" button forms in this same block.

- [ ] **Step 4: Add the i18n keys**

In `app/i18n/locales/en.json`, under the existing `inbox.*` group:

```json
"refineButton": "Refine",
"refiningButton": "Refining…",
"regenerateButton": "Regenerate",
"regeneratingButton": "Regenerating…",
"generateInputPlaceholder": "Optional: tell the AI what to change (e.g. 'add the tracking link', 'be more formal'). Cmd/Ctrl+Enter to submit."
```

In `app/i18n/locales/fr.json`, under the same group:

```json
"refineButton": "Affiner",
"refiningButton": "Affinage…",
"regenerateButton": "Régénérer",
"regeneratingButton": "Régénération…",
"generateInputPlaceholder": "Optionnel : indiquez à l'IA ce qu'il faut modifier (par exemple « ajouter le numéro de suivi », « être plus formel »). Cmd/Ctrl+Enter pour envoyer."
```

Match the existing nesting style in each file.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "app\.inbox\.tsx"`
Expected: no NEW errors on the lines you touched. Verify by reading the diff line numbers vs the error line numbers.

- [ ] **Step 6: Run tests**

Run: `npm test && npm run test:integration`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add app/routes/app.inbox.tsx app/i18n/locales/en.json app/i18n/locales/fr.json
git commit -m "feat(inbox): merge Regenerate + Refine into one prompt-aware action"
```

---

## Task 15: Final verification & documentation update

**Files:**
- Modify: `TECHNICAL_DEBT.md` (add the feature to the "Fixed in this pass" section)

- [ ] **Step 1: Run the full test suite**

Run: `npm test && npm run test:integration && npm run typecheck 2>&1 | tail -5`
Expected: unit + integration green. Typecheck: no new errors in files touched by this plan.

- [ ] **Step 2: Manual smoke test against the test shop**

This is the acceptance checklist from the spec. Mark each off only when verified live on `2ed20e.myshopify.com`:

- [ ] Change an order number on a thread → inbox card refreshes within ~3 s and shows the new order summary.
- [ ] Same thread → leave the prompt input empty and click → draft regenerated using fresh order data.
- [ ] Same thread → type "mention the tracking number explicitly" and click → output references the new tracking number.
- [ ] Change only the customer name → response is silent, no Shopify GraphQL request fires (check Network tab).
- [ ] Temporarily set `SEVENTEEN_TRACK_API_KEY` to garbage on Render → change a tracking number → error banner appears, edit still persisted.
- [ ] Open `/app/metrics` → `refine_context_refresh_total` counter shows the recorded outcomes.
- [ ] In the prompt input, hit Cmd/Ctrl + Enter → form submits.
- [ ] During submission, the button shows a spinner and the label flips to `Regenerating…` or `Refining…` depending on whether the prompt is empty.

- [ ] **Step 3: Update TECHNICAL_DEBT.md**

In the "Observability pass — 2026-05-14" section of `TECHNICAL_DEBT.md`, leave that intact, and add a NEW section just below it:

```markdown
### Refine context auto-refresh — 2026-05-15

Fixed in this pass:

- [x] **Edit-time refresh** — `handleEditThreadIdentifiers` now diffs
      incoming vs current values and, when anything other than the
      customer name changed, synchronously calls
      `refreshThreadAnalysis` so the matched Shopify order and tracking
      data are up-to-date for the next read.
- [x] **Refine context-aware** — `handleRefine` reloads
      `analysisResult` after the time-based safety refresh, builds a
      curated English text block via the new `buildRefineContext`
      helper, and passes it to the OpenAI prompt. Refine no longer
      invents or contradicts the verified order/tracking facts.
- [x] **Metric** — `refine_context_refresh_total{shop,outcome}`
      (ok / skipped_noop / no_anchor / error) on `/app/metrics`.
- [x] **Merged Regenerate + Refine UI** — single prompt-aware action.
      Empty prompt → redraft (no LLM rewrite). Non-empty → refine with
      curated context. Cmd/Ctrl+Enter submits. Polaris loading state
      shows during the action.
- [x] **Cheaper safety net** — `maybeRefreshAnalysis` switched from
      `reanalyzeEmail` (1–2 LLM calls) to `refreshThreadAnalysis` with
      `reclassifyIntent: false` (0 LLM, Shopify + 17track only).

Out of scope (kept for later):
- `handleUpdateClassification` doesn't yet trigger the same refresh.
  Same pattern applies; a 1-task follow-up.
- Toast wording is reused across edit successes — could be split (no
  toast on noop, "context updated" toast on ok) if the UX warrants.
- Legacy `intent === "refine"` and `intent === "redraft"` route branches
  stay alongside `generateDraft`. Prune when nothing else calls them.
```

- [ ] **Step 4: Commit the doc update**

```bash
git add TECHNICAL_DEBT.md
git commit -m "docs(tech-debt): record refine context auto-refresh"
```

- [ ] **Step 5: Push**

```bash
git push origin main
```

---

## Self-review checklist

Run through this once before declaring done.

**Spec coverage:**
- Section 1 (edit-time refresh) → Tasks 7 + 8 + 9
- Section 2 (refine context-aware) → Tasks 1–6
- Section 3 edge cases + tests → Tasks 9 (integration) + the unit tests across Tasks 1–4
- Metrics counter → Task 7
- UI loading + toast → Task 10
- Manual verification → Task 11

**Placeholder scan:**
- No TBD / TODO / "appropriate error handling" left.
- Every code block is complete.

**Type / naming consistency:**
- `contextSummary` is the field name across `refineDraft`, `handleRefine`, and `buildRefineContext` consumers.
- `refreshed` outcomes are spelled consistently: `"ok" | "skipped_noop" | "no_anchor" | "error"`.
- `refineContextRefreshTotal` is the only counter; same name in definitions + handler.

**Risk:**
- The diff in Task 8 changes `handleEditThreadIdentifiers`'s signature (adds `admin`). Task 8 Step 3 updates the caller in `app.inbox.tsx`. If other callers exist (search before committing), update them too. Run `grep -rn "handleEditThreadIdentifiers" app/` before Step 6.
