# iPhone Inbox Layout Investigation & Fix

**Date:** 2026-05-04
**Scope:** Inbox route only. Reproduce iPhone-only layout issues, set up tooling to *see* them, then fix the iOS-Safari-specific causes.

---

## Context

User reports the inbox layout is broken on iPhone but works on Android. The recent
[mobile responsive work](./2026-05-03-mobile-responsive-design.md) was audited
exclusively at a 375px viewport on **Chromium** ([playwright.config.ts](../../../playwright.config.ts)
declares only `Desktop Chrome`; [tests/e2e/mobile.spec.ts](../../../tests/e2e/mobile.spec.ts)
just resizes the Chromium viewport to 375×812). That audit cannot detect WebKit-only
rendering bugs.

Reported symptom: "le layout est cassé / c'est moche" — most likely overlapping or
mis-arranged elements (cf. classic iOS-Safari pitfalls below).

---

## Hypothesised iOS-only causes

Confirmed by reading the source — these are likely contributors, to be validated
against captured screenshots:

1. **`min-height: 100vh`** on `.ui-inbox-root` ([tokens.css:438](../../../app/components/ui/tokens.css#L438)).
   Mobile Safari's `100vh` includes the dynamic toolbar area, so the page is
   *taller than the visible viewport* → bottom content sits under the Safari
   toolbar / Shopify Mobile chrome. Fix: `100dvh` with a `100vh` fallback.

2. **No `viewport-fit=cover`** in [root.tsx:15](../../../app/root.tsx#L15).
   Without it, iOS reserves the safe-area insets as letterboxing instead of
   exposing them via `env(safe-area-inset-*)`. On notched / Dynamic Island
   iPhones the page looks "framed" and any background color stops short.

3. **No `env(safe-area-inset-*)` padding** anywhere. The mobile back button
   ([app.inbox.tsx:2909-2927](../../../app/routes/app.inbox.tsx#L2909-L2927)) sits
   close to the top edge — on a notched iPhone in Shopify Mobile it can collide
   with the system status bar.

4. **`overflow-x: clip`** ([tokens.css:524, 531](../../../app/components/ui/tokens.css#L524))
   only landed in Safari 15.4 (March 2022). Older iOS users will see overflow
   leak. Lower-priority since 15.4+ covers the vast majority of iOS today.

5. **Polaris web components in iframe**: `s-stack`, `s-page`, `s-button`. WebKit
   handles `display: contents` on custom elements differently from Blink. Likely
   cause of "columns mal disposées" reported by user. Validation will come from
   the screenshots.

These are hypotheses, not the design. The design itself is the **diagnostic
tooling** — once we have screenshots, we fix what we see.

---

## Design

### Component 1 — Playwright projects for real-device emulation

Add two new projects to [playwright.config.ts](../../../playwright.config.ts):

| Project | Engine | Device descriptor | Purpose |
|---------|--------|-------------------|---------|
| `mobile-webkit-iphone` | WebKit | `devices['iPhone 14']` (390×844, DPR 3, iOS UA) | Reproduce iPhone rendering |
| `mobile-chromium-android` | Chromium | `devices['Pixel 7']` (412×915, DPR 2.625, Android UA) | Side-by-side baseline |

The existing `chromium` desktop project stays. Tests opt into projects via the
`--project` CLI flag, so existing CI / dev test runs are not affected.

**Why two devices:** the user already says Android works. Capturing both lets us
trivially diff iPhone vs Android visuals and isolate WebKit-specific bugs from
generic mobile-layout bugs.

### Component 2 — Visual capture spec

New file: `tests/e2e/iphone-layout-capture.spec.ts`.

Captures full-page PNG screenshots of three inbox states. Each screenshot is
saved twice — once per project — into device-specific folders so they can be
compared side-by-side:

- `tests/e2e/screenshots/{project-name}/inbox-empty.png`
- `tests/e2e/screenshots/{project-name}/inbox-with-thread-list.png`
- `tests/e2e/screenshots/{project-name}/inbox-thread-detail.png`

The three states:

1. **Empty inbox** — no threads, default state on `/app/inbox`
2. **Thread list** — one seeded support thread, `to_handle` filter active
3. **Thread detail** — same seed, thread opened (mobile full-screen detail view)

The spec uses the same auth machinery as [mobile.spec.ts](../../../tests/e2e/mobile.spec.ts)
(seeded session in [global-setup.ts](../../../tests/e2e/global-setup.ts) +
[helpers/db.ts](../../../tests/e2e/helpers/db.ts)).

### Component 3 — Investigation loop (manual)

The screenshots are not assertions — they are **artifacts the assistant reads
back**. Workflow:

```bash
npm run test:e2e -- --project=mobile-webkit-iphone --project=mobile-chromium-android
```

Then the assistant reads `screenshots/mobile-webkit-iphone/*.png` and
`screenshots/mobile-chromium-android/*.png` with the Read tool, compares them,
identifies real issues, and proposes targeted fixes. The fixes themselves are
**out of scope of this spec** — they will be planned and applied based on what
the screenshots show.

This is deliberate: jumping to "fix `100vh`" before seeing the actual broken
layout risks fixing the wrong thing. The spec delivers the *eye*, not the cure.

### Component 4 — Screenshot folder hygiene

Add `tests/e2e/screenshots/` to `.gitignore`. The screenshots are diagnostic,
not regressions to commit. (If we later want pixel-perfect regression tests,
that's a separate spec — those would use `expect(page).toHaveScreenshot()` with
committed baselines.)

---

## Out of scope

- Fixes to the actual layout bugs. (Separate plan, post-investigation.)
- Pixel-regression / snapshot testing for CI. (Different problem.)
- Settings, Dashboard, or any other route — only inbox, per user.
- Real-device testing via the existing Cloudflare tunnel. (User can do this
  himself; not something we automate today.)
- The 1-2% of bugs that come from Shopify Mobile's WebView wrapper rather than
  the WebKit engine itself. Acknowledged limitation.

---

## Risks & limitations

- **WebKit ≠ Shopify Mobile WebView.** Playwright WebKit ≈ Safari, but the
  Shopify Mobile app embeds the merchant's app in its own WebView with its
  own chrome. Most rendering bugs come from the engine, not the wrapper, so
  this covers the bulk of cases. Final validation on a real iPhone via the
  existing Cloudflare tunnel remains the user's responsibility.

- **`devices['iPhone 14']`** uses one viewport. Users on iPhone SE (smaller),
  iPhone Pro Max (larger), or in landscape may have additional issues this
  capture won't surface. If reports persist after the fixes, we can add more
  device descriptors.

- **First-time `npx playwright install webkit`** is required to download the
  WebKit binaries (~60 MB). Done once per machine; documented in the plan.

---

## Success criteria

1. `npm run test:e2e -- --project=mobile-webkit-iphone` produces three readable
   PNG screenshots of the inbox in iPhone 14 viewport with the WebKit engine.
2. The same command with `--project=mobile-chromium-android` produces the
   Android equivalents.
3. The assistant can read both sets, compare, and produce an itemised list of
   visible iOS-only divergences ready for a follow-up fix plan.
4. No regression in existing e2e tests (they run on the unchanged `chromium`
   project).

---

## Diagnosis (filled after first capture run, 2026-05-04)

### Methodology

Captured `tests/e2e/iphone-layout-capture.spec.ts` against:
- `mobile-webkit-iphone` — `devices['iPhone 14']` (390×844, DPR 3, WebKit)
- `mobile-chromium-android` — `devices['Pixel 7']` (412×915, DPR 2.625, Chromium)

Three states each: empty (no Gmail connection), thread-list (one seeded
support thread), thread-detail (mobile full-screen view).

Required infra add-ons that surfaced during the run, not in the original spec:
1. **`E2E_AUTH_BYPASS` in `app/shopify.server.ts`** — without it, the cookie
   pre-seed in `global-setup.ts` is rejected by `authenticate.admin()` and all
   captures rendered the Shopify *login* fallback. The existing `mobile.spec.ts`
   tests had been silently passing against the login page because they only
   asserted geometry (`scrollWidth <= clientWidth`) — a separate finding worth
   flagging to the team.
2. **`seedMailConnection` helper in `tests/e2e/helpers/db.ts`** — without it,
   `getConnection(shop)` returned null and the inbox showed the "Connect your
   email" empty state instead of the seeded thread.

### iOS-only divergences observed

| State | Symptom (visible in iPhone PNG, absent on Pixel) | Suspected cause | Confidence |
|-------|--------------------------------------------------|-----------------|------------|
| empty | "Connect Gmail" + "Connect Zoho Mail" stack **vertically** on iPhone, but render **side-by-side** on Pixel — even though Pixel is the *wider* viewport (412 vs 390) where you'd expect them to fit more easily, not less. Suggests a WebKit-specific min-width / flex-basis interaction inside the Polaris `<s-stack direction="inline">` component. | Polaris `<s-stack>` web component's flex behavior under WebKit, possibly minimum content sizing on `<s-button>`. | medium |
| detail | The thread-detail card fills nearly the full visible height on iPhone, leaving very little breathing room. On Pixel the same card is short and there is a large empty area below it (the page extends to 100vh = ~1500px while content is ~700px). | `.ui-inbox-root { min-height: 100vh }` produces different "empty void below content" behaviors due to WebKit's address-bar-aware viewport vs Blink's stable viewport. Cosmetic, not broken — but explains why the detail view "feels right" on iPhone and "feels weirdly tall" on Pixel. | high |

### Issues present on **both** iPhone and Pixel (not iOS-only — out of scope of this investigation)

1. **Top app nav rendered as one concatenated string**: `HomeEmail inboxDashboardSettings` with no spacing or separators between links. This is the Shopify App Bridge `<s-app-nav>` web component rendering without its visual styles when the app is hit *outside* the Shopify Admin iframe (which is what the e2e bypass mode does). In production inside Shopify Mobile, this nav is replaced by the host app's navigation, so end-users do *not* see this. Filed as a finding-of-method, not a bug to fix here.
2. **Badge shows `##TEST-001` (double hash)**: pre-existing data display issue; the seed already has `#TEST-001` in `resolvedOrderNumber` and the UI prepends another `#`. Not iOS-related, separate fix.
3. **Filter tabs "Resolved" is truncated to "Res…"** on iPhone (390px) but fully visible on Pixel (412px). This is a narrow-viewport edge case (the tabs row barely fits at 412 and overflows by ~20px at 390), not iOS-specific — would also appear on a Chromium browser at the same width. The horizontal-scroll fallback in `tokens.css:360` works (the user can scroll to reveal the rest), but no scroll affordance is shown so it's not obvious there's more content.

### Hypotheses from the spec — verdict

| Hypothesis | Verdict |
|------------|---------|
| `100vh` vs `100dvh` on `.ui-inbox-root` | **Partially confirmed.** Causes the cosmetic "empty void below content" on Pixel but not iPhone (the address bar makes iPhone's 100vh effectively equal to the visible viewport). The opposite of the original prediction — but still a real cross-platform inconsistency. |
| Missing `viewport-fit=cover` | **Not confirmed by these captures.** Playwright runs without the device's actual notch/Dynamic Island chrome, so safe-area issues won't show up in this tooling. Still worth fixing for real-device parity. |
| Missing `env(safe-area-inset-*)` | Same as above — not visible in Playwright captures. Still worth doing. |
| Polaris web component layout drift | **Confirmed** for `<s-stack direction="inline">` in the empty-state buttons. Different flex behavior on WebKit vs Blink at narrow widths. |
| Other | The "tabs row truncation at 390px" is real but cross-platform, not iOS-only. `min-height: 100vh` actually behaves *better* on iPhone than Pixel for this layout (opposite of the typical iOS gripe). |

### Honest caveat

The captures **do not include the Shopify Mobile app's WebView wrapper**.
Real merchants on iPhone use Automail through the Shopify Mobile app, which
embeds the app in its own WebView with its own chrome (status bar handling,
safe-area, navigation gesture). That layer is not reproducible in Playwright.
If the user's reports persist after the fixes below, the next step is to
test on a real iPhone via the existing Cloudflare tunnel
(`annual-stadium-lab-and.trycloudflare.com`) inside the Shopify Mobile app.

### Recommended next plan (priority-ordered)

1. **Polaris `<s-stack>` behavior** in the empty-state and the thread action
   row — pin it with explicit CSS (e.g. `.ui-thread-actions-row` already does
   this; apply the same pattern to the Connect-email card). Highest visible
   payoff for the iPhone-specific complaint.
2. **`viewport-fit=cover` + `env(safe-area-inset-*)`** — real-device polish
   that this tooling cannot validate but which costs ~10 lines and fixes the
   classic notch/Dynamic Island letterboxing issue.
3. **Replace `min-height: 100vh` with `100dvh` (with `100vh` fallback)** on
   `.ui-inbox-root` — fixes the Pixel/Chromium "weird empty space below" and
   makes mobile Safari's behavior more predictable across browsers.
4. **Filter tabs visual scroll affordance at narrow widths** — small
   gradient/shadow on the right edge so users know more tabs are reachable.
   Not iOS-specific but the truncation surfaced in this investigation.
5. **Out-of-scope but worth filing**: the `##TEST-001` double-hash, and the
   silent-pass behavior of geometry-only e2e assertions in `mobile.spec.ts`.
