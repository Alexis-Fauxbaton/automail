# Mobile Responsive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inbox, dashboard, and settings fully usable on mobile (375px) without touching the desktop layout.

**Architecture:** Add responsive CSS utility classes to `tokens.css` and replace the specific inline styles that break on mobile. Add a `useMobile` hook that drives mobile-only full-screen navigation in the inbox (clicking a thread replaces the list entirely; Back button returns to it). All changes are behind media queries or the `isMobile` flag — desktop is untouched.

**Tech Stack:** React 18, React Router v7, TypeScript, CSS custom properties (no Tailwind), Vitest (unit), Playwright (e2e)

---

## File Map

| File | What changes |
|---|---|
| `app/hooks/useMobile.ts` | **New** — SSR-safe hook returning `true` when `window.innerWidth ≤ breakpoint` |
| `app/components/ui/tokens.css` | New classes: `.ui-analysis-grid`, `.ui-detail-panel`, `.ui-thread-row-tags`. Modified rules: `.ui-tabs` (mobile scroll), `.ui-grid-4` (2-col at 640px), `.ui-inbox-root` + `.ui-card` (reduced mobile padding). Touch target rule. |
| `app/routes/app.inbox.tsx` | Import `useMobile`. Conditional full-screen render for mobile. Replace 5 inline styles with CSS classes. |
| `app/routes/app.dashboard.tsx` | Remove `minWidth: 280` from hero div (line ~236). |
| `tests/e2e/mobile.spec.ts` | **New** — Playwright tests at 375px viewport verifying no overflow + mobile navigation. |

---

## Task 1: Create branch

**Files:** none

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout -b feat/mobile-responsive
```

Expected: `Switched to a new branch 'feat/mobile-responsive'`

---

## Task 2: Create `useMobile` hook

**Files:**
- Create: `app/hooks/useMobile.ts`

- [ ] **Step 1: Create the hook file**

```ts
// app/hooks/useMobile.ts
import { useEffect, useState } from "react";

/**
 * Returns true when the viewport width is ≤ breakpoint (default 768px).
 * Defaults to false on first render so SSR doesn't crash on missing `window`.
 */
export function useMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= breakpoint);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [breakpoint]);
  return isMobile;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/hooks/useMobile.ts
git commit -m "feat(mobile): add useMobile hook"
```

---

## Task 3: CSS mobile classes in `tokens.css`

**Files:**
- Modify: `app/components/ui/tokens.css`

- [ ] **Step 1: Fix `.ui-tabs` to scroll horizontally on mobile**

Find the `.ui-tabs` rule (around line 320) and add a mobile breakpoint after the closing brace of `.ui-tab--active .ui-tab__count { }`:

```css
@media (max-width: 768px) {
  .ui-tabs {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .ui-tabs::-webkit-scrollbar {
    display: none;
  }
  .ui-tab {
    flex-shrink: 0;
  }
}
```

- [ ] **Step 2: Update `.ui-grid-4` 640px breakpoint to 2 columns**

Find the existing `@media (max-width: 640px)` block that collapses `.ui-grid-4` to 1 column. Change it to 2 columns:

```css
/* Before */
@media (max-width: 640px) {
  .ui-grid-4,
  .ui-grid-2 { grid-template-columns: 1fr; }
}

/* After */
@media (max-width: 640px) {
  .ui-grid-4 { grid-template-columns: 1fr 1fr; }
  .ui-grid-2 { grid-template-columns: 1fr; }
}
```

This gives the stats cards a compact 2×2 grid on mobile. `.ui-grid-2` still collapses to 1 column.

- [ ] **Step 3: Add new mobile utility classes**

Append at the end of `tokens.css`:

```css
/* ── Mobile responsive ──────────────────────────────────────────────── */

/* Two-column analysis panel (order context | draft) → stacks on mobile */
.ui-analysis-grid {
  display: grid;
  grid-template-columns: minmax(160px, 220px) minmax(0, 1fr);
  border-bottom: 1px solid var(--ui-slate-100);
}
@media (max-width: 768px) {
  .ui-analysis-grid {
    grid-template-columns: 1fr;
  }
}

/* Thread detail sticky panel → becomes static on mobile */
.ui-detail-panel {
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
  border-radius: var(--ui-radius-2xl);
}
@media (max-width: 768px) {
  .ui-detail-panel {
    position: static;
    max-height: none;
    overflow-y: visible;
  }
}

/* Thread row badge/pill container — prevents horizontal overflow */
.ui-thread-row-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  overflow: hidden;
  max-width: 100%;
}

/* Reduced padding on mobile */
@media (max-width: 640px) {
  .ui-inbox-root {
    padding: 0 12px 24px;
  }
  .ui-card {
    padding: 14px;
  }
}

/* Minimum 44px touch targets on mobile */
@media (max-width: 768px) {
  .ui-inbox-root button,
  .ui-inbox-root [role="button"] {
    min-height: 44px;
  }
}
```

- [ ] **Step 4: Verify TypeScript + run dev to check no CSS regressions**

```bash
npm run typecheck
```

Expected: no errors. (CSS regressions verified visually in Task 7.)

- [ ] **Step 5: Commit**

```bash
git add app/components/ui/tokens.css
git commit -m "feat(mobile): add responsive CSS classes to tokens"
```

---

## Task 4: Mobile full-screen navigation in `app.inbox.tsx`

**Files:**
- Modify: `app/routes/app.inbox.tsx`

The inbox currently shows a split layout (list left, detail right) on all viewports. On mobile we want: list OR detail, never both at once.

- [ ] **Step 1: Import `useMobile` at the top of the file**

At line 1 (after the existing React imports), add:

```ts
import { useMobile } from "~/hooks/useMobile";
```

- [ ] **Step 2: Add `isMobile` to the main `InboxPage` component**

The main exported component is around line 2449 where `expandedThreadId` state is defined. Add `useMobile` call right after the existing state declarations:

```ts
const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);
const isMobile = useMobile(); // add this line
```

- [ ] **Step 3: Add early return for mobile full-screen detail view**

Find the `selectedThreadMeta` definition (around line 2509):
```ts
const selectedThreadMeta = expandedThreadId
  ? threadMeta.find((m) => m.thread.threadId === expandedThreadId) ?? null
  : null;
```

Immediately after the `selectedThreadMeta` block and before the main `return (`, add:

```tsx
// On mobile: full-screen detail view replaces the list
if (isMobile && selectedThreadMeta) {
  return (
    <div className="ui-inbox-root">
      <div style={{ marginBottom: "12px" }}>
        <button
          type="button"
          onClick={() => setExpandedThreadId(null)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: "14px",
            fontWeight: 500,
            color: "var(--ui-slate-700)",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "0",
          }}
        >
          ← {t("inbox.backToList")}
        </button>
      </div>
      <ThreadDetailPanel
        thread={selectedThreadMeta.thread}
        threadState={selectedThreadMeta.state}
        connectedEmail={loaderData.connectedEmail}
        bucket={selectedThreadMeta.bucket}
        previousContact={selectedThreadMeta.previousContact}
        onClose={() => setExpandedThreadId(null)}
      />
    </div>
  );
}
```

- [ ] **Step 4: Add the `inbox.backToList` i18n key**

Open `app/locales/en.json` and `app/locales/fr.json`. Find the `inbox` section and add:

In `en.json`:
```json
"backToList": "Back to inbox"
```

In `fr.json`:
```json
"backToList": "Retour à la liste"
```

- [ ] **Step 5: Commit**

```bash
git add app/routes/app.inbox.tsx app/locales/en.json app/locales/fr.json
git commit -m "feat(mobile): full-screen thread detail navigation on mobile"
```

---

## Task 5: Replace broken inline styles in `app.inbox.tsx`

**Files:**
- Modify: `app/routes/app.inbox.tsx`

Five inline styles cause layout breakage on mobile. Replace each with the CSS classes defined in Task 3.

- [ ] **Step 1: Replace thread detail 2-column grid (line ~2295)**

Find:
```tsx
<div style={{
  display: "grid",
  gridTemplateColumns: "minmax(160px, 220px) minmax(0, 1fr)",
  borderBottom: "1px solid var(--ui-slate-100)",
}}>
```

Replace with:
```tsx
<div className="ui-analysis-grid">
```

- [ ] **Step 2: Replace sticky detail panel wrapper (line ~2715)**

Find:
```tsx
<div style={{ position: "sticky", top: "16px", maxHeight: "calc(100vh - 120px)", overflowY: "auto", borderRadius: "var(--ui-radius-2xl)" }}>
```

Replace with:
```tsx
<div className="ui-detail-panel">
```

- [ ] **Step 3: Replace thread row badge container (line ~1621)**

Find (inside `ThreadCard` component):
```tsx
<div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", marginBottom: "10px" }}>
```

Replace with:
```tsx
<div className="ui-thread-row-tags">
```

- [ ] **Step 4: Fix search input flex-basis (line ~1106)**

Find (inside `FiltersBar` or the search label):
```tsx
<label style={{ ...labelStyle, flex: "1 1 220px", minWidth: 180 }}>
```

Replace with:
```tsx
<label style={{ ...labelStyle, flex: "1 1 180px", minWidth: 0 }}>
```

This removes the 220px minimum that causes overflow on small screens.

- [ ] **Step 5: Verify TypeScript**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat(mobile): replace overflow-causing inline styles with CSS classes"
```

---

## Task 6: Dashboard minor fix

**Files:**
- Modify: `app/routes/app.dashboard.tsx`

- [ ] **Step 1: Remove hero `minWidth` (line ~236)**

Find the hero left div:
```tsx
<div style={{ minWidth: 280, flex: 1 }}>
```

Replace with:
```tsx
<div style={{ flex: 1, minWidth: 0 }}>
```

`minWidth: 0` allows the div to shrink below its content size on narrow viewports. The title text will wrap naturally.

- [ ] **Step 2: Verify TypeScript**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.dashboard.tsx
git commit -m "feat(mobile): fix dashboard hero overflow on mobile"
```

---

## Task 7: Playwright mobile e2e tests

**Files:**
- Create: `tests/e2e/mobile.spec.ts`

- [ ] **Step 1: Write the mobile e2e test file**

```ts
// tests/e2e/mobile.spec.ts
import { test, expect } from '@playwright/test';
import { cleanE2EData, seedSupportThread, db } from './helpers/db';

const MOBILE_VIEWPORT = { width: 375, height: 812 };

test.beforeEach(async ({ page }) => {
  await cleanE2EData();
  await page.setViewportSize(MOBILE_VIEWPORT);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('inbox list has no horizontal scroll on mobile', async ({ page }) => {
  await page.goto('/app/inbox');

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);

  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2); // 2px tolerance
});

test('filter tabs fit on one line (no wrap) on mobile', async ({ page }) => {
  await page.goto('/app/inbox');

  // All tab buttons should be visible without horizontal page scroll
  await expect(page.getByRole('button', { name: /to handle/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /resolved/i })).toBeVisible();

  // Tabs container must not overflow page width
  const tabsBox = await page.locator('.ui-tabs').boundingBox();
  expect(tabsBox).not.toBeNull();
  expect(tabsBox!.width).toBeLessThanOrEqual(375);
});

test('clicking a thread on mobile shows full-screen detail with back button', async ({ page }) => {
  await seedSupportThread({ operationalState: 'waiting_merchant' });

  await page.goto('/app/inbox');
  await page.getByRole('button', { name: /to handle/i }).click();

  // Click the thread
  await page.getByText('Où est ma commande #TEST-001').click();

  // List should be hidden, back button visible
  await expect(page.getByRole('button', { name: /back to inbox/i })).toBeVisible();
  await expect(page.getByText('Où est ma commande #TEST-001')).toBeVisible(); // subject in detail
});

test('back button returns to inbox list on mobile', async ({ page }) => {
  await seedSupportThread({ operationalState: 'waiting_merchant' });

  await page.goto('/app/inbox');
  await page.getByRole('button', { name: /to handle/i }).click();
  await page.getByText('Où est ma commande #TEST-001').click();

  // Go back
  await page.getByRole('button', { name: /back to inbox/i }).click();

  // List should be visible again
  await expect(page.getByRole('button', { name: /to handle/i })).toBeVisible();
});

test('stats cards appear in 2-column grid on mobile', async ({ page }) => {
  await page.goto('/app/inbox');

  // The PipelineStats grid should have 2 columns — verified by checking
  // that two stat cards share the same Y position (same row)
  const cards = page.locator('.ui-grid-4 .ui-card');
  const count = await cards.count();
  if (count >= 2) {
    const box0 = await cards.nth(0).boundingBox();
    const box1 = await cards.nth(1).boundingBox();
    // Both in same row: their top Y values should be equal (±2px)
    expect(Math.abs(box0!.y - box1!.y)).toBeLessThanOrEqual(2);
  }
});

test('dashboard has no horizontal scroll on mobile', async ({ page }) => {
  await page.goto('/app/dashboard');

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);

  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
});
```

- [ ] **Step 2: Run the mobile e2e tests**

```bash
npm run test:e2e -- tests/e2e/mobile.spec.ts
```

Expected: all 6 tests pass. If a test fails, fix the CSS/JSX in the relevant task and re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/mobile.spec.ts
git commit -m "test(mobile): add Playwright mobile viewport e2e tests"
```

---

## Task 8: Final verification + PR-ready commit

- [ ] **Step 1: Run full test suite**

```bash
npm run test
```

Expected: all unit tests pass (no regressions in existing logic).

- [ ] **Step 2: Run full e2e suite**

```bash
npm run test:e2e
```

Expected: all tests pass including the new mobile tests.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Manual Playwright spot-check at desktop (1280px)**

Open a Playwright script or use `npm run test:e2e:headed` to visually confirm the desktop layout is unchanged:
- Inbox split layout (list + detail panel) still works
- Stats cards still show as 4 columns
- Filter tabs still show inline without scroll
- Dashboard hero still shows two columns

- [ ] **Step 5: Verify branch log looks clean**

```bash
git log main..HEAD --oneline
```

Expected output (5 commits):
```
test(mobile): add Playwright mobile viewport e2e tests
feat(mobile): fix dashboard hero overflow on mobile
feat(mobile): replace overflow-causing inline styles with CSS classes
feat(mobile): full-screen thread detail navigation on mobile
feat(mobile): add responsive CSS classes to tokens
feat(mobile): add useMobile hook
```
