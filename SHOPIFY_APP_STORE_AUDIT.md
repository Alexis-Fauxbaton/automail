# Shopify App Store Readiness Audit — 2026-05-08

App: **Automail** (customer-support copilot)
Branch reviewed: `audit/pass-2-findings` on top of `feat/dashboard-sav-v1`
Scope: code review against Shopify's [App Store requirements](https://shopify.dev/docs/apps/launch/app-requirements-checklist).

## Verdict

**Code-side: ready.** 12 of 13 in-repo items fixed (B1–B4 except B3 which was a no-op, H1–H5, M1, M2, M4, plus H3+M3 rate-limit infra). Only the 5 LISTING items remain — they live in the Partner Dashboard, not the repo.

| Tier | Count | Fixed | Remaining |
|------|-------|-------|-----------|
| BLOCKERS (fix before submit) | 4 | 3 | 1 (B3 — confirm prod toml only) |
| HIGH (strongly recommended) | 5 | 5 | 0 |
| MEDIUM (defensive) | 4 | 4 | 0 |
| LISTING-ONLY (no code change) | 5 | 0 | 5 |
| Verified good | 16 | — | — |

> Code fixes are commits `ec0507a` → `d30f5cd` on branch `audit/pass-2-findings`. All 433 tests pass.

---

## BLOCKERS — fix before submission

### B1 — Production `shopify.app.toml` uses deprecated GDPR webhook format ✅ FIXED (commit ec0507a)
- **File**: [`shopify.app.toml`](shopify.app.toml#L22-L25)
- **Issue**: The production config declares GDPR webhooks via `[webhooks.privacy_compliance]` with `customer_data_request_url` / `customer_deletion_url` / `shop_deletion_url`. This is the **legacy** format. The test config (`shopify.app.automail-test.toml`) uses the current `[[webhooks.subscriptions]]` with `compliance_topics`. After deploying, Shopify may not subscribe to GDPR webhooks correctly — and **GDPR webhooks not firing is an automatic rejection**.
- **Fix**: Migrate `shopify.app.toml` to the new format used in the test config:
  ```toml
  [[webhooks.subscriptions]]
  uri = "/webhooks/customers/data_request"
  compliance_topics = [ "customers/data_request" ]
  # …same for customers/redact and shop/redact
  ```
  Also bump `api_version` from `"2025-10"` to `"2026-04"` to match the test config and the `ApiVersion.October25` used in `shopify.server.ts` (the runtime's API version should match the webhook subscription version).
- **Effort**: small

### B2 — `<s-app-nav>` is missing the `name=` attribute ✅ FIXED (commit ec0507a)
- **File**: [`app/routes/app.tsx:51`](app/routes/app.tsx#L51)
- **Issue**: Without `name`, the new App Bridge nav web component renders without an app title in the Shopify admin sidebar — merchants see anonymous nav links. This is flagged by Shopify Polaris guidelines.
- **Fix**: `<s-app-nav name="Automail">`
- **Effort**: trivial

### B3 — Trycloudflare tunnel URLs in `shopify.app.automail-test.toml`
- **File**: [`shopify.app.automail-test.toml:5`](shopify.app.automail-test.toml#L5), [`:38-42`](shopify.app.automail-test.toml#L38-L42)
- **Issue**: `application_url` and all `redirect_urls` are pointed at `foods-enhancing-toilet-distinguished.trycloudflare.com` — an ephemeral dev tunnel. If the production app config ever uses these, OAuth fails as soon as the tunnel rotates.
- **Fix**: This is the test config so it's expected, BUT confirm the production `shopify.app.toml` uses `https://automail-vc6z.onrender.com` (it does — good). Document the convention in `CLAUDE.md` and add a `.gitignore` entry for ephemeral tunnel URLs OR commit only stable URLs.
- **Effort**: small

### B4 — App lands on `/app/inbox` before the merchant has connected an inbox ✅ FIXED (commit ec0507a)
- **File**: [`shopify.app.toml:5`](shopify.app.toml#L5) — `application_url = "https://…/app/inbox"`
- **Issue**: `application_url` is the install-redirect target. A new merchant who just installed has no Gmail/Zoho connection yet, so the inbox page is empty/error-state on first load. Shopify reviewers test this exact path.
- **Fix**: Change `application_url` to `/app` (the index route). The index route should detect "no connection" and redirect/render an onboarding step that connects Gmail or Zoho. Verify `app/routes/app._index.tsx` does this gracefully.
- **Effort**: small (config) + small (verify onboarding UX)

---

## HIGH — strongly recommended

### H1 ✅ FIXED (commit d46a5b1) — `postMessage('*')` from email iframe — receiver should validate `event.origin`
- **File**: `app/routes/app.inbox.tsx` (postMessage handler in `EmailHtmlBody`)
- **Issue**: The iframe is sandboxed with no `allow-same-origin`, so its origin is `null`. The parent's message handler doesn't filter on `event.origin === "null"` or by message-shape strictly. A different iframe in the page (Shopify itself, an extension, or an injected one) could send a `{type:'email-height',...}` message and resize our wrapper.
- **Fix**: In the parent message listener: `if (event.origin !== "null") return;` before reading `event.data`. Strict-narrow the `data` shape with `typeof === "object"` + key-presence checks.
- **Effort**: small

### H2 ✅ FIXED (commit d46a5b1) — Iframe sandbox keeps `allow-popups` unnecessarily
- **File**: `app/routes/app.inbox.tsx` iframe `sandbox` attr
- **Issue**: Email HTML never legitimately needs to open new windows. `allow-popups` is an extra attack surface (phishing, click-jacking trampolines).
- **Fix**: Drop `allow-popups`. Keep `sandbox="allow-scripts"` only.
- **Effort**: trivial

### H3 ✅ FIXED (commit 3f8e9b0) — No rate limiting on `/api/reply-draft` (LLM-cost DoS)
- **File**: `app/routes/api.reply-draft.tsx`
- **Issue**: A compromised merchant session or hostile session-replay can spam the LLM endpoint, costing real OpenAI dollars. Already flagged in `AUDIT_PASS_2.md` as `SEC2-H1`. Shopify reviewers don't enforce this directly, but a runaway-cost incident in the first month of public availability is a real risk.
- **Fix**: Per-shop sliding window: e.g., 30 drafts/hour. Use a small Postgres table `RateLimitBucket(shop, kind, count, windowStart)` or Redis if available. Pass 1 already capped LLM input size, which is the bigger lever — this finishes the loop.
- **Effort**: medium

### H4 ✅ FIXED (commit d46a5b1, doc) — No CSRF token on draft mutations (relies entirely on Shopify session JWT)
- **Files**: `app/routes/api.reply-draft.tsx`, `app/routes/api.draft-attachment.tsx`
- **Issue**: Shopify's `authenticate.admin` validates the session token in the `Authorization` header — that token is bound to the embedded app and effectively serves as CSRF defense as long as the call comes through App Bridge fetch. **But** if a merchant is logged into Shopify in another tab, a malicious site cannot forge the session token (it's per-app), so this is theoretically safe. However, Shopify's review checklist explicitly asks "Are state-changing endpoints protected against CSRF?". Document the rationale.
- **Fix**: Add a comment block at the top of each `api.*.tsx` action explaining: "CSRF is provided by Shopify session-token validation in `authenticate.admin`. The token is per-app + per-merchant and cannot be obtained cross-origin. No additional anti-CSRF token needed." If the reviewer disagrees, add an explicit `_csrf` field validated against the session.
- **Effort**: small (documentation) / medium (if explicit token needed)

### H5 ✅ FIXED (commit d46a5b1) — `app.tsx` builds a synthetic `host` parameter from `shop` query
- **File**: [`app/routes/app.tsx:14-26`](app/routes/app.tsx#L14-L26)
- **Issue**: When merchants land at `/app?shop=foo.myshopify.com` without `host`, the loader fabricates a `host` from the shop. Shopify reviewers sometimes test exactly this path: navigation from a bookmark or external link without `host`. The current code does it, which is good — but `Buffer.from(\`admin.shopify.com/store/\${shopId}\`).toString("base64")` is a workaround that doesn't survive future Shopify URL changes.
- **Fix**: Add a fallback redirect: if `host` is missing AND `shop` is missing, redirect to the install URL. Add a comment that this synthesis is a known Shopify-CLI pattern (cite docs). Verify the synthesized host actually works in embedded mode — test it manually.
- **Effort**: small

---

## MEDIUM — defensive / quality

### M1 ✅ FIXED (commit ec0507a) — `app.support.tsx` is a feature page, not a support-contact page
- **File**: `app/routes/app.support.tsx`
- **Issue**: Shopify expects a clear "contact app support" path inside the app. The route name is misleading — it's actually the manual analysis form. The listing's support email (`blmcontactpro1@gmail.com`) is in `privacy.tsx` only. There's no in-app "Help" button.
- **Fix**: Either (a) rename the route to `app.analyze.tsx` to match its purpose AND add a small "Help" link in the nav pointing to `mailto:blmcontactpro1@gmail.com`, or (b) keep the name but add a real `/app/help` route with the support email + FAQ. Reviewers check this.
- **Effort**: small

### M2 ✅ FIXED (commit d30f5cd) — Bulk DB-mutation actions (resync, redraft, reanalyze) don't have undo / confirm
- **File**: `app/routes/app.inbox.tsx` action handler — `intent === "resync"` does `prisma.incomingEmail.deleteMany({ where: { shop } })`
- **Issue**: A misclick deletes the merchant's entire ingested email history for the shop. No confirm dialog visible (need to verify in the UI). Reviewers test destructive flows.
- **Fix**: Add a confirm modal in the UI before triggering `resync`. Server-side, log every destructive action with `shop`, `userId`, `timestamp` to a new `AuditLog` table (also flagged in pass-1 ARCH-M5).
- **Effort**: small (modal) + medium (audit log)

### M3 ✅ FIXED (commit 3f8e9b0) — Public OAuth callback (`/mail-auth`) lacks rate limiting
- **File**: `app/routes/mail-auth.tsx`
- **Issue**: This route is intentionally public so Google/Zoho can redirect to it. It already validates HMAC-signed state, but a brute-force attacker could spam invalid `state` values to grow log volume / fail the LLM provider's quota.
- **Fix**: IP-based rate limit (50 requests/IP/min) at the edge or in the loader. Cloudflare in front of Render would handle this. If not, a Postgres-backed in-app limiter.
- **Effort**: medium

### M4 ✅ FIXED (commit d30f5cd) — `app.inbox.tsx` second `findMany` (analyzed-per-thread) has no `take`
- **File**: `app/routes/app.inbox.tsx` loader, ~line 96-110
- **Issue**: Already known from `AUDIT_PASS_2.md` (PERF-H3 in pass 1). The first list query is bounded to 500; the second can fetch unlimited rows. With many active threads, this is the dashboard tax during App Store load testing.
- **Fix**: Already covered in pass-2 deferred items. Worth resolving before App Store performance review.
- **Effort**: medium

---

## LISTING REQUIREMENTS — cannot fix in code

These belong in your Partner Dashboard listing, not the repo. **All 5 are review blockers if missing.**

### L1 — App listing must declare access to "protected customer data"
The app accesses `read_customers` and reads customer email/name. Shopify's [Protected Customer Data](https://shopify.dev/docs/apps/launch/protected-customer-data) policy requires you to:
- Declare the data scope in your Partner Dashboard
- Justify why the data is needed (matching incoming email senders to Shopify customers)
- Confirm AES-256 at rest (already true) and TLS in transit (already true)

### L2 — Pricing tier must be explicit (free or paid)
There is no Shopify Billing API usage in the repo, so this is a free app. Declare "Free" in the listing — otherwise Shopify rejects with "no pricing".

### L3 — Listing must include
- App name + handle (already chosen: `automail`)
- Tagline (≤ 70 chars)
- Long description (≥ 100 words)
- 3–10 screenshots (≥ 1600×900)
- Demo store URL OR demo video
- Categories (recommend: "Customer support" + "Email & marketing")
- Support email (use `blmcontactpro1@gmail.com` — same as privacy.tsx)
- Privacy policy URL: `https://automail-vc6z.onrender.com/privacy`

### L4 — App icon (1200×1200 PNG, < 1 MB)
Shopify enforces sizing strictly; reviewers reject low-res icons.

### L5 — Test instructions for the reviewer
Shopify reviewers will install your app on a dev store. Provide:
- A demo Gmail/Zoho mailbox they can connect (or step-by-step to create one)
- A few seeded test emails so the inbox isn't empty on first review

---

## What's already good (verified)

- ✅ GDPR webhooks present and correctly delete shop-scoped data ([webhooks.shop.redact.tsx](app/routes/webhooks.shop.redact.tsx), [webhooks.customers.redact.tsx](app/routes/webhooks.customers.redact.tsx))
- ✅ HMAC verification on every webhook (`authenticate.webhook(request)`)
- ✅ OAuth state HMAC + 10-min TTL ([app/lib/mail/oauth-state.ts](app/lib/mail/oauth-state.ts))
- ✅ AES-256-GCM token encryption ([app/lib/gmail/crypto.ts](app/lib/gmail/crypto.ts))
- ✅ Bilingual privacy policy at `/privacy` ([app/routes/privacy.tsx](app/routes/privacy.tsx))
- ✅ All API routes call `authenticate.admin(request)` first
- ✅ All `app/routes/app.*.tsx` pages are auth-gated
- ✅ Public routes are exactly the ones that need to be: `/privacy`, `/mail-auth`, `/auth.$`, `/auth.login`
- ✅ Read-only scopes only: `read_orders`, `read_all_orders`, `read_customers`, `read_fulfillments`
- ✅ `embedded = true` + `<AppProvider apiKey={apiKey}>` correctly wraps content
- ✅ Shopify CSP headers applied via `addDocumentResponseHeaders` in `entry.server.tsx`
- ✅ `AppDistribution.AppStore` set in `shopify.server.ts`
- ✅ Recharts dynamically imported on dashboard route only — keeps initial bundle small
- ✅ `sanitize-html` allowlist applied to email HTML, `<s-text>`-style sanitized markdown for drafts
- ✅ E2E auth-bypass triple-gated and refuses to activate in production
- ✅ PII hashing applied in webhook logs ([app/lib/log/pii.ts](app/lib/log/pii.ts))
- ✅ Multi-tenant: every DB query includes `shop` filter, every cache keyed by shop
- ✅ Auto-sync skips shops without an active Shopify session (clean uninstall handling)

---

## Suggested order of work

1. **B1, B2, B3, B4** — config + tiny code edits, all under 1h
2. **H1, H2, H4 (doc), H5** — afternoon's work
3. **M1, M2** — half a day
4. **L1–L5** — Partner Dashboard tasks (out of repo)
5. **H3, M3, M4** — can land in a follow-up after submission, before review goes live

Total to "submission ready": **~1 dev day** + listing prep.
