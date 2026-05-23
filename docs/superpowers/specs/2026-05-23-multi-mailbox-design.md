# Multi-mailbox per shop — design

Date: 2026-05-23
Status: design approved, ready for implementation plan
Spec authors: Alexis Fauxbaton + Claude

## Context

Today the app is single-mailbox per shop. `MailConnection.shop` is `@id`, so the schema enforces exactly one connection per shop. The Pro plan advertises `maxMailboxes: 3` in `app/lib/billing/plans.ts`, but the schema and the rest of the codebase make this impossible — a Pro merchant who tries to connect a second mailbox hits the `mailboxLimit` error page even though their plan promises 3.

This spec covers the feature that delivers what Pro promises: multiple mail connections per shop, accessible across all three providers (Gmail, Outlook, Zoho), with a unified inbox experience.

## Goals

- Pro plan delivers its promise: up to 3 connected mailboxes per shop.
- Trial (= pseudo-Pro) also allows 3 mailboxes so prospects can evaluate the feature.
- A single inbox UI shows threads from all mailboxes, with badges identifying each.
- A dedicated `/app/connections` page manages connections (add, disconnect, pause, re-auth).
- Downgrade to a lower-limit plan is handled gracefully without silent data loss.
- The fix for `[ARCH-C2]` (orphan Thread rows after disconnect/resync) is delivered as part of this work via `onDelete: Cascade`.

## Non-goals (out of scope for v1)

- Cross-mailbox thread unification (a single customer writing to support@ AND returns@ gets two threads, not one merged thread).
- Side-by-side dashboard comparisons (support@ vs returns@ KPI charts).
- Per-mailbox `autoSyncIntervalMinutes` UI configuration (column exists in DB, not surfaced).
- Mailbox rename / custom labels (display the email address as-is).
- Per-mailbox technical diagnostics in the merchant UI (breaker state, semaphore depth, etc. stay in internal `/app/metrics`).
- A persistent global mailbox filter shared across inbox + dashboard pages (filters stay independent per page).
- Tiered pricing per additional mailbox (limit is a fixed integer per plan).
- Parallel per-mailbox sync by default (stays one job per shop, with env var escape hatch).

## Use cases that drive the design

Confirmed with the user during brainstorming:

1. **Multi-département** — one brand, multiple functional addresses (support@, returns@, shipping@). Threads often relate to the same customer and the same Shopify orders.
2. **Redundancy / migration** — merchant transitions from one provider to another (e.g., Gmail → Outlook), keeps both connected temporarily.

Rejected use cases (not in scope):

- Multi-brand (would require strict isolation per brand — out of scope).
- Multi-agent (each agent with their own inbox — out of scope).

## Architecture decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Threads stay strictly scoped to one mailbox | Simple, predictable, no merge surprises across mailboxes. Aligned with multi-département use case where threads of the same customer to different addresses are usually about different topics. |
| 2 | Unified inbox stream with per-thread mailbox badge + filter dropdown | Matches multi-département mental model (one agent, all conversations mixed chronologically). |
| 3 | Big-bang Prisma migration + backfill in a single transaction | No production merchants yet; no need for dual-write complexity. |
| 4 | Dedicated `/app/connections` page + indicator in inbox header linking to it | Connection management is a rare action; inbox stays focused on workflow. Indicator gives discoverability without UI bloat. |
| 5 | Downgrade with overflow → guided choice screen | The merchant explicitly picks which mailbox to keep; no silent deletion. |
| 6 | Scheduled downgrade with overflow → soft-pause on `effectiveAt` (option C) | Avoids silent data loss when a merchant forgets they scheduled a downgrade. All mailboxes get paused, merchant picks one to reactivate. |
| 7 | Onboarding wizard unchanged (1 mailbox at install) | Multi-mailbox is post-onboarding via `/app/connections`. Keeps wizard simple for the 95% of cases that need one mailbox. |
| 8 | Trial plan = 3 mailboxes (same as Pro) | Prospects need to experience the multi-mailbox feature during trial to be incentivised to convert to Pro. |
| 9 | Dashboard: aggregated by default + filter dropdown (same pattern as inbox) | Consistent mental model across the two analytics surfaces. |
| 10 | Per-mailbox sync job, up to `plan.maxMailboxes` parallel per shop | Bounded by the plan limit, parallel backfill on onboarding (~10 min instead of ~30 min for 3 mailboxes), fairness across shops still protected by `MAX_CONCURRENT` + SKIP LOCKED. Env var `JOB_LOCK_GRANULARITY=shop` as escape hatch. |
| 11 | Pause toggle per mailbox in `/app/connections` (autoSyncEnabled) | Field already exists, enables the migration use case (keep old provider readable while moving to new one). |

## Data model

### Current schema (the problem)

```prisma
model MailConnection {
  shop String @id   // single connection per shop, full stop
  ...
}
model Thread        { shop String, ... }   // no link to its connection
model IncomingEmail { shop String, ... }   // no link to its connection
model SyncJob       { shop String, ... }   // no link to its connection
```

### Target schema

```prisma
model MailConnection {
  id        String @id @default(cuid())
  shop      String
  provider  String
  email     String
  // ... all existing fields unchanged (tokens, historyId, deltaToken,
  //     autoSyncEnabled, autoSyncIntervalMinutes, outgoingAliases, etc.)

  threads        Thread[]
  incomingEmails IncomingEmail[]
  syncJobs       SyncJob[]

  @@unique([shop, email, provider])   // same email can coexist on different providers
                                       // (covers provider migration: Gmail → Outlook for the
                                       //  same address before disconnecting the old one)
  @@index([shop])
}

model Thread {
  // ...
  mailConnectionId String
  mailConnection   MailConnection @relation(fields: [mailConnectionId], references: [id], onDelete: Cascade)
  shop             String         // kept (denormalised for multi-tenant queries)
  // ...
  @@index([mailConnectionId])
}

model IncomingEmail {
  // ...
  mailConnectionId String
  mailConnection   MailConnection @relation(fields: [mailConnectionId], references: [id], onDelete: Cascade)
  shop             String         // kept
  // ...
  @@index([mailConnectionId])
}

model SyncJob {
  // ...
  mailConnectionId String?       // nullable: shop-level jobs (recompute, reclassify) have no specific mailbox
  shop             String        // kept
  // ...
  @@index([mailConnectionId])
}
```

### Key choices

- **`Thread.mailConnectionId` non-null**: a thread always belongs to exactly one mailbox.
- **`SyncJob.mailConnectionId` nullable**: most job kinds (`sync`, `backfill`, `resync`, `analyze_thread`) target a specific mailbox; `recompute` and `reclassify` operate on the whole shop.
- **`shop` denormalised everywhere**: every query keeps using `where: { shop, ... }` per the multi-tenant rule in CLAUDE.md. The `mailConnectionId` becomes an additional filter where relevant.
- **`onDelete: Cascade` on `Thread` and `IncomingEmail`**: disconnecting a mailbox deletes its threads, mails, and related rows in one transaction. This also resolves `[ARCH-C2]` (the orphan Thread bug we documented earlier).
- **No FK from `shop` to a `Shop` model**: `shop` stays a plain String, consistent with the rest of the schema.
- **Race window in `resolveCanonicalThread`**: the resolver currently creates a `Thread` row then upserts the `IncomingEmail`. With `Thread.mailConnectionId` non-null + Cascade FK, a concurrent `deleteConnection` between those two steps could either (a) cause `Thread.create` to fail with FK violation, or (b) leave the Thread orphaned by cascade. Mitigation: wrap resolver + email upsert in a single Prisma transaction. Catch FK-violation errors and treat them as "mailbox disconnected mid-ingest, skip this message". To be implemented carefully in the resolver refactor — flagged here so it isn't forgotten.

### Job kinds — required vs nullable `mailConnectionId`

| Job kind | `mailConnectionId` | Notes |
|---|---|---|
| `sync` | required | Per-mailbox incremental fetch. |
| `backfill` | required | Per-mailbox historical fetch. |
| `resync` | required | Resets the cursor for one mailbox. |
| `analyze_thread` | required (derived from the thread) | Thread is already mailbox-scoped. |
| `recompute` | null | Shop-wide recompute of operational state. |
| `reclassify` | null | Shop-wide reclassification. |

## Sync pipeline

### Changes from today

- `enqueueDuePeriodicSyncs` now scans all `MailConnection` rows (N per shop) where `autoSyncEnabled = true` and `lastSyncAt < now - interval`. Enqueues one `sync` job per mailbox due. This amplifies the existing `[DB-M5]` issue (no due-time filter in SQL) by a factor of `maxMailboxes`; pushing the filter into SQL becomes part of this scope.
- `autoSyncEnabled`, `autoSyncIntervalMinutes`, `lastSyncAt`, `historyId`, `deltaToken`, `lastSyncError`, `syncCancelledAt` are now per-mailbox (the columns exist already; today there is just one row per shop).
- `MailClient` factory signature changes from `getMailClient(shop, provider)` to `getMailClient(mailConnection)` — the connection carries provider, tokens, cursor, everything needed.
- Outgoing-detection (`app/lib/mail/outgoing-detection.ts`) reads `outgoingAliases` from the connection that received the mail (the mailbox currently being synced), not from "the" connection of the shop. Mailbox-scoped match: a reply where the `From:` address matches the aliases of the receiving mailbox is flagged outgoing. Edge case: if a merchant forwarding setup causes a reply to land in a different mailbox than the one it was sent from, the reply won't be detected as outgoing on the receiving mailbox. This is a rare misconfiguration that would have caused similar issues in single-mailbox; we accept it and log a warning rather than try to guess.
- Refresh stale analyses already iterates thread-by-thread, so it is per-mailbox naturally (the thread knows its mailbox).
- Billing suspension applies to the whole shop (all mailboxes), consistent with the shop-wide `BillingUsage.analyzedThreadsCount` counter.

### Concurrency model

**One job per mailbox, up to `plan.maxMailboxes` parallel jobs per shop.** The lock predicate in `claimNextJob` switches from "shop NOT IN (running shops)" to "mailboxConnectionId NOT IN (running mailboxes)" + a shop-level cap derived from the entitlements (or a simple "running jobs for this shop < plan.maxMailboxes").

Rationale:
- A Pro merchant onboarding 3 mailboxes back-to-back gets parallel backfill (~10 min total instead of ~30 min sequential). Real first-impression improvement.
- Bounded by the plan limit: Starter can only run 1 parallel (their limit is 1 anyway), Pro/Trial up to 3. No risk that a shop occupies the whole worker pool.
- With `MAX_CONCURRENT=4` and SKIP LOCKED, fairness across shops stays protected.

Implementation note: the per-shop cap requires reading the plan when claiming jobs. To avoid an extra DB roundtrip per claim, we can either (a) precompute the cap by caching the plan id on `ShopFlag` or `MailConnection`, or (b) compute the running-job count per shop in SQL inside the claim query. Decision deferred to the implementation plan.

**Escape hatch retained**: env var `JOB_LOCK_GRANULARITY=shop|mailbox` lets us fall back to "1 per shop" if mailbox-parallel ever causes contention we didn't anticipate. Default `mailbox`.

## Auth flow

### `getAuthUrl` — no signature change

The HMAC-signed `state` payload remains `{ shop, provider, nonce, expiresAt }`. We don't need a `mailConnectionId` at this stage because the merchant has not yet chosen which email to authenticate.

### Callback (`app/routes/mail-auth.tsx`)

After exchanging the code and fetching the user email (`fetchUserEmail` per provider):

```ts
const ent = await resolveEntitlements({ shop, admin });
if (!ent.canConnectMailbox) {
  return errorPage('mailboxLimit', ...);   // existing code path
}
await saveConnection({ shop, email: userEmail, provider, tokens });
```

### `saveConnection` — keyed by `(shop, email)`

```ts
await prisma.mailConnection.upsert({
  where: { shop_email_provider: { shop, email, provider } },
  create: { shop, email, provider, ...tokens },
  update: { ...tokens, lastSyncError: null, historyId: null, deltaToken: null, ... },
});
```

Behaviour:
- Same mailbox reconnected (token expired, re-auth flow) → update, preserves history. ✅
- New mailbox added → create. ✅
- OAuth callback returns the same email account by accident → update, no duplicate. ✅

### `deleteConnection` — scoped to one mailbox

```ts
export async function deleteConnection({ shop, mailConnectionId }: {
  shop: string;
  mailConnectionId: string;
}) {
  await prisma.$transaction(async (tx) => {
    await tx.mailConnection.delete({
      where: { id: mailConnectionId, shop },   // shop verified for tenant isolation
    });
    // Cascade onDelete handles Thread, IncomingEmail, ThreadProviderId,
    // ThreadStateHistory, and per-IncomingEmail ReplyDraft.
  });
}
```

This is where `[ARCH-C2]` (orphan Thread rows) is resolved. The cascade fan-out from `MailConnection`:
- `MailConnection` → `Thread` (new FK, Cascade) → `ThreadProviderId` (existing Cascade) + `ThreadStateHistory` (existing Cascade).
- `MailConnection` → `IncomingEmail` (new FK, Cascade) → `ReplyDraft` (existing Cascade via `emailId`).
- `Thread.IncomingEmail` link stays `SetNull` (existing), but `IncomingEmail` itself is deleted via the direct FK above.

Net effect: one transaction cleans up the connection plus every thread, mail, draft, identifier mapping, and audit row that belonged to it. No more fantôme threads.

Cost: the merchant loses operational state and drafts for the disconnected mailbox. Acceptable because (a) they explicitly chose to disconnect, (b) the other mailboxes of the shop are untouched, (c) the UI shows an explicit warning before the irreversible action.

### Re-auth of an existing mailbox

OAuth error (token revoked by the provider) does not delete the connection; the `/app/connections` page surfaces a "Re-auth required" state with a button that relaunches the OAuth flow. The `saveConnection` upsert on `(shop, email)` reattaches the new tokens to the existing row.

### Cross-provider mixing

A single shop can mix Gmail + Outlook + Zoho simultaneously. The `provider` column is per `MailConnection` row.

## Inbox UX

### Layout (option A — unified stream + badge + filter)

- **Header**: title `Inbox` + indicator on the right `📥 N boîtes · K erreur →` that links to `/app/connections`. The indicator only shows when more than one mailbox is connected (no chrome added for single-mailbox shops).
- **Error banner stays active for single-mailbox shops**: the existing `lastSyncError` banner already in the inbox is preserved verbatim. A single-mailbox shop still sees `⚠ support@brand.com n'arrive plus à se synchroniser (token expiré). [Re-connecter →]` — multi-mailbox is additive, never regressive.
- **Filter row**: dropdown `Toutes les boîtes (count) / support@brand.com (count) / returns@brand.com (count) / ...` next to the existing status filter and search input.
- **Thread list**: each row has a mailbox badge (colour stable per email, deterministic from `hash(email)`) + a small provider icon (G / O / Z) for visual redundancy and accessibility.

### Mobile rendering (< 640px)

- Indicator condensed to `📥 N`.
- Filter dropdown becomes full-width.
- Badge moves to the first line of the thread row (next to the sender name), provider icon hidden to save space (label is enough).

### Degraded state

When at least one connection has `lastSyncError != null`:
- A red banner appears in the inbox: `⚠ returns@brand.com n'arrive plus à se synchroniser (token expiré). [Re-connecter →]`.
- CTA links to `/app/connections#mailbox-<id>` which scrolls the connection into view and offers the re-auth flow.

### Visual indicator for paused mailboxes

When a mailbox has `autoSyncEnabled = false`:
- Its threads in the inbox show a `⏸️` icon on the badge.
- The banner in the inbox header notes the count: `X boîtes en pause`.

## `/app/connections` page

### Composition

1. **Header**: `Boîtes connectées (X / Y)`. If at limit and not Pro, a discreet upgrade message points to `/app/billing`.
2. **CTA `Connecter une boîte`**: disabled when `!canConnectMailbox`. Click opens a modal with the provider picker (Gmail / Outlook / Zoho) → launches the OAuth flow.
3. **Connection card** for each mailbox:
   - Email + provider icon.
   - Status pill: 🟢 sync OK / 🟡 in progress / 🔴 error / ⏸️ paused.
   - Metadata: `Dernière sync : il y a 3 min` / `Dernière erreur : token expiré (12:34)` / `X threads, Y brouillons`.
   - Actions: `Re-authentifier` (only if error) / `Pause / Reprendre` / `Resync historique` / `Déconnecter`.
4. **Disconnect modal**: explicit warning `X threads et leurs brouillons seront supprimés. Cette action est irréversible.` Confirmation requires typing the mailbox email (anti-misclick).
5. **Empty state**: `Aucune boîte connectée. Connectez votre première boîte pour commencer.` with primary CTA.

### Backend routes

- `GET /app/connections` — loader returns `{ connections, entitlements, threadCountsByMailbox, draftCountsByMailbox }`.
- `POST /app/connections`:
  - `intent=disconnect, mailConnectionId` → `deleteConnection({ shop, mailConnectionId })`.
  - `intent=toggleAutoSync, mailConnectionId, enabled` → updates `autoSyncEnabled`.
  - `intent=resync, mailConnectionId` → enqueues a `resync` job scoped to that mailbox.
  - `intent=reauth, provider, mailConnectionId` → redirects to the provider OAuth flow, embedding the existing `id` in the HMAC `state` so the callback updates instead of potentially creating a duplicate.

### Navigation

- Main nav entry next to Inbox / Dashboard / Settings / Billing.
- Reachable from the inbox header indicator.
- Reachable from the inbox `lastSyncError` banner CTA.

## Downgrade flow

### Immediate downgrade with overflow

Trigger: merchant on Pro with 2 or 3 connected mailboxes clicks "Passer à Starter" on `/app/billing`.

1. Server computes overflow: `currentMailboxCount > targetPlan.maxMailboxes`.
2. If overflow, **do not call Shopify Billing yet**. Redirect to `/app/billing/downgrade/select-mailbox?to=starter`.
3. The merchant picks one mailbox to keep (radio selection); the others will be disconnected.
4. On submit:
   - Validate that exactly one mailbox is selected and that it belongs to the shop.
   - In a Prisma transaction: `deleteConnection({ shop, mailConnectionId })` for each non-selected mailbox.
   - Call Shopify Billing API to apply the plan change.
   - Redirect to `/app/billing` with a confirmation toast.

### Scheduled downgrade with future overflow

Trigger: merchant on Pro schedules a downgrade for the end of the current billing period (`BillingScheduledChange.effectiveAt`).

At scheduling time: no overflow screen. The system records the scheduled change as today.

At `effectiveAt`: our code detects the new plan's lower limit. Instead of deleting mailboxes:
- Sets `autoSyncEnabled = false` on **all** mailboxes of the shop (no arbitrary choice).
- On the next loader (inbox or billing), shows a banner: `Vous êtes passé à Starter. Toutes vos boîtes sont en pause. Choisissez-en une à réactiver, ou supprimez les autres.`.
- The merchant picks one to reactivate via the toggle on `/app/connections`.

Rationale (option C from the brainstorming):
- No silent data loss if the merchant forgets the scheduled change.
- No friction at scheduling time (merchant may not know in 30 days which mailbox they'll want to keep).
- Reversible at any time (the merchant can upgrade back to Pro and reactivate).

### Re-upgrade after downgrade

If the merchant downgrades (loses mailboxes) and re-upgrades to Pro 10 minutes later, they must reconnect manually. Threads and drafts of disconnected mailboxes are gone. The downgrade flow shows this explicitly in the warning copy.

## Dashboard

Same pattern as the inbox: aggregated by default, with a mailbox filter dropdown.

- `app/routes/app.dashboard.tsx` loader reads `?mailbox=<id>` from the query string. If present, passes `mailConnectionId` to every stats helper (`getDashboardKpis`, `getTopIntents`, `getResponseTimeDailyBreakdown`, `getHeatmap`, etc.).
- Every helper in `app/lib/dashboard-stats.ts` accepts an optional `mailConnectionId?: string`. When unset, behaviour is unchanged (aggregated across the shop). When set, an `AND "mailConnectionId" = $X` clause is added.
- Dropdown UI matches the inbox filter for consistency.
- Filters stay independent per page (no global persistent filter shared with the inbox).

## Billing entitlements

The plumbing is mostly in place. Changes needed:

1. **`Trial.maxMailboxes: 1 → 3`** in `app/lib/billing/plans.ts`.
2. **`/app/billing` page**: surface `Boîtes : X / Y` next to the existing `analyzedThreads` counter. Reuses `mailboxStatus`.
3. **Downgrade interceptor**: new action on `/app/billing` that detects overflow and redirects to `/app/billing/downgrade/select-mailbox` before calling Shopify Billing.
4. **Soft-pause at `effectiveAt`**: a check at the top of the inbox / billing loaders (or a job, TBD in the implementation plan) detects `currentMailboxes > plan.maxMailboxes` and sets `autoSyncEnabled = false` on all mailboxes. Idempotent.

`canConnectMailbox`, `mailboxStatus`, and `mailboxCount` (already computed in `entitlements.ts`) work as-is with the new schema; their semantics just become accurate instead of capped at 1.

## Forward-compatibility and scale-readiness

The multi-mailbox refactor must not foreclose existing big-shop debt fixes.

### Existing debt that this design does NOT block

| Item | Why this design doesn't block its future fix |
|---|---|
| `[PERF-H3]` lazy-load `bodyHtml` and `analysisResult` in the inbox loader | The fix is orthogonal: lazy-loading bodies works just as well per-shop or per-(shop, mailbox). Adding a `mailConnectionId` filter is a single extra clause. |
| `[ARCH-M4]` paginate `fetchCustomerEmails` | Orthogonal — the customer fetch is keyed by shop, multi-mailbox doesn't change that. |
| `[DB-H3]` batch `recomputeAllOpenThreads` | Orthogonal — the recompute job stays shop-level (`mailConnectionId` null), batching works the same. |

### Debt this design amplifies

| Item | Amplification | Treatment |
|---|---|---|
| `[DB-M5]` no due-time filter in SQL for `enqueueDuePeriodicSyncs` | Scans 3× more rows for Pro shops. | **Included in this scope**: push the filter into SQL during the multi-mailbox work. |
| Heartbeat job writes | A Pro shop running 3 backfills concurrently produces 3 heartbeats. Negligible per shop, monitor at fleet level. | Watch metrics, no code change. |
| Metric cardinality | If we tag metrics by `mailConnectionId`, the cardinality grows 3× per shop. Bounded by `maxMailboxes × shop count`, stays well under Prometheus practical limits. | Tag `mailConnectionId` on the most useful metrics only (sync duration, errors). Keep cost metrics shop-level. |

### Design choices that keep doors open

- `(shop, mailConnectionId)` treated as a tuple in every query → adding lazy-load filters later costs nothing.
- `/app/connections` exists from day 1 → naturally extensible for per-mailbox diagnostics, debugging tools, autoSyncIntervalMinutes UI, etc.
- `JOB_LOCK_GRANULARITY` env var → switch to per-mailbox parallelism without refactor.
- `SyncJob.mailConnectionId` nullable → new job kinds can be either scope without schema change.

### Big-shop items explicitly deferred (referenced here so they don't get forgotten)

- `[PERF-H3]` — lazy-load `bodyHtml` + `analysisResult` in the inbox loader.
- `[ARCH-M4]` — paginate `fetchCustomerEmails`.
- `[DB-H3]` — batch `recomputeAllOpenThreads` with `Promise.all` chunks of 50.

These are tracked in `TECHNICAL_DEBT.md` and should be picked up as soon as we see real big-shop signal.

## Migration & rollout

No production merchants exist yet. Dev data on the test shop (`2ed20e.myshopify.com`) is disposable. This drastically simplifies the rollout.

### The Prisma migration (single file)

```sql
BEGIN;

-- 1. MailConnection: add id while keeping the old PK temporarily
ALTER TABLE "MailConnection" ADD COLUMN "id" TEXT;
UPDATE "MailConnection" SET "id" = 'mc_' || substr(md5(random()::text || shop), 1, 24);
ALTER TABLE "MailConnection" ALTER COLUMN "id" SET NOT NULL;

-- 2. Add mailConnectionId nullable on dependent tables
ALTER TABLE "Thread" ADD COLUMN "mailConnectionId" TEXT;
ALTER TABLE "IncomingEmail" ADD COLUMN "mailConnectionId" TEXT;
ALTER TABLE "SyncJob" ADD COLUMN "mailConnectionId" TEXT;

-- 3. Backfill: every shop has at most one MailConnection today, link everything to it
UPDATE "Thread" t
  SET "mailConnectionId" = (SELECT mc."id" FROM "MailConnection" mc WHERE mc.shop = t.shop);
UPDATE "IncomingEmail" e
  SET "mailConnectionId" = (SELECT mc."id" FROM "MailConnection" mc WHERE mc.shop = e.shop);
UPDATE "SyncJob" j
  SET "mailConnectionId" = (SELECT mc."id" FROM "MailConnection" mc WHERE mc.shop = j.shop)
  WHERE j.kind NOT IN ('recompute', 'reclassify');

-- 4. Guard
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Thread" WHERE "mailConnectionId" IS NULL) THEN
    RAISE EXCEPTION 'Orphan Thread rows after backfill';
  END IF;
  IF EXISTS (SELECT 1 FROM "IncomingEmail" WHERE "mailConnectionId" IS NULL) THEN
    RAISE EXCEPTION 'Orphan IncomingEmail rows after backfill';
  END IF;
END $$;

-- 5. Swap MailConnection PK
ALTER TABLE "MailConnection" DROP CONSTRAINT "MailConnection_pkey";
ALTER TABLE "MailConnection" ADD CONSTRAINT "MailConnection_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX "MailConnection_shop_email_key" ON "MailConnection"("shop", "email");
CREATE INDEX "MailConnection_shop_idx" ON "MailConnection"("shop");

-- 6. Tighten constraints + cascade
ALTER TABLE "Thread" ALTER COLUMN "mailConnectionId" SET NOT NULL;
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_mailConnectionId_fkey"
  FOREIGN KEY ("mailConnectionId") REFERENCES "MailConnection"("id") ON DELETE CASCADE;
ALTER TABLE "IncomingEmail" ALTER COLUMN "mailConnectionId" SET NOT NULL;
ALTER TABLE "IncomingEmail" ADD CONSTRAINT "IncomingEmail_mailConnectionId_fkey"
  FOREIGN KEY ("mailConnectionId") REFERENCES "MailConnection"("id") ON DELETE CASCADE;
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_mailConnectionId_fkey"
  FOREIGN KEY ("mailConnectionId") REFERENCES "MailConnection"("id") ON DELETE CASCADE;

CREATE INDEX "Thread_mailConnectionId_idx" ON "Thread"("mailConnectionId");
CREATE INDEX "IncomingEmail_mailConnectionId_idx" ON "IncomingEmail"("mailConnectionId");
CREATE INDEX "SyncJob_mailConnectionId_idx" ON "SyncJob"("mailConnectionId");

COMMIT;
```

### Deploy sequence

1. Merge the PR.
2. Render auto-deploys; `prisma migrate deploy` runs at startup.
3. Smoke tests on the test shop (`2ed20e.myshopify.com`): inbox load, sync, draft generation, billing entitlements.
4. Manually connect a second mailbox (Outlook or Zoho in addition to the existing one), test multi-mailbox end-to-end.
5. Test the downgrade flow.
6. Continue the public-launch path (Custom → Public Draft → Submit).

### Risk

None blocking. If the migration breaks or dev data is corrupted, `prisma migrate reset` and start over.

## Tests to write

Multi-tenant + plan transitions = large surface to cover. Non-exhaustive list, will be detailed in the implementation plan.

### Unit tests

- `resolveCanonicalThread` with multiple mailboxes (same shop, two providers, two threads that should not merge).
- `getMailClient(mailConnection)` returns the right provider client.
- Outgoing detection reads `outgoingAliases` from the right mailbox.
- Entitlement: `canConnectMailbox` true/false at boundaries for each plan (Trial 3, Starter 1, Pro 3, internal Infinity).
- `deleteConnection` cascade deletes Thread, IncomingEmail, ThreadProviderId, ThreadStateHistory, ReplyDraft.

### Integration tests

- **Cross-mailbox isolation within the same shop** (high-priority — the real refactor risk): one shop with 3 mailboxes, assert that `where: { shop, mailConnectionId: A }` queries never return threads, emails, or counts that belong to mailbox B or C. Tested for every query path touched by the refactor (inbox loader, dashboard helpers, draft generation, refresh-stale, classification, etc.). Catches the most likely class of bug: a `where: { shop }` clause that forgot to add `mailConnectionId` and silently leaks data between mailboxes of the same shop.
- Two shops, each with multiple mailboxes — assert no data leaks across shops (multi-tenant rule).
- Connecting a second mailbox on a Pro shop succeeds; a third blocks on Starter.
- Downgrade with overflow: select-mailbox screen, submitting deletes the others, Shopify Billing is called once.
- Scheduled downgrade at `effectiveAt`: all mailboxes get `autoSyncEnabled = false`, banner shows, reactivating one works.
- `shop/redact` GDPR webhook deletes all mailboxes of the shop via cascade.
- `customers/redact` scans across all mailboxes of the shop.
- Auto-sync loop picks one mailbox per shop per tick (1 job per shop concurrency), respects `autoSyncEnabled = false`.
- Same email cannot be connected twice to the same shop (`@@unique([shop, email])`).
- Different shops can each connect the same email independently.

### End-to-end (Playwright)

- Connect Gmail then Outlook on a fresh test shop, verify both appear in `/app/connections` and in the inbox dropdown.
- Disconnect one, verify its threads disappear from the inbox and dashboard, the other mailbox is untouched.
- Pause one, verify the badge shows ⏸️ on its threads and no new sync runs.
- Trigger an OAuth re-auth flow, verify the existing connection is updated (not duplicated).

## Implementation phases (high-level, to be detailed in the plan)

Rough sequencing (the implementation plan will produce the precise breakdown):

1. **Schema migration + backfill** (foundational, blocks everything else).
2. **Code refactor: `(shop, mailConnectionId)` everywhere** (audit ~130 query sites, update where needed, keep `shop` for tenant isolation).
3. **Auth flow** (`saveConnection`, `deleteConnection`, mail-auth.tsx callback).
4. **Sync pipeline** (job enqueue per-mailbox, MailClient factory, `[DB-M5]` SQL filter).
5. **Inbox UX** (badge, filter, indicator, mobile, paused state).
6. **`/app/connections` page** (loader, actions, modals, cards).
7. **Dashboard filter**.
8. **Billing** (trial limit bump, mailbox counter on billing page, downgrade interceptor, soft-pause at effectiveAt).
9. **Tests** (unit, integration, e2e).
10. **Smoke test on the test shop**, then merge.
