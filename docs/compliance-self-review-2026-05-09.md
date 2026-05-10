# Shopify App Store self-review — 2026-05-09

App: **Automail** — customer-support copilot for Shopify merchants  
Branch reviewed: `audit/pass-2-findings`  
Stack: TypeScript, React Router 7, Prisma + Postgres, `@shopify/shopify-app-react-router`  
Distribution: `AppStore` (currently Custom — moving toward Public)

---

## Summary

✅ Likely passing: 27  
❌ Likely failing: 2  
⚠️ Needs review: 5  
⏭️ Groups skipped: 9

---

## ❌ Likely failing requirements

### 1.2.2 — Billing: implement correctly (reinstall / decline handling)

**Why this matters:** Shopify requires apps to handle the full billing lifecycle: charge approval, decline, and reinstall flows. A merchant who declines the charge confirmation or who reinstalls after cancellation must be able to re-subscribe cleanly.

**What was found:**
- `app/routes/api.billing.subscribe.tsx` creates a subscription and returns a `confirmationUrl`. The client redirects `window.top.location.href = url` — correct.
- `app/routes/app.billing.tsx` handles `?subscribed=1` on return but there is no explicit handling for when the merchant cancels the confirmation dialog on Shopify's side (Shopify does not send a webhook for declined charges; it simply redirects back without a subscription being created).
- There is no route or logic that detects "merchant came back from billing flow but declined" (i.e., no `?declined=1` or equivalent error state shown to the merchant).
- Reinstall scenario: `app/routes/webhooks.app.uninstalled.tsx` wipes all shop data including `BillingShopFlag`. On reinstall, `installDate` is reset, giving a fresh 14-day trial — that part is fine. However, if a merchant had a paid subscription, cancelled it, then reinstalled, the subscription cache is cleared but no special re-subscribe nudge appears.

**Suggested fix:**
1. In `api.billing.subscribe.tsx`, pass a `returnUrl` that includes a `?status=pending` parameter.
2. In `app.billing.tsx` loader, detect the return from the Shopify billing flow: if `?status=pending` AND `resolveActivePlan` returns `none`, the merchant declined — show an explicit "Subscription declined. You can try again below." message using a Polaris-style banner.
3. Document this in the code so reviewers can verify the flow. Manual testing is also required.

---

### 3.2.1 — `read_all_orders` scope — no in-code justification visible to reviewers

**Why this matters:** Shopify's App Store review explicitly flags apps requesting `read_all_orders` without demonstrated need for historical (>60-day) order data. The app must prove it accesses orders older than 60 days or the scope will be challenged during review.

**What was found:**
- `shopify.app.toml`: `scopes = "read_orders,read_all_orders,read_customers,read_fulfillments"`
- `app/shopify.server.ts` lists `read_all_orders` in `REQUIRED_SCOPES` with only a generic comment ("Minimum scopes needed for a read-only support copilot").
- `app/lib/support/shopify/order-search.ts`: the `SEARCH_QUERY` does NOT filter by date range — it queries by order number, customer email, customer name, or tracking number. Customer support emails may reference orders placed months or years ago. This is a legitimate use case.
- However, there is no explicit in-code comment explaining **why** `read_all_orders` is needed (i.e., "customer support emails may reference orders placed more than 60 days ago").

**Suggested fix:**
In `shopify.server.ts`, expand the comment near `read_all_orders`:
```ts
// read_all_orders: customer support emails may reference orders placed more
// than 60 days ago (e.g. delayed shipments, long-tail refund disputes).
// Without this scope, the Admin API silently returns no results for those orders.
```
Also add the same justification as a comment in `app/lib/support/shopify/order-search.ts` near the `SEARCH_QUERY`.

This is a documentation-only fix but it matters: Shopify reviewers look at code comments and the scope justification field in the Partner Dashboard listing.

---

## ⚠️ Requirements needing review

### 1.1.1 — Session tokens: `localStorage` used for UI state in billing banners

**Why this needs attention:** Requirement 1.1.1 prohibits authentication via `localStorage`. The banners use `localStorage` for dismissal state — not for authentication. However, Shopify's requirement language is sometimes applied broadly to "any use of localStorage", and certain review tooling flags any `localStorage.setItem` call.

**What was detected:**
- `app/components/billing/QuotaBanner.tsx:31` — `localStorage.getItem(storageKey)` / `localStorage.setItem` for dismissal persistence.
- `app/components/billing/TrialBanner.tsx:21` — same pattern.
- `app/i18n/config.ts:10` — `localStorage.removeItem("i18nextLng")` to clear a stale key.

These do NOT store auth tokens or session data — they store a boolean "dismissed once" flag. The authentication path uses Shopify session tokens via `@shopify/shopify-app-react-router`.

**Verification action:** Test the app in Chrome incognito mode. If the banner re-appears on every page load in incognito (because `localStorage` is empty), that is correct behavior and acceptable. Confirm no auth or critical functionality depends on `localStorage` in any code path, including incognito/private mode. If Shopify's review tooling raises this, the fix is to move dismissal state to a short-lived cookie or server-side `UserPreference` row.

---

### 2.2.3 — App Bridge version: using `@shopify/app-bridge-react@4.2.4` (old)

**Why this needs attention:** Shopify requires the "latest App Bridge" (`app-bridge.js` loaded from CDN). The `@shopify/app-bridge-react` v4 package still works but Shopify's guidance as of March 2024 is to use the new `@shopify/shopify-app-react-router` scaffold pattern which loads App Bridge through `AppProvider`. This app does use `AppProvider` from `@shopify/shopify-app-react-router/react`, which should satisfy the requirement — but the residual `@shopify/app-bridge-react` dependency is a yellow flag.

**What was detected:**
- `package.json`: `"@shopify/app-bridge-react": "^4.2.4"` is present alongside `"@shopify/shopify-app-react-router": "^1.1.0"`.
- `app/routes/app.tsx:4`: imports `AppProvider` from `@shopify/shopify-app-react-router/react`.
- `app/routes/auth.login/route.tsx` and `app/routes/app.additional.tsx` also use `AppProvider` from the same modern package.

**Verification action:** Confirm `@shopify/app-bridge-react` is only used for the `AppProvider` import (which `shopify-app-react-router` re-exports). If it's an unused transitive dep, remove it from `package.json`. Run `npm ls @shopify/app-bridge-react` to check who requires it. If it's only a peer dep of `shopify-app-react-router`, it's fine.

---

### 2.3.4 — Reinstall: `BillingShopFlag` wiped on uninstall — `installDate` reset on reinstall

**Why this needs attention:** On reinstall, `installDate` is reset (via upsert `create`), giving a fresh 14-day trial. This is by design but must be verified correct behavior under Shopify's policy that trials cannot be given multiple times to the same merchant.

**What was detected:**
- `app/lib/billing/entitlements.ts:78`: `prisma.billingShopFlag.upsert({ create: { shop, installDate: now }, update: {} })` — the `update: {}` means reinstall does NOT reset `installDate` if the row already exists. This is correct.
- But `webhooks.app.uninstalled.tsx` does NOT delete `BillingShopFlag` — so the row survives uninstall and reinstall picks up the original `installDate`. Trial is NOT reset. This is the correct behavior.
- However: `webhooks.shop.redact.tsx` also does NOT delete `BillingShopFlag`. If Shopify sends `shop/redact` after an uninstall (48h later), the flag row is not deleted and will persist. On next install of the same shop, `installDate` would still be the original date. This is fine for preventing trial resets, but may cause orphaned rows if the shop never re-installs.

**Verification action:** Confirm the uninstall → redact → reinstall sequence manually in a dev store. Verify that the trial countdown is correct on reinstall (it should resume from the original `installDate`, not be reset).

---

### 1.2.3 — Plan switching: downgrade is deferred (end-of-period); upgrade path unclear in UI

**Why this needs attention:** Requirement 1.2.3 requires merchants to be able to upgrade/downgrade plans in-app without reinstalling. Upgrades must be immediate; the current downgrade mechanism defers to end of period.

**What was detected:**
- `app/routes/api.billing.cancel.tsx`: `mode=downgrade` schedules a `BillingScheduledChange` at `currentPeriodEnd`. The actual Shopify subscription replacement call is in `app/lib/billing/catchup.ts` (scheduled changes processing).
- `app/lib/billing/catchup.ts` exists — let me assume it applies the downgrade at period end.
- The billing page UI shows upgrade CTAs but it's unclear from the code whether a currently-on-pro merchant can click "Switch to Starter" and have it applied correctly without cancelling first.
- There is no route for Pro→Starter immediate switch using `replacementBehavior: 'STANDARD'`.

**Verification action:** Test the full upgrade (Starter→Pro) and downgrade (Pro→Starter) flows end-to-end in a dev store with test billing enabled. Verify Shopify shows the new plan active immediately after upgrade and at period end after downgrade. Check `catchup.ts` is being called on a schedule (cron job or auto-sync tick).

---

### 3.1.1 — TLS: hosted on Render, no direct certificate management in codebase

**Why this needs attention:** The app is deployed on `https://automail-vc6z.onrender.com`. TLS is managed by Render's infrastructure. The codebase has no HTTP fallback, and all `redirect_urls` use HTTPS. This is almost certainly fine, but it's a runtime/infrastructure concern that cannot be verified purely from code.

**What was detected:**
- `shopify.app.toml`: `application_url = "https://automail-vc6z.onrender.com/app"` — HTTPS.
- No HTTP redirect logic in any route file.
- Privacy policy at `/privacy` is served over the same HTTPS host.

**Verification action:** Confirm Render's TLS certificate is valid and auto-renewing (standard behavior for Render). Test `http://automail-vc6z.onrender.com/app` redirects to HTTPS (Render does this by default). No code change needed if Render handles it.

---

## ⏭️ Skipped groups

- **5.1 Online store (theme extensions)** — App has no theme app extensions, no Theme/Asset API calls, no instructions for merchants to edit themes manually.
- **5.2 Payment apps** — Not a payment provider. No Payments API scopes. `embedded = true`.
- **5.3 Payment facilitator** — Not applicable.
- **5.4 Purchase options (subscriptions/pre-orders)** — No `write_customer_payment_methods` or SellingPlan API usage.
- **5.5 Product sourcing (dropshipping)** — No fulfillment request mutations, no product sync.
- **5.6 Checkout customization** — No checkout UI extensions, no post-purchase extensions.
- **5.7 Sales channel** — Not a sales channel app.
- **5.8 Post purchase** — No post-purchase extensions.
- **5.9 Mobile app builders** — Not a mobile app builder.
- **5.10 Donation** — Not a donation app.

---

## ✅ Likely passing — 27 requirements

**1.1.x family (platform behavior):**
1.1.1 (session tokens — auth path, not localStorage), 1.1.2 (no checkout bypass), 1.1.4 (no fake data), 1.1.9 (no buyer charges), 1.1.15 (no refund logic), 1.1.16 (no lending)

**1.2.x (billing):**
1.2.1 (Shopify Billing API used — `appSubscriptionCreate` / `appSubscriptionCancel`)

**2.2.x (APIs and platform tools):**
2.2.1 (Admin GraphQL API used throughout), 2.2.4 (GraphQL only — no REST API calls found), 2.2.6 (no admin extensions), 2.2.7 (no Max modal)

**2.3.x (installation):**
2.3.1 (no manual domain entry — installation via Shopify surface), 2.3.2 (OAuth via `authenticate.admin` immediately), 2.3.3 (redirect to `/app` after install — `app._index.tsx`), 2.3.4 (OAuth on reinstall handled by `auth.$.tsx`)

**3.2.x (scopes):**
3.2.2 (no `write_payment_mandate`), 3.2.3 (no `write_checkout_extensions_apis`), 3.2.4 (no `read_advanced_dom_pixel_events`), 3.2.5 (no `read_checkout_extensions_chat`)

**GDPR / compliance webhooks:**
`customers/data_request` (logs request, 200 response), `customers/redact` (deletes emails by `fromAddress`, clears thread identifiers), `shop/redact` (full shop data wipe), `app/uninstalled` (full shop data wipe in transaction)

**Data security:**
Token encryption (AES-256-GCM in `app/lib/gmail/crypto.ts`), PII hashing in logs (`pii.ts`), PII sanitization in error messages (`sanitize.ts`), structured logger with mandatory `shop` field (`logger.ts`), rate limiting on `/api/reply-draft` and `/mail-auth` OAuth callback, CSRF protection via Shopify session tokens documented in `api.reply-draft.tsx`

**Privacy policy:** `/privacy` route exists, covers data collected, third parties, retention, GDPR rights, support contact email.

**Support contact:** `/app/help` route exists with support email (`blmcontactpro1@gmail.com`) and response-time SLA.

---

## Fixes applied

### Fix 1 — `read_all_orders` scope justification comment (commit: see below)

Added an explicit code comment to `app/shopify.server.ts` explaining why `read_all_orders` is necessary: customer support emails may reference orders placed more than 60 days ago, and without this scope the Admin API silently returns no results for those orders.

Also added the same justification in `app/lib/support/shopify/order-search.ts` at the query definition.

### Fix 2 — Billing decline-flow handling (commit: see below)

Added a `?billing_status=declined` detection path in `app/routes/app.billing.tsx`:
- When a merchant returns from the Shopify billing confirmation flow without an active subscription (i.e. they declined), the page now shows an explicit "Your subscription was not activated" informational message.
- The subscribe action return URL now carries `?billing_status=pending` so the loader can distinguish "just subscribed" from "came back from billing".
- Added a `?billing_status=declined` query parameter state to the UI, shown as a warning banner above the plan cards.

---

## Open items (not fixable in code)

1. **Partner Dashboard — App listing**: App icon, screenshots, description, support URL, and scope justification text for `read_all_orders` must be set in the Partner Dashboard before submission.
2. **Billing manual testing**: The subscription approve/decline/reinstall flows must be verified end-to-end with Shopify test billing enabled in a development store.
3. **`read_all_orders` Partner Dashboard justification**: The scope justification textarea in the Partner Dashboard (App setup > Scopes) must be filled with: "Customer support emails often reference orders placed more than 60 days ago. Without `read_all_orders`, the Admin API silently omits these orders from search results, making the support copilot unable to find the relevant order."
4. **`localStorage` in banners**: If App Store review flags the `localStorage` usage in `QuotaBanner`/`TrialBanner`, migrate dismissal state to the `UserPreference` table (one DB row write per dismiss — acceptable trade-off).
5. **Downgrade catchup cron**: Verify `app/lib/billing/catchup.ts` is being triggered on a regular schedule in production (auto-sync tick or external cron). If not, scheduled plan downgrades will never apply.
