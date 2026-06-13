# Bulk Thread Actions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-select + grouped actions (mark resolved/reopen, move to a waiting state, mark non-support) to the support inbox.

**Architecture:** A dedicated batched server handler `handleBulkThreadAction` (shop-scoped, anti-tamper) applies state changes in a handful of queries and mirrors the single-thread side-effects of `handleMoveThread`. The inbox holds a `Set<threadId>` selection, renders a checkbox per row, and shows a `BulkActionBar` (with a confirmation `<dialog>` + quota warning) when ≥1 is selected.

**Tech Stack:** TypeScript, React Router 7, Prisma (Postgres), Vitest integration tests, react-i18next.

**Spec:** [docs/superpowers/specs/2026-06-13-bulk-thread-actions-design.md](../specs/2026-06-13-bulk-thread-actions-design.md)

---

## Branch setup

This work is unrelated to the current `feat/email-send-v1` branch and to the in-tree 1-min auto-sync change. Branch fresh from `main`:

```bash
git checkout main
git checkout -b feat/bulk-thread-actions
```

> Note: the working tree may still carry the unrelated 1-min auto-sync change (schema/migration/CLAUDE.md/inbox `?? 1`). Do NOT include those files in any commit for this feature — they belong to a separate change.

## File structure

- **Modify** `app/lib/support/inbox-actions.ts` — add `handleBulkThreadAction` + `Prisma` import.
- **Create** `app/lib/__tests__/integration/bulk-thread-action.test.ts` — integration tests.
- **Modify** `app/routes/app.inbox.tsx` — new `bulkThreadAction` intent; selection state; checkboxes; render `BulkActionBar`.
- **Create** `app/components/inbox/BulkActionBar.tsx` — selection bar + confirmation dialog + result toast.
- **Modify** `app/i18n/locales/en.json` + `app/i18n/locales/fr.json` — `inbox.bulk*` keys.

---

### Task 1: Server handler `handleBulkThreadAction`

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`
- Test: `app/lib/__tests__/integration/bulk-thread-action.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `app/lib/__tests__/integration/bulk-thread-action.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  createTestThread,
  TEST_SHOP,
} from "./helpers/db";

// Mock the job queue so we can assert analyze_thread enqueues without a worker.
const { enqueueSpy } = vi.hoisted(() => ({
  enqueueSpy: vi.fn(async () => "stub-job-id"),
}));
vi.mock("../../mail/job-queue", async () => {
  const actual = await vi.importActual<typeof import("../../mail/job-queue")>("../../mail/job-queue");
  return { ...actual, enqueueJob: enqueueSpy };
});

import { handleBulkThreadAction } from "../../support/inbox-actions";

const OTHER_SHOP = "other-shop.myshopify.com";

beforeEach(async () => {
  await cleanTestShop();
  await cleanTestShop(OTHER_SHOP);
  enqueueSpy.mockClear();
});

afterAll(async () => {
  await cleanTestShop(OTHER_SHOP);
  await disconnectTestDb();
});

describe("handleBulkThreadAction", () => {
  it("marks several threads resolved and records history", async () => {
    const a = await createTestThread({ operationalState: "waiting_merchant" });
    const b = await createTestThread({ operationalState: "waiting_customer" });

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id, b.id],
      action: "resolved",
    });

    expect(res).toEqual({ updated: 2, skipped: 0 });
    const rows = await testDb.thread.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.every((t) => t.operationalState === "resolved")).toBe(true);
    expect(rows.find((t) => t.id === a.id)?.previousOperationalState).toBe("waiting_merchant");
    const history = await testDb.threadStateHistory.count({
      where: { shop: TEST_SHOP, toState: "resolved", reason: "bulk_action" },
    });
    expect(history).toBe(2);
  });

  it("skips already-resolved threads (idempotent)", async () => {
    const a = await createTestThread({ operationalState: "resolved" });
    const b = await createTestThread({ operationalState: "waiting_merchant" });

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id, b.id],
      action: "resolved",
    });

    expect(res).toEqual({ updated: 1, skipped: 1 });
    const history = await testDb.threadStateHistory.count({ where: { shop: TEST_SHOP } });
    expect(history).toBe(1);
  });

  it("ignores thread ids belonging to another shop", async () => {
    const mine = await createTestThread({ operationalState: "open" });
    const other = await testDb.thread.create({
      data: {
        shop: OTHER_SHOP,
        provider: "gmail",
        mailConnectionId: (
          await testDb.mailConnection.create({
            data: {
              shop: OTHER_SHOP,
              email: "x@other.com",
              provider: "gmail",
              accessToken: "a",
              refreshToken: "r",
              tokenExpiry: new Date(Date.now() + 3600_000),
            },
          })
        ).id,
        lastMessageAt: new Date(),
        firstMessageAt: new Date(),
        operationalState: "open",
        supportNature: "unknown",
        historyStatus: "complete",
      },
    });

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [mine.id, other.id],
      action: "resolved",
    });

    expect(res).toEqual({ updated: 1, skipped: 0 });
    const otherRow = await testDb.thread.findUnique({ where: { id: other.id } });
    expect(otherRow?.operationalState).toBe("open"); // untouched
  });

  it("reopen restores previousOperationalState (fallback waiting_merchant)", async () => {
    const a = await createTestThread({
      operationalState: "resolved",
      previousOperationalState: "waiting_customer",
    });
    const b = await createTestThread({ operationalState: "resolved" }); // no previous

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id, b.id],
      action: "reopen",
    });

    expect(res).toEqual({ updated: 2, skipped: 0 });
    const rowA = await testDb.thread.findUnique({ where: { id: a.id } });
    const rowB = await testDb.thread.findUnique({ where: { id: b.id } });
    expect(rowA?.operationalState).toBe("waiting_customer");
    expect(rowB?.operationalState).toBe("waiting_merchant");
  });

  it("non_support sets supportNature without touching operationalState or history", async () => {
    const a = await createTestThread({ supportNature: "confirmed_support", operationalState: "waiting_merchant" });

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id],
      action: "non_support",
    });

    expect(res).toEqual({ updated: 1, skipped: 0 });
    const row = await testDb.thread.findUnique({ where: { id: a.id } });
    expect(row?.supportNature).toBe("non_support");
    expect(row?.operationalState).toBe("waiting_merchant");
    const history = await testDb.threadStateHistory.count({ where: { shop: TEST_SHOP } });
    expect(history).toBe(0);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("waiting_* flips support and enqueues analyze_thread for never-analyzed threads", async () => {
    const a = await createTestThread({ supportNature: "probable_support", operationalState: "open" });

    const res = await handleBulkThreadAction({
      shop: TEST_SHOP,
      threadIds: [a.id],
      action: "waiting_merchant",
    });

    expect(res).toEqual({ updated: 1, skipped: 0 });
    const row = await testDb.thread.findUnique({ where: { id: a.id } });
    expect(row?.operationalState).toBe("waiting_merchant");
    expect(row?.supportNature).toBe("confirmed_support");
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ shop: TEST_SHOP, kind: "analyze_thread", params: { threadId: a.id } }),
    );
  });

  it("waiting_* does NOT enqueue when already analyzed", async () => {
    const a = await createTestThread({ supportNature: "probable_support" });
    await testDb.thread.update({ where: { id: a.id }, data: { analyzedAt: new Date() } });

    await handleBulkThreadAction({ shop: TEST_SHOP, threadIds: [a.id], action: "waiting_merchant" });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("rejects unknown actions and empty input", async () => {
    const a = await createTestThread();
    expect(await handleBulkThreadAction({ shop: TEST_SHOP, threadIds: [a.id], action: "delete" })).toEqual({ updated: 0, skipped: 0 });
    expect(await handleBulkThreadAction({ shop: TEST_SHOP, threadIds: [], action: "resolved" })).toEqual({ updated: 0, skipped: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -- bulk-thread-action`
Expected: FAIL — `handleBulkThreadAction` is not exported.

- [ ] **Step 3: Implement the handler**

In `app/lib/support/inbox-actions.ts`, ensure `Prisma` is imported (add to the existing `@prisma/client` import or add a new line):

```typescript
import { Prisma } from "@prisma/client";
```

Then append the handler at the end of the file:

```typescript
export type BulkThreadActionKind =
  | "resolved"
  | "reopen"
  | "waiting_customer"
  | "waiting_merchant"
  | "non_support";

const BULK_ACTION_KINDS = new Set<BulkThreadActionKind>([
  "resolved",
  "reopen",
  "waiting_customer",
  "waiting_merchant",
  "non_support",
]);

const BULK_MAX_THREADS = 500;

/**
 * Apply a grouped operational/support-nature change to many threads at once.
 *
 * Multi-tenant: the thread set is read with `shop` in the WHERE so any id the
 * caller doesn't own is silently dropped (anti-tamper).
 *
 * Side-effect parity with the single path (handleMoveThread, "site #2"):
 * moving to a waiting state flips supportNature -> confirmed_support and, for
 * never-analyzed threads, enqueues an `analyze_thread` job (first analysis,
 * 1 billing unit). Reopen does NOT refresh tracking inline (deferred to the
 * refresh-stale-analyses tick) to keep the bulk request bounded.
 */
export async function handleBulkThreadAction(params: {
  shop: string;
  threadIds: string[];
  action: string;
}): Promise<{ updated: number; skipped: number }> {
  const { shop } = params;
  const action = params.action as BulkThreadActionKind;
  if (!BULK_ACTION_KINDS.has(action)) return { updated: 0, skipped: 0 };

  const ids = Array.from(new Set(params.threadIds))
    .filter((id) => typeof id === "string" && id.length > 0)
    .slice(0, BULK_MAX_THREADS);
  if (ids.length === 0) return { updated: 0, skipped: 0 };

  const threads = await prisma.thread.findMany({
    where: { id: { in: ids }, shop },
    select: {
      id: true,
      operationalState: true,
      previousOperationalState: true,
      supportNature: true,
      analyzedAt: true,
      mailConnectionId: true,
    },
  });
  if (threads.length === 0) return { updated: 0, skipped: 0 };

  if (action === "resolved") {
    const changed = threads.filter((t) => t.operationalState !== "resolved");
    if (changed.length > 0) {
      await prisma.$executeRaw`
        UPDATE "Thread"
        SET "previousOperationalState" = "operationalState",
            "operationalState" = 'resolved',
            "operationalStateUpdatedAt" = now()
        WHERE "shop" = ${shop} AND "id" IN (${Prisma.join(changed.map((t) => t.id))})
      `;
      await prisma.threadStateHistory.createMany({
        data: changed.map((t) => ({
          shop,
          threadId: t.id,
          fromState: t.operationalState,
          toState: "resolved",
          reason: "bulk_action",
        })),
      });
    }
    return { updated: changed.length, skipped: threads.length - changed.length };
  }

  if (action === "reopen") {
    const changed = threads.filter((t) => t.operationalState === "resolved");
    if (changed.length > 0) {
      await prisma.$executeRaw`
        UPDATE "Thread"
        SET "operationalState" = COALESCE("previousOperationalState", 'waiting_merchant'),
            "previousOperationalState" = NULL,
            "operationalStateUpdatedAt" = now()
        WHERE "shop" = ${shop} AND "id" IN (${Prisma.join(changed.map((t) => t.id))})
      `;
      await prisma.threadStateHistory.createMany({
        data: changed.map((t) => ({
          shop,
          threadId: t.id,
          fromState: "resolved",
          toState: t.previousOperationalState ?? "waiting_merchant",
          reason: "bulk_action",
        })),
      });
    }
    return { updated: changed.length, skipped: threads.length - changed.length };
  }

  if (action === "non_support") {
    const changed = threads.filter((t) => t.supportNature !== "non_support");
    if (changed.length > 0) {
      await prisma.thread.updateMany({
        where: { shop, id: { in: changed.map((t) => t.id) } },
        data: { supportNature: "non_support", supportNatureUpdatedAt: new Date() },
      });
    }
    return { updated: changed.length, skipped: threads.length - changed.length };
  }

  // waiting_customer | waiting_merchant
  const target = action;
  const stateChanged = threads.filter((t) => t.operationalState !== target);
  const supportFlip = threads.filter((t) => t.supportNature !== "confirmed_support");
  const touched = threads.filter(
    (t) => t.operationalState !== target || t.supportNature !== "confirmed_support",
  );

  if (stateChanged.length > 0) {
    await prisma.thread.updateMany({
      where: { shop, id: { in: stateChanged.map((t) => t.id) } },
      data: { operationalState: target, operationalStateUpdatedAt: new Date() },
    });
    await prisma.threadStateHistory.createMany({
      data: stateChanged.map((t) => ({
        shop,
        threadId: t.id,
        fromState: t.operationalState,
        toState: target,
        reason: "bulk_action",
      })),
    });
  }

  if (supportFlip.length > 0) {
    await prisma.thread.updateMany({
      where: { shop, id: { in: supportFlip.map((t) => t.id) } },
      data: { supportNature: "confirmed_support", supportNatureUpdatedAt: new Date() },
    });
  }

  // Site #2 condition: flipped to confirmed_support AND never analyzed.
  const toAnalyze = threads.filter(
    (t) => t.supportNature !== "confirmed_support" && t.analyzedAt === null,
  );
  for (const t of toAnalyze) {
    await enqueueJob({
      shop,
      kind: "analyze_thread",
      mailConnectionId: t.mailConnectionId,
      params: { threadId: t.id },
    }).catch((err) => {
      console.error(`[bulk] enqueueJob analyze_thread failed for thread=${t.id}:`, err);
    });
  }

  return { updated: touched.length, skipped: threads.length - touched.length };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:integration -- bulk-thread-action`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/inbox-actions.ts app/lib/__tests__/integration/bulk-thread-action.test.ts
git commit -m "feat(inbox): batched bulk thread action handler"
```

---

### Task 2: Wire the `bulkThreadAction` route intent

**Files:**
- Modify: `app/routes/app.inbox.tsx` (action dispatch, near the other `if (intent === ...)` branches around line 496)

- [ ] **Step 1: Add the import**

At the top of `app/routes/app.inbox.tsx`, add `handleBulkThreadAction` to the existing import from `../lib/support/inbox-actions` (find the existing import line that pulls `handleMoveThread`).

- [ ] **Step 2: Add the intent branch**

Immediately after the `if (intent === "moveThread") { ... }` block, add:

```typescript
  if (intent === "bulkThreadAction") {
    const action = String(formData.get("bulkAction") ?? "");
    let threadIds: string[] = [];
    try {
      const parsed = JSON.parse(String(formData.get("threadIds") ?? "[]"));
      if (Array.isArray(parsed)) threadIds = parsed.map((x) => String(x));
    } catch {
      threadIds = [];
    }
    const bulkResult = await handleBulkThreadAction({ shop, threadIds, action });
    return { bulkResult };
  }
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no NEW errors referencing `app.inbox.tsx` bulk code (pre-existing inbox errors tracked in TECHNICAL_DEBT.md are acceptable).

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat(inbox): bulkThreadAction action intent"
```

---

### Task 3: i18n keys

**Files:**
- Modify: `app/i18n/locales/en.json`
- Modify: `app/i18n/locales/fr.json`

- [ ] **Step 1: Add EN keys**

In `app/i18n/locales/en.json`, inside the existing `"inbox"` object (next to `"markResolved"`), add:

```json
    "bulkSelectedCount": "{{count}} selected",
    "bulkSelectAll": "Select all",
    "bulkClear": "Clear selection",
    "bulkMarkResolved": "Mark resolved",
    "bulkReopen": "Reopen",
    "bulkWaitingCustomer": "Waiting on customer",
    "bulkWaitingMerchant": "Waiting on me",
    "bulkMarkNonSupport": "Not support",
    "bulkConfirm": "Confirm",
    "bulkCancel": "Cancel",
    "bulkConfirmResolved": "Mark {{count}} conversations as resolved?",
    "bulkConfirmReopen": "Reopen {{count}} conversations?",
    "bulkConfirmWaitingCustomer": "Mark {{count}} conversations as waiting on customer?",
    "bulkConfirmWaitingMerchant": "Mark {{count}} conversations as waiting on me?",
    "bulkConfirmNonSupport": "Mark {{count}} conversations as not support?",
    "bulkAnalyzeWarning": "{{count}} of them have never been analyzed and will be now — moving them to a waiting state confirms them as support. This uses {{count}} analyses from your quota.",
    "bulkToastUpdated": "{{count}} conversations updated",
    "bulkToastSkipped": "{{count}} skipped",
```

- [ ] **Step 2: Add FR keys (vouvoiement)**

In `app/i18n/locales/fr.json`, inside the existing `"inbox"` object (next to `"markResolved"`), add:

```json
    "bulkSelectedCount": "{{count}} sélectionnée(s)",
    "bulkSelectAll": "Tout sélectionner",
    "bulkClear": "Désélectionner",
    "bulkMarkResolved": "Marquer résolu",
    "bulkReopen": "Rouvrir",
    "bulkWaitingCustomer": "En attente client",
    "bulkWaitingMerchant": "En attente de moi",
    "bulkMarkNonSupport": "Non-support",
    "bulkConfirm": "Confirmer",
    "bulkCancel": "Annuler",
    "bulkConfirmResolved": "Marquer {{count}} conversations comme résolues ?",
    "bulkConfirmReopen": "Rouvrir {{count}} conversations ?",
    "bulkConfirmWaitingCustomer": "Marquer {{count}} conversations comme « en attente client » ?",
    "bulkConfirmWaitingMerchant": "Marquer {{count}} conversations comme « en attente de moi » ?",
    "bulkConfirmNonSupport": "Marquer {{count}} conversations comme non-support ?",
    "bulkAnalyzeWarning": "{{count}} d'entre elles n'ont jamais été analysées et le seront maintenant — les passer en attente les confirme comme support. Cela consomme {{count}} analyses de votre quota.",
    "bulkToastUpdated": "{{count}} conversations mises à jour",
    "bulkToastSkipped": "{{count}} ignorées",
```

- [ ] **Step 3: Verify JSON parses**

Run: `node -e "require('./app/i18n/locales/en.json'); require('./app/i18n/locales/fr.json'); console.log('ok')"`
Expected: prints `ok` (no JSON syntax error from a trailing comma).

- [ ] **Step 4: Commit**

```bash
git add app/i18n/locales/en.json app/i18n/locales/fr.json
git commit -m "i18n(inbox): bulk action keys"
```

---

### Task 4: `BulkActionBar` component

**Files:**
- Create: `app/components/inbox/BulkActionBar.tsx`

- [ ] **Step 1: Create the component**

Create `app/components/inbox/BulkActionBar.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";

export interface BulkSelectedThread {
  id: string;
  operationalState: string;
  supportNature: string;
  analyzedAt: string | null;
}

type BulkAction =
  | "resolved"
  | "reopen"
  | "waiting_customer"
  | "waiting_merchant"
  | "non_support";

const CONFIRM_KEY: Record<BulkAction, string> = {
  resolved: "inbox.bulkConfirmResolved",
  reopen: "inbox.bulkConfirmReopen",
  waiting_customer: "inbox.bulkConfirmWaitingCustomer",
  waiting_merchant: "inbox.bulkConfirmWaitingMerchant",
  non_support: "inbox.bulkConfirmNonSupport",
};

interface Props {
  selected: BulkSelectedThread[];
  onClear: () => void;
}

export function BulkActionBar({ selected, onClear }: Props) {
  const { t } = useTranslation();
  const fetcher = useFetcher<{ bulkResult?: { updated: number; skipped: number } }>();
  const [pending, setPending] = useState<BulkAction | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const count = selected.length;

  // Exact "site #2" estimate: only waiting_* moves on threads that will flip
  // (supportNature !== confirmed_support) AND were never analyzed.
  const analyzeCount = useMemo(() => {
    if (pending !== "waiting_customer" && pending !== "waiting_merchant") return 0;
    return selected.filter(
      (s) => s.supportNature !== "confirmed_support" && s.analyzedAt === null,
    ).length;
  }, [pending, selected]);

  // Show a result toast once the action returns, then clear the selection.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.bulkResult) {
      const { updated, skipped } = fetcher.data.bulkResult;
      let msg = t("inbox.bulkToastUpdated", { count: updated });
      if (skipped > 0) msg += ` · ${t("inbox.bulkToastSkipped", { count: skipped })}`;
      setToast(msg);
      setPending(null);
      onClear();
    }
  }, [fetcher.state, fetcher.data, t, onClear]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  if (count === 0 && !toast) return null;

  function submit() {
    if (!pending) return;
    fetcher.submit(
      {
        _action: "bulkThreadAction",
        bulkAction: pending,
        threadIds: JSON.stringify(selected.map((s) => s.id)),
      },
      { method: "post" },
    );
  }

  const busy = fetcher.state !== "idle";

  return (
    <>
      {count > 0 && (
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 5,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            padding: "8px 12px",
            marginBottom: 8,
            background: "#1f2937",
            color: "white",
            borderRadius: 8,
          }}
        >
          <strong>{t("inbox.bulkSelectedCount", { count })}</strong>
          <BulkBtn label={t("inbox.bulkMarkResolved")} onClick={() => setPending("resolved")} />
          <BulkBtn label={t("inbox.bulkReopen")} onClick={() => setPending("reopen")} />
          <BulkBtn label={t("inbox.bulkWaitingCustomer")} onClick={() => setPending("waiting_customer")} />
          <BulkBtn label={t("inbox.bulkWaitingMerchant")} onClick={() => setPending("waiting_merchant")} />
          <BulkBtn label={t("inbox.bulkMarkNonSupport")} onClick={() => setPending("non_support")} />
          <button
            type="button"
            onClick={onClear}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "white", cursor: "pointer", textDecoration: "underline" }}
          >
            {t("inbox.bulkClear")}
          </button>
        </div>
      )}

      {pending && (
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
            zIndex: 50,
          }}
          onClick={() => !busy && setPending(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "white", borderRadius: 12, padding: 24, maxWidth: 440, width: "90%" }}
          >
            <p style={{ fontWeight: 600, marginBottom: 12 }}>
              {t(CONFIRM_KEY[pending], { count })}
            </p>
            {analyzeCount > 0 && (
              <p style={{ color: "#b45309", background: "#fffbeb", padding: 8, borderRadius: 6, fontSize: 13 }}>
                ⚠ {t("inbox.bulkAnalyzeWarning", { count: analyzeCount })}
              </p>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" onClick={() => setPending(null)} disabled={busy}>
                {t("inbox.bulkCancel")}
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                style={{ background: "#047857", color: "white", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer" }}
              >
                {t("inbox.bulkConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#111827",
            color: "white",
            padding: "10px 16px",
            borderRadius: 8,
            zIndex: 60,
          }}
        >
          {toast}
        </div>
      )}
    </>
  );
}

function BulkBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ background: "white", color: "#111827", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 13 }}
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors in `BulkActionBar.tsx`.

- [ ] **Step 3: Commit**

```bash
git add app/components/inbox/BulkActionBar.tsx
git commit -m "feat(inbox): BulkActionBar component"
```

---

### Task 5: Inbox selection state + checkboxes

**Files:**
- Modify: `app/routes/app.inbox.tsx`

The inbox renders a list of thread rows (the `ThreadRow`/list-item component, roughly lines 1800–2030) inside a main list component that already has the filtered thread array and the `filters` state.

- [ ] **Step 1: Add selection state in the main inbox component**

In the top-level inbox component that owns `filters`, add (near the other `useState` hooks):

```tsx
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

const toggleSelected = useCallback((id: string) => {
  setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}, []);

const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
```

Import `useCallback` if not already imported, and `BulkActionBar` + its type:

```tsx
import { BulkActionBar, type BulkSelectedThread } from "../components/inbox/BulkActionBar";
```

- [ ] **Step 2: Clear selection when the filter/search changes**

Add an effect in the same component (use the existing `filters` object that drives the filtered list):

```tsx
useEffect(() => {
  setSelectedIds(new Set());
}, [filters]);
```

- [ ] **Step 3: Build the selected-thread metadata + render the bar**

Where the filtered thread array is available (the array the list maps over — call it `visibleThreads`; use the actual variable name in scope), compute the selected metadata and render the bar just above the list:

```tsx
const selectedMeta: BulkSelectedThread[] = visibleThreads
  .filter((th) => selectedIds.has(th.canonicalThreadId))
  .map((th) => ({
    id: th.canonicalThreadId,
    operationalState: th.operationalState,
    supportNature: th.supportNature,
    analyzedAt: th.analyzedAt,
  }));

// ...in JSX, immediately before the list:
<BulkActionBar selected={selectedMeta} onClear={clearSelection} />
```

> Use the real per-thread field names from the serialized thread type in this file (around lines 578–616): `canonicalThreadId`, `operationalState`, `supportNature`, `analyzedAt`. If the list variable is named differently (e.g. `threads`, `filtered`), use that name.

- [ ] **Step 4: Add a checkbox to each row**

Pass `selected` + `onToggle` into the row component and render a checkbox that does NOT open the thread:

```tsx
// row props
selected={selectedIds.has(thread.canonicalThreadId)}
onToggleSelect={() => toggleSelected(thread.canonicalThreadId)}

// inside the row, as the first child of the row container:
<input
  type="checkbox"
  checked={selected}
  onChange={onToggleSelect}
  onClick={(e) => e.stopPropagation()}
  aria-label="select conversation"
  style={{ marginRight: 8 }}
/>
```

Add the two props to the row component's prop type.

- [ ] **Step 5: Add a "select all (current filter)" checkbox**

Above the list (next to the `BulkActionBar` or in the list header), add:

```tsx
<label style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0" }}>
  <input
    type="checkbox"
    checked={visibleThreads.length > 0 && selectedIds.size === visibleThreads.length}
    onChange={(e) => {
      if (e.target.checked) setSelectedIds(new Set(visibleThreads.map((th) => th.canonicalThreadId)));
      else setSelectedIds(new Set());
    }}
  />
  {t("inbox.bulkSelectAll")}
</label>
```

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: no NEW errors beyond the pre-existing inbox errors in TECHNICAL_DEBT.md.

- [ ] **Step 7: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat(inbox): multi-select checkboxes + bulk action bar"
```

---

### Task 6: Manual verification + full test run

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit + integration suite**

Run: `npm test` then `npm run test:integration -- bulk-thread-action`
Expected: all pass.

- [ ] **Step 2: Manual UI verification via Playwright MCP**

Per the user's testing preference (test it yourself via Playwright MCP on the user's store — do not ask the user to click manually):
- Open `/app/inbox`.
- Select 2–3 conversations with the checkboxes; confirm the bar shows the count.
- Use "Tout sélectionner"; confirm all visible rows check.
- Click "Marquer résolu" → confirm the dialog appears → confirm → toast shows "N conversations mises à jour" and the rows leave the open buckets.
- Select an unanalyzed `to_analyze` conversation, click "En attente de moi" → confirm the dialog shows the ⚠ quota warning with the right count.
- Change the filter → confirm the selection clears.

- [ ] **Step 3: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "fix(inbox): bulk action verification fixes"
```

---

## Self-review notes

- **Spec coverage:** selection model (Task 5), 3 bulk action families (Task 1), confirmation + toast (Task 4), quota warning with exact site-#2 estimate (Task 4 `analyzeCount`), deferred reopen tracking (handler comment, no inline Tier 3), shop-scoping + cap 500 (Task 1), `BulkActionBar` in its own file to avoid growing `app.inbox.tsx` (Task 4). All covered.
- **Side-effect parity:** handler enqueues `analyze_thread` only on `supportNature !== confirmed_support && analyzedAt === null` (site #2), never routes through `handleUpdateClassification` (site #3).
- **Type consistency:** `BulkSelectedThread` (Task 4) matches the metadata built in Task 5; `BulkThreadActionKind` values match the i18n `CONFIRM_KEY` map keys and the handler's `BULK_ACTION_KINDS`.
```
