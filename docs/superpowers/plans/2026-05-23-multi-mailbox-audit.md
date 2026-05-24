# `where: { shop }` audit — multi-mailbox refactor

> Generated: 2026-05-24. Source: grep `where:\s*\{\s*shop` over app/lib + app/routes.
> Total hits: 224 (including tests, scripts, and one-off dev files — 66 production hits in app/lib + app/routes)

Tests (`app/lib/__tests__/`, `tests/e2e/`) and dev scripts (`scripts/`, `test-zoho-api.ts`, `scripts/audit-*.ts`, etc.) are listed in a separate section at the bottom — they are all either test setup teardown (deleteMany) or read-only audit scripts and do **not** need mailboxId filtering.

---

## MAILBOX-SCOPED — needs `mailConnectionId` filter

### `app/lib/gmail/pipeline.ts`

- `:83` `processNewEmails` — `shopFlag.findUnique({ where: { shop } })` — reads `isInternal` flag. This is a ShopFlag lookup, so actually **SHOP-WIDE** (see section below). Misfile corrected there.
- `:91` `processNewEmails` — `mailConnection.update({ where: { shop } })` — clears `lastSyncError`/`syncCancelledAt` at sync start. MAILBOX-SCOPED: should target the specific connection being synced.
- `:100` `processNewEmails` — `mailConnection.update({ where: { shop } })` — writes top-level sync error. MAILBOX-SCOPED: same.
- `:119` `_processNewEmails` — `mailConnection.findFirst({ where: { shop } })` — selects the connection to sync. MAILBOX-SCOPED: pipeline should receive `mailConnectionId` from caller and use `findUnique({ where: { id } })`. Already has `TODO(multi-mailbox)` comment.
- `:174` `_processNewEmails` — `mailConnection.update({ where: { shop } })` — updates `lastSyncAt`/`historyId` when no new messages. MAILBOX-SCOPED: must target the specific connection.
- `:237` `ingestAndPrefilter` — `incomingEmail.upsert({ where: { shop_externalMessageId } })` — compound key already includes shop; functionally scoped. No change needed beyond ensuring `mailConnectionId` is set on the created row (already done via `conn.id`). **SHOP-WIDE intentional** (compound key, not a plain `{ shop }` filter — already correct).
- `:303` `_processNewEmails` — `mailConnection.update({ where: { shop } })` — updates sync cursor post-pass-2. MAILBOX-SCOPED: must target the specific connection.
- `:354` `isCancelled` — `mailConnection.findUnique({ where: { shop } })` — checks `syncCancelledAt`. MAILBOX-SCOPED: should check the specific connection being synced.
- `:418` `ingestAndPrefilter` — `incomingEmail.upsert({ where: { shop_externalMessageId } })` — compound key; see note at :237. **SHOP-WIDE intentional** (compound unique key).
- `:492` `ingestAndPrefilter` — `incomingEmail.findUniqueOrThrow({ where: { shop_externalMessageId } })` — compound key; **SHOP-WIDE intentional**.
- `:505` `ingestAndPrefilter` — `incomingEmail.findUniqueOrThrow({ where: { shop_externalMessageId } })` — compound key; **SHOP-WIDE intentional**.
- `:604` `backfillResolvedIntents` — `thread.findMany({ where: { shop, operationalState: "resolved" } })` — fetches threads for a shop-wide backfill of resolved-intent badges during a sync. MAILBOX-SCOPED: this runs inside a per-connection sync call; threads are tied to the mailbox that received them.
- `:605` `backfillResolvedIntents` — `thread.findMany({ where: { shop, operationalState: "no_reply_needed" } })` — same as above. MAILBOX-SCOPED.
- `:619` `backfillResolvedIntents` — `incomingEmail.findMany({ where: { shop, processingStatus: "outgoing" } })` — scans for old outgoing messages. MAILBOX-SCOPED.
- `:671` `backfillResolvedIntents` — `mailConnection.findUnique({ where: { shop } })` — fetches `email` field for thread-context building. MAILBOX-SCOPED: should use connection id.
- `:778` `backfillResolvedIntents` — `incomingEmail.findFirst({ where: { shop, canonicalThreadId, processingStatus: "outgoing" } })` — anchor strategy fallback. MAILBOX-SCOPED.
- `:927` `pickThreadsForClassification` — `incomingEmail.findMany({ where: { shop, externalMessageId: { in: newMessageIds } } })` — finds which threads were touched. MAILBOX-SCOPED: all these messages came from one mailbox sync.
- `:1465` `reanalyzeEmail` — `mailConnection.findFirst({ where: { shop } })` — selects connection for client. MAILBOX-SCOPED: has `TODO(multi-mailbox)`.

### `app/lib/gmail/diagnose.ts`

- `:31` `runDiagnosis` — `mailConnection.findFirst({ where: { shop } })` — picks any mailbox to run diagnostics against. MAILBOX-SCOPED: should target a specific mailbox (diagnosis is per-mailbox). Has `TODO(multi-mailbox)`.
- `:130` `runDiagnosis` — `incomingEmail.count({ where: { shop, processingStatus: "outgoing" } })` — shop-wide count for diagnostics. MAILBOX-SCOPED: should be scoped to the selected connection's data.
- `:132` `runDiagnosis` — `incomingEmail.count({ where: { shop } })` — total email count. MAILBOX-SCOPED: same.

### `app/lib/mail/backfill.ts`

- `:62` `runOnboardingBackfill` — `mailConnection.findFirst({ where: { shop } })` — selects connection for backfill. MAILBOX-SCOPED: has `TODO(multi-mailbox)`.
- `:76` `runOnboardingBackfill` — `incomingEmail.findMany({ where: { shop, externalMessageId: { in: messageIds } } })` — dedup check. MAILBOX-SCOPED: scoped to messages from this mailbox.
- `:94` `runOnboardingBackfill` — `mailConnection.update({ where: { shop } })` — marks `onboardingBackfillDoneAt`. MAILBOX-SCOPED: must target the specific connection.
- `:111` `runManualBackfill` — `mailConnection.findFirst({ where: { shop } })` — selects connection. MAILBOX-SCOPED: has `TODO(multi-mailbox)`.
- `:117` `runManualBackfill` — `incomingEmail.findMany({ where: { shop, externalMessageId: { in: messageIds } } })` — dedup check. MAILBOX-SCOPED.
- `:153` `runOpportunisticThreadBackfill` — `mailConnection.findFirst({ where: { shop: thread.shop } })` — selects any mailbox for a thread. MAILBOX-SCOPED: thread should carry `mailConnectionId`; use it. Has `TODO(multi-mailbox)`.
- `:257` `ingestHistoricalMessage` — `incomingEmail.findUnique({ where: { shop_externalMessageId } })` — compound key; **SHOP-WIDE intentional** (already correct).

### `app/lib/support/refresh-thread-analysis.ts`

- `:87` `refreshThreadAnalysis` — `mailConnection.findFirst({ where: { shop } })` — selects any mailbox for client construction. MAILBOX-SCOPED: thread carries `mailConnectionId`; use it. Has `TODO(multi-mailbox)`.

### `app/lib/support/inbox-actions.ts`

- `:73` `handleStop` — `mailConnection.update({ where: { shop: params.shop } })` — sets `syncCancelledAt`. MAILBOX-SCOPED: stop should cancel a specific mailbox's sync, not all mailboxes.
- `:91` `handleResync` — `incomingEmail.findMany({ where: { shop, replyDraft: { isNot: null } } })` — finds threads with drafts before delete. MAILBOX-SCOPED: resync should operate on one mailbox.
- `:117` `handleResync` — `incomingEmail.deleteMany({ where: { shop } })` — wipes all emails. MAILBOX-SCOPED: should delete only emails tied to the specific mailbox being resynced.
- `:128` `handleResync` — `mailConnection.update({ where: { shop } })` — resets `historyId`/`deltaToken`/`lastSyncAt`. MAILBOX-SCOPED: must target the specific connection.
- `:141` `handleResync` — `mailConnection.findFirst({ where: { shop } })` — resolves connection id for enqueue. MAILBOX-SCOPED: has `TODO(multi-mailbox)`.
- `:226` `handleBackfill` — `mailConnection.findFirst({ where: { shop } })` — resolves connection id for enqueue. MAILBOX-SCOPED: has `TODO(multi-mailbox)`.
- `:240` `handleToggleAutoSync` — `mailConnection.update({ where: { shop: params.shop } })` — toggles `autoSyncEnabled`. MAILBOX-SCOPED: should toggle for a specific mailbox.
- `:356` `handleRefreshEmailHtml` — `mailConnection.findFirst({ where: { shop } })` — picks any mailbox to re-fetch HTML. MAILBOX-SCOPED: has `TODO(multi-mailbox)`.

### `app/lib/support/prior-contact.ts`

- `:39` `getPriorContact` (or similar) — `incomingEmail.findMany({ where: { shop, processingStatus: "outgoing" } })` — scans all outgoing for all threads. MAILBOX-SCOPED: only outgoing from the relevant mailbox should count. However this feeds the inbox loader and operates across all threads for a shop — **AMBIGUOUS** (see below).

### `app/lib/support/draft-usage-heuristic.ts`

- `:103` `evaluateThread` — `replyDraft.findMany({ where: { shop, email: { canonicalThreadId } } })` — fetches drafts for a specific thread. MAILBOX-SCOPED: thread is tied to a mailbox.
- `:116` `evaluateThread` — `incomingEmail.findMany({ where: { shop, canonicalThreadId, processingStatus: "outgoing" } })` — fetches outgoing emails for heuristic. MAILBOX-SCOPED.

### `app/lib/mail/aliases.ts`

- `:69` `ensureOutgoingAliases` (deprecated) — `mailConnection.findFirst({ where: { shop } })` — picks any mailbox to backfill aliases. MAILBOX-SCOPED: deprecated, but still called; should be migrated to connection-scoped variant. Already has deprecation notice.

### `app/routes/app.inbox.tsx`

- `:103` loader — `incomingEmail.findMany({ where: { shop } })` — loads all emails for the inbox. MAILBOX-SCOPED: in multi-mailbox world, should still load all mailboxes' emails (the inbox shows all mailboxes). **AMBIGUOUS** (see below — the inbox intentionally shows all connected mailboxes; adding a filter here would break that; need a mailbox-filter UI param instead).
- `:187` loader — `thread.findMany({ where: { shop, redactedAt: { not: null } } })` — GDPR tombstones, all mailboxes. **SHOP-WIDE intentional** (tombstones span all mailboxes; GDPR requires full shop scope).

### `app/routes/app.metrics.tsx`

- `:43` loader — `shopFlag.findUnique({ where: { shop } })` — checks `isInternal`. **SHOP-WIDE intentional** (ShopFlag is per-shop).

### `app/routes/api.incoming-attachment.tsx`

- `:112` loader — `mailConnection.findUnique({ where: { shop } })` — fetches Zoho connection to serve attachment. MAILBOX-SCOPED: attachment carries `provider`; should be fetched by connection id, not by shop. (Note: `findUnique({ where: { shop } })` will fail in multi-mailbox since `shop` is no longer unique — this is a **breaking** site.)

### `app/routes/api.repair-zoho-images.tsx`

- `:24` loader — `shopFlag.findUnique({ where: { shop } })` — checks `isInternal` gate. **SHOP-WIDE intentional** (ShopFlag, internal gate).

### `app/routes/api.zoho-inline.tsx`

- `:64` loader — `mailConnection.findUnique({ where: { shop } })` — verifies Zoho account id for inline image proxy. MAILBOX-SCOPED: will break in multi-mailbox (same unique constraint issue as above).

### `app/routes/mail-auth.tsx`

- `:252` action — `mailConnection.findFirst({ where: { shop } })` — finds newly created connection to enqueue initial sync. MAILBOX-SCOPED: has `TODO(multi-mailbox)`; should use the id returned by `saveConnection`.

### `app/lib/support/thread-state.ts`

- `:400` `recomputeAllOpenThreads` — `thread.findMany({ where: { shop, operationalState: "open", operationalStateUpdatedAt: null } })` — paginates open threads to recompute state. **AMBIGUOUS** (see below).

---

## SHOP-WIDE intentional — stays as-is

### `app/lib/billing/entitlements.ts`

- `:79` `resolveEntitlements` — `shopFlag.upsert({ where: { shop } })` — billing/entitlement ShopFlag lookup. Per-shop by design.
- `:98` `resolveEntitlements` — `mailConnection.count({ where: { shop } })` — counts all mailboxes for the shop's mailbox-limit entitlement check. Intentionally across all mailboxes.

### `app/lib/billing/migration.ts`

- `:28` `runMigration` — `shopFlag.findMany({ where: { shop: { in: ... } } })` — one-time migration checking existing ShopFlag rows. Per-shop billing artifact.

### `app/lib/billing/scheduled-changes.ts`

- `:55` `cancelScheduledChange` — `billingScheduledChange.updateMany({ where: { shop } })` — per-shop billing record.
- `:62` `getPendingChange` — `billingScheduledChange.findFirst({ where: { shop } })` — per-shop billing record.

### `app/lib/billing/usage.ts`

- `:33` `getUsage` — `billingUsage.findUnique({ where: { shop_periodStart } })` — per-shop billing counter.
- `:97` `markThreadAnalyzedIfFirst` — `billingUsage.upsert({ where: { shop_periodStart } })` — per-shop billing counter increment.

### `app/lib/dashboard-stats.ts`

- `:322` `_fetchDraftBuckets` — `replyDraft.groupBy({ where: { shop, createdAt: ... } })` — dashboard aggregate across all mailboxes. Shop-wide by design; Task 4.2 will add optional `mailConnectionId` filter param.

### `app/lib/onboarding/repo.ts`

- `:5` `getShopFlag` — `shopFlag.findUnique({ where: { shop } })` — ShopFlag lookup.
- `:16` `ensureShopFlag` — `shopFlag.upsert({ where: { shop } })` — ShopFlag upsert.
- `:28` `markOnboardingComplete` — `shopFlag.upsert({ where: { shop } })` — ShopFlag update.
- `:36` `markOnboardingComplete` — `shopFlag.findUnique({ where: { shop } })` — ShopFlag re-read after update.
- `:42` `markChecklistDismissed` — `shopFlag.upsert({ where: { shop } })` — ShopFlag update.
- `:49` `hasGeneratedAnyDraft` — `replyDraft.count({ where: { shop } })` — onboarding check: "has the merchant generated any draft ever" across all mailboxes. Intentionally shop-wide.
- `:59` `hasCustomizedSupportSettings` — `supportSettings.findUnique({ where: { shop } })` — SupportSettings is per-shop.

### `app/lib/support/settings.ts`

- `:46` `getSettings` — `supportSettings.findUnique({ where: { shop } })` — per-shop settings.
- `:106` `saveSettings` — `supportSettings.upsert({ where: { shop } })` — per-shop settings.

### `app/lib/mail/job-queue.ts`

- `:84` `enqueueJob` — `syncJob.findFirst({ where: { shop, kind, status } })` — dedup check: "is there already a pending/running job of this kind for this shop?" The dedup logic is intentionally shop-and-kind scoped to prevent duplicate jobs of the same type. **AMBIGUOUS** for mailbox-scoped kinds (see below).

### `app/lib/gmail/auth.ts`

- `:101` `saveConnection` — `mailConnection.upsert({ where: { shop_email } })` — upsert by `(shop, email)` compound key. Already correctly scoped.
- `:137` `backfillGmailAliasesIfMissing` — `mailConnection.findUnique({ where: { shop } })` — deprecated single-mailbox alias backfill. MAILBOX-SCOPED: will fail in multi-mailbox (see AMBIGUOUS for notes on legacy callers).
- `:144` `backfillGmailAliasesIfMissing` — `mailConnection.findUnique({ where: { shop } })` — same function, second read. MAILBOX-SCOPED: same.
- `:152` `backfillGmailAliasesIfMissing` — `mailConnection.update({ where: { shop } })` — alias write. MAILBOX-SCOPED.
- `:177` `getConnection` — `mailConnection.findUnique({ where: { shop } })` — legacy single-mailbox getter. MAILBOX-SCOPED: will break in multi-mailbox.
- `:181` `getAuthenticatedClient` — `mailConnection.findUnique({ where: { shop } })` — token refresh. MAILBOX-SCOPED: should use connection id.
- `:198` `getAuthenticatedClient` — `mailConnection.update({ where: { shop } })` — persists refreshed tokens. MAILBOX-SCOPED.
- `:216` `getAuthenticatedClient` — `mailConnection.update({ where: { shop } })` — marks revoked. MAILBOX-SCOPED.

### `app/lib/outlook/auth.ts`

- `:241` `saveConnection` — `mailConnection.upsert({ where: { shop_email } })` — already correct.
- `:279` `backfillOutlookAliasesIfMissing` — `mailConnection.findUnique({ where: { shop } })` — MAILBOX-SCOPED: legacy; will break in multi-mailbox.
- `:323` `backfillOutlookAliasesIfMissing` — `mailConnection.update({ where: { shop } })` — email recovery write. MAILBOX-SCOPED.
- `:336` `backfillOutlookAliasesIfMissing` — `mailConnection.update({ where: { shop } })` — alias write. MAILBOX-SCOPED.
- `:347` `getConnection` — `mailConnection.findUnique({ where: { shop } })` — legacy single-mailbox getter. MAILBOX-SCOPED.
- `:360` `getAuthenticatedClient` — `mailConnection.findUnique({ where: { shop } })` — token refresh. MAILBOX-SCOPED.
- `:376` `getAuthenticatedClient` — `mailConnection.update({ where: { shop } })` — persists refreshed tokens. MAILBOX-SCOPED.

### `app/lib/zoho/auth.ts`

- `:131` `saveConnection` — `mailConnection.upsert({ where: { shop_email } })` — already correct.
- `:182` `backfillZohoAliasesIfMissing` — `mailConnection.findUnique({ where: { shop } })` — MAILBOX-SCOPED: legacy; will break.
- `:192` `backfillZohoAliasesIfMissing` — `mailConnection.update({ where: { shop } })` — alias write. MAILBOX-SCOPED.
- `:202` `refreshZohoToken` — `mailConnection.findUnique({ where: { shop } })` — token refresh. MAILBOX-SCOPED.
- `:229` `refreshZohoToken` — `mailConnection.update({ where: { shop } })` — marks revoked. MAILBOX-SCOPED.
- `:240` `refreshZohoToken` — `mailConnection.update({ where: { shop } })` — persists refreshed token. MAILBOX-SCOPED.
- `:251` `getZohoAccessToken` — `mailConnection.findUnique({ where: { shop } })` — token lookup. MAILBOX-SCOPED.

### `app/lib/zoho/client.ts`

- `:58` `listZohoFoldersRaw` — `mailConnection.findUnique({ where: { shop } })` — fetches Zoho account id. MAILBOX-SCOPED: will break in multi-mailbox.

### `app/lib/mail/auto-sync.ts`

- `:421` auto-sync worker — `mailConnection.findFirst({ where: { shop: job.shop } })` — `recompute` job: picks any mailbox for `mailboxAddress` hint. **SHOP-WIDE intentional**: `recompute` is a shop-wide job; any mailbox email is used only as a hint.
- `:439` auto-sync worker — `mailConnection.findFirst({ where: { shop: job.shop } })` — `reclassify` job: same. **SHOP-WIDE intentional**.
- `:462` auto-sync worker — `mailConnection.findFirst({ where: { shop: job.shop } })` — `analyze_thread` fallback when no `mailConnectionId` on job. MAILBOX-SCOPED: this is a fallback path; ideally `analyze_thread` always carries `mailConnectionId`.

### `app/routes/app.onboarding.tsx`

- `:26` loader — `mailConnection.count({ where: { shop } })` — checks if any mailbox is connected. **SHOP-WIDE intentional**: onboarding is complete if at least one mailbox is connected.

### `app/routes/webhooks.app.uninstalled.tsx`

- `:13–31` all entries — cascade-delete all shop data on uninstall. **SHOP-WIDE intentional**: GDPR/uninstall must wipe everything.

### `app/routes/webhooks.customers.data_request.tsx`

- `:128` — `llmCallLog.findMany({ where: { shop, emailId: { in: emailIds } } })` — GDPR data request. **SHOP-WIDE intentional**.

### `app/routes/webhooks.customers.redact.tsx`

- `:64` — `thread.findMany({ where: { shop, resolvedEmail } })` — GDPR redact. **SHOP-WIDE intentional**.
- `:86` — `incomingEmail.findMany({ where: { shop, canonicalThreadId: { in: threadIds } } })` — GDPR redact. **SHOP-WIDE intentional**.
- `:130` — `incomingEmail.deleteMany({ where: { shop, id: { in: emailIds } } })` — GDPR redact. **SHOP-WIDE intentional**.
- `:138` — `thread.updateMany({ where: { shop, id: { in: threadIds } } })` — GDPR tombstone. **SHOP-WIDE intentional**.

### `app/routes/webhooks.shop.redact.tsx`

- `:69–84` all entries — GDPR shop redact: delete all data for the shop. **SHOP-WIDE intentional**.

---

## AMBIGUOUS — needs human review

### `app/lib/support/prior-contact.ts:39` — `getPriorContactBatch`

`incomingEmail.findMany({ where: { shop, processingStatus: "outgoing" } })` — fetches **all** outgoing emails for the shop to detect whether the merchant has replied to a customer's thread. This feeds the inbox loader's "prior contact" badge. In multi-mailbox, a shop may have multiple mailboxes, each with their own outgoing emails. The badge makes sense across all mailboxes (the merchant replied from any box). **Recommend: keep SHOP-WIDE**, but verify that outgoing detection is correct per-connection (outgoing is determined by `outgoingAliases`, which is per-connection).

### `app/routes/app.inbox.tsx:103` — inbox loader

`incomingEmail.findMany({ where: { shop } })` — loads the full inbox across all mailboxes. The intention for multi-mailbox is to show all mailboxes in one unified inbox view (with a mailbox filter dropdown as a future UI affordance). **Recommend: SHOP-WIDE intentional for now** — but this site is where an optional `mailConnectionId` filter will eventually be added when the UI dropdown lands. Tag it for Task 4.3.

### `app/lib/mail/job-queue.ts:84` — `enqueueJob` dedup check

`syncJob.findFirst({ where: { shop, kind, status } })` — prevents duplicate jobs of the same kind for a shop. For mailbox-scoped kinds (`sync`, `backfill`, `resync`, `analyze_thread`), this dedup check does NOT include `mailConnectionId`, so enqueueing a `sync` for mailbox-B while mailbox-A already has a pending `sync` would be silently deduplicated. **Recommend: add `mailConnectionId` to the dedup `where` clause for MAILBOX_SCOPED_KINDS.** This is a latent bug in multi-mailbox, not currently triggered.

### `app/lib/support/thread-state.ts:400` — `recomputeAllOpenThreads`

`thread.findMany({ where: { shop, operationalState: "open", operationalStateUpdatedAt: null } })` — walks all open threads for a shop to backfill `operationalStateUpdatedAt`. This is invoked by the `recompute` job (shop-wide). **Recommend: SHOP-WIDE intentional** — `recompute` is designed to sweep all threads for a shop.

### `app/lib/gmail/auth.ts:137–216` / `app/lib/outlook/auth.ts:279–376` / `app/lib/zoho/auth.ts:182–251` — legacy `findUnique({ where: { shop } })` in auth modules

These use `mailConnection.findUnique({ where: { shop } })` which will **throw a Prisma error** once a shop has more than one mailbox (unique constraint on `shop` no longer exists in the multi-mailbox schema). Each of these functions (`backfillGmailAliasesIfMissing`, `backfillOutlookAliasesIfMissing`, `backfillZohoAliasesIfMissing`, `getConnection`, `getAuthenticatedClient`, `refreshZohoToken`, `getZohoAccessToken`) need to receive a `mailConnectionId` (or the full `MailConnection` object) from their callers instead of doing a shop-scoped lookup. These are all MAILBOX-SCOPED; listed under SHOP-WIDE-that-needs-migration above. **High priority for Task 4.6.**

---

## Summary

- **MAILBOX-SCOPED**: 51 entries across 12 files
- **SHOP-WIDE intentional**: 45 entries across 13 files
- **AMBIGUOUS**: 5 entries across 4 files (prior-contact, inbox loader, job-queue dedup, thread-state recompute, auth legacy finders — last item is a MAILBOX-SCOPED breaking change listed in AMBIGUOUS for tracking)

> Note: compound-key sites (`where: { shop_externalMessageId }`, `where: { shop_email }`, `where: { shop_periodStart }`) are NOT counted as plain `where: { shop }` sites — they already encode additional scoping and are not breaking in multi-mailbox.

---

## Resolution status

- [x] Task 4.2 — dashboard-stats.ts (SHOP-WIDE entries that need optional mailbox filter param) ✅ 818a493
- [x] Task 4.3 — inbox loader (`app/routes/app.inbox.tsx:103`) — AMBIGUOUS → add optional mailbox filter ✅ 2753793
- [x] Task 4.4 — `handleResync` (`app/lib/support/inbox-actions.ts:91,117,128,141`) — MAILBOX-SCOPED ✅ 58adc01
- [x] Task 4.5 — `handleSync` / `handleBackfill` / `handleToggleAutoSync` (`app/lib/support/inbox-actions.ts:226,240`) — MAILBOX-SCOPED ✅ 23c8576
- [x] Task 4.6 — remaining MAILBOX-SCOPED entries: auth modules (gmail/outlook/zoho), zoho/client.ts, gmail/client.ts, aliases.ts, diagnose.ts, api.incoming-attachment.tsx, api.zoho-inline.tsx, mail-auth.tsx, job-queue.ts dedup, inbox-actions handleStop + handleRefreshEmailHtml, backfill.ts, auto-sync.ts, refresh-thread-analysis.ts, gmail/pipeline.ts ✅ 2910279 d52b347 391e6fc e613bdb
- [ ] Task 4.7 — verification
