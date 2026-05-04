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
