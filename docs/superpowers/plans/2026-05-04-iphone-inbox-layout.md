# iPhone Inbox Layout Investigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up Playwright WebKit + iPhone emulation alongside an Android baseline, capture inbox screenshots in three states, then read those screenshots to produce a concrete iPhone-bug diagnosis.

**Architecture:** Two new Playwright projects (`mobile-webkit-iphone`, `mobile-chromium-android`) reuse the existing seeded-session auth from [tests/e2e/global-setup.ts](../../../tests/e2e/global-setup.ts). One new spec captures three inbox states as full-page PNGs into project-named folders. The fixes themselves are out of scope — they will be planned in a follow-up after the screenshots are read.

**Tech Stack:** Playwright (`@playwright/test` already a dev dep), WebKit engine (downloaded once via `npx playwright install webkit`), existing Prisma seed helpers in [tests/e2e/helpers/db.ts](../../../tests/e2e/helpers/db.ts).

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| [playwright.config.ts](../../../playwright.config.ts) | Modify | Add `mobile-webkit-iphone` + `mobile-chromium-android` projects |
| `.gitignore` | Modify | Exclude `tests/e2e/screenshots/` (diagnostic artifacts, not committed) |
| `tests/e2e/iphone-layout-capture.spec.ts` | Create | Three tests capturing empty / list / detail states as PNGs |
| `docs/superpowers/specs/2026-05-04-iphone-inbox-layout-design.md` | Read | Source spec |

---

## Prerequisites (one-time, machine-local)

The dev server and the WebKit binary must be available before any task runs.

- [ ] **Step P1: Install the WebKit Playwright binary**

Run: `npx playwright install webkit`
Expected: downloads ~60 MB of WebKit + system deps; ends with `Webkit ... downloaded`. Re-running it is a no-op if already installed.

- [ ] **Step P2: Confirm the e2e dev server is reachable**

The existing playwright config uses `baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:58496'`. Make sure either:
- a server is running at `localhost:58496`, OR
- `E2E_BASE_URL` is exported pointing to wherever your `npm run dev` output is reachable (commonly `http://localhost:4000` per [shopify.web.toml](../../../shopify.web.toml)).

Run: `curl -sS -o /dev/null -w '%{http_code}\n' "${E2E_BASE_URL:-http://localhost:58496}/app/inbox"`
Expected: a 3xx or 200 response (not a connection refused). If it fails, start the server with `npm run dev` and re-export `E2E_BASE_URL` accordingly.

---

## Task 1: Add the two new Playwright projects

**Files:**
- Modify: [playwright.config.ts](../../../playwright.config.ts) (whole `projects` array)

- [ ] **Step 1: Replace the projects array with the three projects**

Open [playwright.config.ts](../../../playwright.config.ts). Replace the `projects` array (lines 15-17) so the file reads:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:58496',
    storageState: 'tests/e2e/.auth/session.json',
    trace: 'on-first-retry',
  },
  globalSetup: './tests/e2e/global-setup.ts',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-webkit-iphone', use: { ...devices['iPhone 14'] } },
    { name: 'mobile-chromium-android', use: { ...devices['Pixel 7'] } },
  ],
});
```

Why these device descriptors specifically:
- `iPhone 14` → 390×844 viewport, DPR 3, iOS Safari UA, WebKit engine. Representative of the median iPhone in 2024-2026.
- `Pixel 7` → 412×915, Chromium engine, Android UA. Larger than iPhone 14, so any layout that fits there but not iPhone 14 is a smoking gun.

- [ ] **Step 2: Verify both new projects are discovered by Playwright**

Run: `npx playwright test --list --project=mobile-webkit-iphone --project=mobile-chromium-android | head -5`
Expected: lists at least the existing tests under both project names without an "unknown project" error. (No new tests yet — that's Task 3.)

- [ ] **Step 3: Verify existing chromium tests still run**

Run: `npm run test:e2e -- --project=chromium tests/e2e/mobile.spec.ts`
Expected: same result you got before this PR (tests pass or fail exactly as on `main`). The point is that the existing project is unaffected.

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts
git commit -m "test(e2e): add iPhone WebKit and Pixel 7 Playwright projects

Adds mobile-webkit-iphone (devices['iPhone 14']) and
mobile-chromium-android (devices['Pixel 7']) so future specs can
exercise the inbox in real iOS Safari and a comparable Android viewport.
The existing chromium project is untouched."
```

---

## Task 2: Ignore the screenshots folder

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Append the screenshots folder to .gitignore**

Add a new line (under the existing `# Playwright` section near the bottom of [.gitignore](../../../.gitignore)):

```
tests/e2e/screenshots/
```

The full Playwright section in `.gitignore` should now read:

```
# Playwright
test-results/
playwright-report/
tests/e2e/.auth/
tests/e2e/screenshots/
```

- [ ] **Step 2: Verify git ignores future captures**

Run:
```bash
mkdir -p tests/e2e/screenshots/probe && touch tests/e2e/screenshots/probe/x.png
git status --short tests/e2e/screenshots/
rm -rf tests/e2e/screenshots/probe
```
Expected: `git status` prints nothing for that folder (file is ignored).

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore tests/e2e/screenshots (diagnostic-only output)"
```

---

## Task 3: Write the visual capture spec — empty inbox state

**Files:**
- Create: `tests/e2e/iphone-layout-capture.spec.ts`

We build the spec one state at a time so each step produces a verifiable PNG before the next is added. There is no assertion-style "failing test" here because the deliverable is a *captured artifact*, not a behavioral assertion. The verification each step is "the PNG file exists and is non-empty".

- [ ] **Step 1: Create the spec with the empty-inbox capture**

Create [tests/e2e/iphone-layout-capture.spec.ts](../../../tests/e2e/iphone-layout-capture.spec.ts):

```ts
// tests/e2e/iphone-layout-capture.spec.ts
//
// Diagnostic-only spec: captures full-page PNG screenshots of the inbox
// in three states across the three projects. The PNGs land in
// tests/e2e/screenshots/<project-name>/ and are NOT assertions —
// they are artifacts the assistant reads to diagnose iOS-Safari-only
// layout bugs.
//
// Run with:
//   npm run test:e2e -- --project=mobile-webkit-iphone tests/e2e/iphone-layout-capture.spec.ts
//   npm run test:e2e -- --project=mobile-chromium-android tests/e2e/iphone-layout-capture.spec.ts
import { test } from '@playwright/test';
import path from 'node:path';
import { cleanE2EData, seedSupportThread, db } from './helpers/db';

const SCREENSHOT_DIR = 'tests/e2e/screenshots';

function shotPath(projectName: string, name: string): string {
  return path.join(SCREENSHOT_DIR, projectName, `${name}.png`);
}

test.beforeEach(async () => {
  await cleanE2EData();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('capture: inbox empty', async ({ page }, testInfo) => {
  await page.goto('/app/inbox');
  await page.waitForLoadState('networkidle');
  await page.screenshot({
    path: shotPath(testInfo.project.name, 'inbox-empty'),
    fullPage: true,
  });
});
```

- [ ] **Step 2: Run the empty-inbox capture on all three projects**

Run:
```bash
npm run test:e2e -- \
  --project=mobile-webkit-iphone \
  --project=mobile-chromium-android \
  --project=chromium \
  tests/e2e/iphone-layout-capture.spec.ts
```
Expected: 3 tests pass. PNGs exist at:
- `tests/e2e/screenshots/mobile-webkit-iphone/inbox-empty.png`
- `tests/e2e/screenshots/mobile-chromium-android/inbox-empty.png`
- `tests/e2e/screenshots/chromium/inbox-empty.png`

Verify with `ls -la tests/e2e/screenshots/*/inbox-empty.png` — all three files should be present and non-zero bytes.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/iphone-layout-capture.spec.ts
git commit -m "test(e2e): capture inbox-empty screenshot across iPhone/Pixel/Chromium"
```

---

## Task 4: Add the thread-list capture

**Files:**
- Modify: `tests/e2e/iphone-layout-capture.spec.ts`

- [ ] **Step 1: Append the thread-list test**

At the end of [tests/e2e/iphone-layout-capture.spec.ts](../../../tests/e2e/iphone-layout-capture.spec.ts), add:

```ts
test('capture: inbox with thread list', async ({ page }, testInfo) => {
  await seedSupportThread({ operationalState: 'waiting_merchant' });

  await page.goto('/app/inbox');
  // Make sure we land on the "To handle" tab so the seeded thread shows up.
  await page.getByRole('button', { name: /to handle/i }).click();
  await page.waitForLoadState('networkidle');

  await page.screenshot({
    path: shotPath(testInfo.project.name, 'inbox-with-thread-list'),
    fullPage: true,
  });
});
```

- [ ] **Step 2: Run only the new test on all three projects**

Run:
```bash
npm run test:e2e -- \
  --project=mobile-webkit-iphone \
  --project=mobile-chromium-android \
  --project=chromium \
  tests/e2e/iphone-layout-capture.spec.ts \
  -g "thread list"
```
Expected: 3 tests pass. New PNGs at `tests/e2e/screenshots/<project>/inbox-with-thread-list.png` for each project.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/iphone-layout-capture.spec.ts
git commit -m "test(e2e): capture inbox-with-thread-list screenshot"
```

---

## Task 5: Add the thread-detail capture

**Files:**
- Modify: `tests/e2e/iphone-layout-capture.spec.ts`

- [ ] **Step 1: Append the thread-detail test**

At the end of [tests/e2e/iphone-layout-capture.spec.ts](../../../tests/e2e/iphone-layout-capture.spec.ts), add:

```ts
test('capture: inbox thread detail (mobile full-screen view)', async ({ page }, testInfo) => {
  await seedSupportThread({ operationalState: 'waiting_merchant' });

  await page.goto('/app/inbox');
  await page.getByRole('button', { name: /to handle/i }).click();
  // Click the seeded thread by its subject. seedSupportThread defaults to
  // "Où est ma commande #TEST-001 ?".
  await page.getByText('Où est ma commande #TEST-001').click();
  await page.waitForLoadState('networkidle');

  await page.screenshot({
    path: shotPath(testInfo.project.name, 'inbox-thread-detail'),
    fullPage: true,
  });
});
```

Note: on mobile viewports the inbox replaces the list with a full-screen detail
view (see [app.inbox.tsx:2905](../../../app/routes/app.inbox.tsx#L2905)). On the
desktop `chromium` project it instead shows the side-panel layout. Both are
valuable to capture — desktop is the *intended* layout, mobile-webkit shows what
the iPhone user actually sees.

- [ ] **Step 2: Run only the new test on all three projects**

Run:
```bash
npm run test:e2e -- \
  --project=mobile-webkit-iphone \
  --project=mobile-chromium-android \
  --project=chromium \
  tests/e2e/iphone-layout-capture.spec.ts \
  -g "thread detail"
```
Expected: 3 tests pass. New PNGs at `tests/e2e/screenshots/<project>/inbox-thread-detail.png` for each project.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/iphone-layout-capture.spec.ts
git commit -m "test(e2e): capture inbox thread-detail screenshot"
```

---

## Task 6: Run the full capture suite and produce the diagnosis

This is the deliverable the user asked for — the assistant looks at the PNGs
and produces an actionable list of iOS-Safari-specific layout problems. No
code changes here; the output is a written diagnosis that becomes the input
to a follow-up fix plan.

- [ ] **Step 1: Run the full capture suite**

Run:
```bash
npm run test:e2e -- \
  --project=mobile-webkit-iphone \
  --project=mobile-chromium-android \
  --project=chromium \
  tests/e2e/iphone-layout-capture.spec.ts
```
Expected: 9 tests pass (3 states × 3 projects). All 9 PNGs present under `tests/e2e/screenshots/`.

- [ ] **Step 2: Read each iPhone PNG with the Read tool**

For each of:
- `tests/e2e/screenshots/mobile-webkit-iphone/inbox-empty.png`
- `tests/e2e/screenshots/mobile-webkit-iphone/inbox-with-thread-list.png`
- `tests/e2e/screenshots/mobile-webkit-iphone/inbox-thread-detail.png`

use the Read tool to load it and observe what's actually broken. The Read tool
displays PNGs visually — describe what you see in each.

- [ ] **Step 3: Read each Android PNG and compare**

Same three states, but `mobile-chromium-android/`. For each pair (iPhone vs
Pixel of the same state), note specifically what diverges. Anything that's
broken on Android too is *not* an iOS-only bug — keep those out of this
investigation's scope.

- [ ] **Step 4: Write the diagnosis to the spec doc**

Append a new section `## Diagnosis (filled after first capture run)` to
[docs/superpowers/specs/2026-05-04-iphone-inbox-layout-design.md](2026-05-04-iphone-inbox-layout-design.md)
with the format:

```markdown
## Diagnosis (filled after first capture run)

### iOS-only divergences observed

| State | Symptom (visible in iPhone PNG, absent from Pixel PNG) | Suspected cause | Confidence |
|-------|--------------------------------------------------------|-----------------|------------|
| empty | <describe> | <element + CSS property> | high/med/low |
| list  | <describe> | ... | ... |
| detail| <describe> | ... | ... |

### Issues confirmed against hypotheses from the spec

- [ ] `100vh` vs `100dvh` on `.ui-inbox-root` — confirmed / not visible
- [ ] Missing `viewport-fit=cover` — confirmed / not visible
- [ ] Missing safe-area insets — confirmed / not visible
- [ ] Polaris web component layout drift — confirmed / not visible
- [ ] Other (not hypothesised): <describe>

### Recommended next plan

<one-paragraph summary of what the fix plan should target, ordered by impact>
```

Be specific. "Header overlaps with content" is fine; "header" alone is not.

- [ ] **Step 5: Commit the diagnosis**

```bash
git add docs/superpowers/specs/2026-05-04-iphone-inbox-layout-design.md
git commit -m "docs: append iPhone inbox diagnosis from captured screenshots"
```

- [ ] **Step 6: Hand off to the user for fix-plan approval**

Report back to the user with:
1. The 3 iPhone PNG paths so they can open them locally if they want.
2. The bullet-list of iOS-only divergences from the diagnosis section.
3. A proposal: "Want me to write the follow-up fix plan based on this
   diagnosis, or do you want to look at the screenshots yourself first?"

---

## Self-review notes

Spec coverage:
- Component 1 (Playwright projects) → Task 1 ✓
- Component 2 (Visual capture spec) → Tasks 3, 4, 5 ✓
- Component 3 (Investigation loop) → Task 6 ✓
- Component 4 (Screenshot folder hygiene) → Task 2 ✓
- Success criterion 1-3 (PNGs produced + read + itemised list) → Task 6 ✓
- Success criterion 4 (no regression in existing e2e) → Task 1 step 3 ✓

Type / name consistency:
- `shotPath(projectName, name)` defined Task 3, reused Tasks 4 & 5 with the
  same signature ✓
- Project names `mobile-webkit-iphone` / `mobile-chromium-android` used
  identically in config (Task 1) and CLI invocations (Tasks 3-6) ✓
- `seedSupportThread` and `cleanE2EData` imports match the helper file
  ([helpers/db.ts](../../../tests/e2e/helpers/db.ts)) ✓

No placeholders. Each step has either complete code or an exact command with
expected output.
