# Handoff — Public Draft conversion & App Store submission

**Status as of 2026-05-09** : Phases 1-5 complete. App still in Custom distribution mode. Everything that could be done while remaining Custom has been done. The remaining work all requires the user to first **convert the app from Custom to Public Draft** in the Shopify Partner Dashboard. This handoff describes the steps for a future session.

---

## Where the work left off

### Code state

- Branch: `audit/pass-2-findings`
- Latest commit: `b874379` (docs listing) or later
- All Phases 1-5 implemented and committed
- 78 billing tests passing (35 unit + 43 integration)
- All UI polished (billing page, banners, top bar counter, modals)
- Vouvoiement strict in all FR strings

### Validated via Playwright (real boutique AMBIENT HOME)

- ✅ Trial active : bandeau bleu, top bar counter
- ✅ Trial expired : bandeau rouge non-dismissible, modal quota au clic Generate, sync suspended banner
- ✅ Internal mode : tout débloqué (Pro equivalent, dashboard avancé, badge "Plan actuel")
- ✅ Vouvoiement strict
- ✅ Navigation Link vers /app/billing dans iframe embedded

### NOT validated live (impossible on Custom app)

- ❌ `appSubscriptionCreate` flow — Custom apps blocked by Shopify
- ❌ State `paid_active starter / pro` — depends on Shopify subscription
- ❌ Counter colors at thresholds (warning 80% / critical 95% / exceeded 100% on real paid plan)
- ❌ Mailbox limit "Plan Starter limité à 1 boîte"
- ❌ Dashboard Starter clamp à 7j + placeholders "Available on Pro"
- ❌ Upgrade Starter → Pro avec prorata
- ❌ Downgrade scheduled flow
- ❌ Cancel subscription / cancel scheduled
- ❌ Decline flow (returnUrl avec billing_status=pending → bandeau rouge "Subscription declined")

These all rely on the Billing API which Shopify blocks for Custom apps with the error `"Custom apps cannot use the Billing API"`.

---

## Step-by-step workflow for the future agent

### Step 0 — User actions in Partner Dashboard (manual)

Before any code work, the **user** must do this in https://partners.shopify.com :

1. Navigate to Apps → automail → **Distribution → Manage distribution**
2. Choose **Public distribution**
3. Choose **"Don't list on Shopify App Store"** if they want to stay unlisted (recommended for soft launch). They can switch to Listed later.
4. Fill out the minimum required fields to enter Draft state :
   - App icon (1200×1200 PNG, no transparency)
   - Tagline, short description, long description (drafts available in [docs/listing-content.md](../listing-content.md))
   - Support email (real address — replace `support@automail.app` placeholder)
   - Privacy policy URL : `https://automail-vc6z.onrender.com/privacy`
   - Categories : Customer service, Productivity, Operations
   - Scope justifications (paste from [docs/listing-content.md](../listing-content.md) `Scope justifications` section)
5. **Do NOT click Submit for review yet**. App stays in Draft state.

The `client_id` does not change during this conversion — the existing AMBIENT HOME install continues working.

### Step 1 — Live test the Billing API on a development store

Once in Draft, the Billing API works with `test: true`. Recommended : create a fresh dev store dedicated to testing.

1. Partner Dashboard → Stores → **Add store → Development store**
2. Install Automail on the new dev store via the install link (Partner Dashboard → automail → Test on store)
3. Run the test sequence below

**Test sequence (priority order)** :

1. **Subscribe Starter** : `/app/billing` → click "S'abonner" Starter → Shopify confirmation page (marquée TEST) → Approve → return to app. Verify :
   - Bandeau vert "Subscription confirmed"
   - State passes to `paid_active`, plan `starter`
   - Counter shows `0 / 50 drafts`
   - Trial banner gone

2. **Generate a draft** in inbox → counter goes to `1 / 50`. Repeat 3-4 times.

3. **Hit warning level** : update DB directly to set `draftsCount = 40` (= 80% of 50). Reload. Counter pastille jaune, banner "You've used 40 of your 50 drafts" appears with dismiss × button.

4. **Hit critical level** : `draftsCount = 48`. Counter pastille orange, banner "Almost out of quota".

5. **Hit exceeded** : `draftsCount = 50`. Counter pastille rouge, banner non-dismissible "Quota reached — sync paused. Upgrade to continue.", sync suspended banner appears in inbox.

6. **Try to Generate** while exceeded → modal quota appears with "Upgrade" + "Later" CTAs.

7. **Reset** : `draftsCount = 0`. All banners gone, counter green.

8. **Upgrade Starter → Pro** via billing page → click "S'abonner" Pro → Shopify TEST confirmation → approve → return. Verify counter limit jumps to `0 / 500`, dashboard advanced sections (heatmap, alerts, reopened) become visible.

9. **Schedule Pro → Starter downgrade** → click "Passer à ce plan" Starter → bandeau jaune "Plan Pro actif jusqu'au ..." with "Annuler ce changement" button. Verify the row in `BillingScheduledChange` table.

10. **Cancel scheduled change** → click "Annuler ce changement" → page reloads, bandeau gone, no row in DB (cancelledAt set).

11. **Cancel subscription immediately** → "Annuler l'abonnement" link at bottom → confirms → state goes back to `trial_expired` (since trial already consumed) → bandeau rouge.

12. **Decline flow** : start a subscribe → on Shopify confirmation page click DECLINE / X → return to app with `?billing_status=pending` → bandeau rouge "Subscription declined" via the loader detection logic.

13. **Mailbox limit** : on Starter (limit=1), with 1 mailbox already connected, try to connect a 2nd via OAuth → blocked at `mail-auth.tsx` callback with friendly error page.

14. **Dashboard clamp** : on Starter, navigate to `/app/dashboard?range=90d` → URL or backend clamps to 7d, advanced sections show "Available on Pro" placeholder.

For each failure, fix code → push → re-test. Don't proceed to Step 2 until all 14 items pass.

### Step 2 — Take production screenshots

Once everything works on the dev store with seeded realistic data (a few orders, a few support emails), take screenshots :

1. **Inbox view** — main page with tabs and threads with intent badges
2. **Thread detail** — one thread expanded with order context + draft + tracking
3. **Dashboard Pro** — KPIs + heatmap + top intents
4. **Billing page** — Starter/Pro cards with one marked "Plan actuel"
5. **Settings** — personalization page

Specs : 1280×800 minimum, ideally 2560×1600 retina, light mode. Multiple viewport sizes welcome.

Upload to Partner Dashboard → automail → Listing → Screenshots.

### Step 3 — Final pre-submission checklist

- [ ] All 14 Step 1 tests pass
- [ ] Screenshots uploaded
- [ ] App icon uploaded
- [ ] Tagline / descriptions filled (paste from `docs/listing-content.md`)
- [ ] Support email is REAL (not the placeholder)
- [ ] Privacy policy URL works (`/privacy` route)
- [ ] Scope justifications pasted in App Setup → Scopes
- [ ] Re-run AI self-review : `/shopify-app-store-review` → 0 ❌ failing
- [ ] Compliance webhooks responding 200 (test by hitting them via curl with valid HMAC)
- [ ] App icon present in `shopify.app.toml` references? (verify config matches)
- [ ] All `test: true` flags in code only fire when `NODE_ENV !== 'production'` — verify there's no leaked test charge in prod

### Step 4 — Submit for review

Partner Dashboard → automail → click **Submit for review**.

Review process :
- App goes to Submitted status
- Shopify reviewer is assigned within ~3 business days
- They install on their test store, exercise the billing flow, check compliance
- 1-3 weeks for review depending on queue
- Possible outcomes :
  - **Approved** → Published (unlisted or listed depending on initial choice)
  - **Paused** → core requirements not met, fix and resubmit
  - **Reviewed** → minor fixes needed via discussion with reviewer

Common rejection reasons to anticipate (from Shopify docs `Common review problems`) :
- Billing flow doesn't work end-to-end
- Scopes requested without clear justification
- Privacy policy URL broken or doesn't reflect actual data handling
- App crashes on install or first load
- Compliance webhooks return non-200 status

---

## Reference documents

- **Spec** : [docs/superpowers/specs/2026-05-08-paid-plans-design.md](specs/2026-05-08-paid-plans-design.md) — full product + technical design
- **Phase plans** :
  - [Phase 1 — foundations](plans/2026-05-08-paid-plans-phase-1-foundations.md)
  - [Phase 2 — billing UI](plans/2026-05-08-paid-plans-phase-2-billing-ui.md)
  - [Phase 3 — enforcement](plans/2026-05-08-paid-plans-phase-3-enforcement.md)
  - [Phase 4 — catch-up](plans/2026-05-09-paid-plans-phase-4-catchup.md)
  - [Phase 5 — pre-launch](plans/2026-05-09-paid-plans-phase-5-pre-launch.md)
- **Compliance review** : [docs/compliance-self-review-2026-05-09.md](../compliance-self-review-2026-05-09.md) — 5 needs-review items to verify
- **Listing copy** : [docs/listing-content.md](../listing-content.md) — paste targets for Partner Dashboard
- **Backlog one-time packs** : memory file `backlog_one_time_packs.md` — feature deferred until post-launch

---

## Gotchas & notes for the future agent

1. **Custom-to-Public conversion is NOT a review** — it's just a distribution mode change. The user can revert if needed (though they probably won't).

2. **The `client_id` stays the same** during conversion — existing installs (AMBIENT HOME) keep working without re-install.

3. **`test: true` flag** is currently set automatically when `NODE_ENV !== 'production'` in [api.billing.subscribe.tsx](../../app/routes/api.billing.subscribe.tsx). Verify this code path before going to production. The flag MUST be `false` in prod or no merchant gets actually charged.

4. **`read_all_orders` scope** : Shopify scrutinizes this scope (orders >60 days old). The justification is in `docs/listing-content.md` and inline in `app/shopify.server.ts` and `app/lib/support/shopify/order-search.ts`. The user must ALSO paste it into Partner Dashboard scope justification text area.

5. **Backfill at boot** : `app/entry.server.tsx` calls `backfillBillingShopFlags()` fire-and-forget. This creates `BillingShopFlag` rows for legacy shops at every server start. Idempotent and safe.

6. **5 needs-review items** from the self-review (in `docs/compliance-self-review-2026-05-09.md`) :
   - Verify webhook authentication doesn't leak
   - Verify cron-based scheduled-change application is wired up in production (otherwise downgrades silently never apply)
   - Verify `localStorage` usage in dismiss banners is acceptable to reviewers (it's for UI state, not auth)
   - Verify token encryption at rest for Gmail/Outlook/Zoho refresh tokens
   - Verify OAuth state validation on all callback routes

7. **Memory file** `backlog_one_time_packs.md` documents the design for post-launch enhancement (purchase one-time draft packs). Do NOT build before having usage data.

8. **Vouvoiement** : strict rule. Any new FR string MUST use vouvoiement (vous/votre). No tu/te/ton/tes/toi.

9. **Multi-tenant scoping** : every shop-scoped query must filter by `shop`. Several queries we added respect this; verify any new query does too.

10. **Catchup cron** : `BillingScheduledChange` rows have `effectiveAt`. To actually apply downgrades, something must call `listDueChanges(now)` periodically. We use `app/entry.server.tsx` boot hooks for one-shot tasks. For scheduled work, verify there's a periodic cron (or add one) that runs `applyDuePlanChanges()` daily.

---

## Recommended approach for the future agent

When picking this up :

1. **Read this entire handoff first** — do not jump to action.
2. **Check git log** since `b874379` to see if anything has been added since.
3. **Run all tests** : `npm test && npm run test:integration` — must be 100% green before any new work.
4. **Check the AMBIENT HOME shop state** : `BillingShopFlag` row should exist with `installDate` not too old, `isInternal=false` for prod use.
5. **Then start Step 0** above (Partner Dashboard conversion — guide the user through it).

If anything in this handoff is out of date, update this file before proceeding.
