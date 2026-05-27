# Multi-mailbox per shop: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app multi-mailbox per shop. Pro and Trial plans deliver up to 3 connected mailboxes; Starter stays at 1. The inbox shows a unified stream with per-thread mailbox badges and a filter; a new `/app/connections` page manages connections (add, disconnect, pause, re-auth). Downgrade with overflow uses a guided choice screen for immediate downgrades and a soft-pause-all flow at `effectiveAt` for scheduled downgrades. The migration is big-bang on empty production.

**Architecture:** `MailConnection.shop @id` becomes `id String @id @default(cuid())` with `@@unique([shop, email])`. `Thread`, `IncomingEmail`, and `SyncJob` get a `mailConnectionId` column with FK + Cascade onDelete; `Thread` and `IncomingEmail` are non-null, `SyncJob` is nullable for shop-wide jobs (`recompute`, `reclassify`). The sync pipeline switches to one-job-per-mailbox with a per-shop cap = `plan.maxMailboxes`. Cascade delete on `MailConnection` resolves the orphan-Thread bug (`ARCH-C2`).

**Tech Stack:** TypeScript, Prisma 6 (Postgres on Neon), React Router 7, vitest (unit + integration against a real Postgres test DB), Playwright, Shopify Admin/Billing API, OpenAI SDK.

**Spec:** [docs/superpowers/specs/2026-05-23-multi-mailbox-design.md](../specs/2026-05-23-multi-mailbox-design.md)

---

## Conventions

- Each task ends with a commit. Prefixes used in this repo: `feat()`, `refactor()`, `fix()`, `test()`, `chore(migration)`, `docs()`.
- Unit tests: `npm test`. Integration tests: `npm run test:integration`. Typecheck: `npm run typecheck`. E2E: `npm run test:e2e` (Playwright).
- Integration tests use the real Postgres test DB via `app/lib/__tests__/integration/helpers/db.ts`. Reuse `TEST_SHOP = "integration-test.myshopify.com"`. For multi-mailbox tests, also seed `TEST_SHOP_B = "integration-test-b.myshopify.com"` to keep the cross-shop case explicit.
- After every refactor task, run `npm run typecheck 2>&1 | grep <file>` to confirm no new errors on touched files. Pre-existing errors in `app/routes/app.inbox.tsx` etc. are tracked in `TECHNICAL_DEBT.md` and OK.
- All UI copy in French uses **vouvoiement** (formal "vous"). i18n keys go in both `app/i18n/locales/fr.json` and `en.json`.
- Phases are sequential. Phase 1 (schema) blocks everything else. Phases 2–4 (backend refactor) block UI phases 5–7.

---

## File map

### New files

```
prisma/migrations/<auto-date>_multi_mailbox/migration.sql
app/lib/mail/__tests__/multi-mailbox-isolation.test.ts        (integration, high-priority)
app/lib/mail/__tests__/cross-shop-isolation.test.ts           (integration)
app/lib/mail/__tests__/deleteConnection-cascade.test.ts       (integration)
app/lib/billing/downgrade-overflow.ts                         (helper: detect + resolve)
app/lib/billing/__tests__/downgrade-overflow.test.ts          (integration)
app/lib/billing/soft-pause.ts                                 (helper: detect + apply)
app/lib/billing/__tests__/soft-pause.test.ts                  (integration)
app/lib/mail/mailbox-color.ts                                 (deterministic hash → colour)
app/lib/mail/__tests__/mailbox-color.test.ts                  (unit)
app/components/inbox/MailboxBadge.tsx                         (badge component)
app/components/inbox/MailboxFilter.tsx                        (dropdown component)
app/components/inbox/MailboxIndicator.tsx                     (header indicator)
app/components/connections/ConnectionCard.tsx                 (card on /app/connections)
app/components/connections/AddMailboxModal.tsx                (provider picker modal)
app/components/connections/DisconnectModal.tsx                (confirmation modal)
app/components/connections/SoftPauseBanner.tsx                (post-downgrade banner)
app/routes/app.connections.tsx                                (page route)
app/routes/app.billing.downgrade.select-mailbox.tsx           (guided choice route)
app/i18n/locales/fr.json / en.json                            (new keys)
docs/superpowers/plans/2026-05-23-multi-mailbox.md            (this file)
```

### Modified files (non-exhaustive list of major touches)

```
prisma/schema.prisma
app/lib/mail/types.ts                          (MailClient takes MailConnection)
app/lib/mail/auto-sync.ts                      (per-mailbox enqueue + per-shop cap)
app/lib/mail/job-queue.ts                      (SyncJob.mailConnectionId)
app/lib/mail/thread-resolver.ts                (transaction-wrap; race-safe)
app/lib/mail/outgoing-detection.ts             (mailbox-scoped alias match)
app/lib/mail/backfill.ts                       (per-mailbox)
app/lib/gmail/auth.ts                          (saveConnection + deleteConnection)
app/lib/gmail/pipeline.ts                      (processNewEmails takes mailConnectionId)
app/lib/zoho/auth.ts                           (saveConnection + deleteConnection)
app/lib/outlook/auth.ts                        (saveConnection + deleteConnection; remove dead dup)
app/lib/outlook/mail-client.ts                 (takes MailConnection)
app/lib/billing/plans.ts                       (Trial.maxMailboxes 1 → 3)
app/lib/billing/entitlements.ts                (no functional change; mailboxCount is now accurate)
app/lib/dashboard-stats.ts                     (every helper gains optional mailConnectionId)
app/lib/support/inbox-actions.ts               (handleResync, handleDisconnect, handleDownload, etc. → per-mailbox)
app/lib/support/refresh-thread-analysis.ts     (no logic change, queries already thread-scoped)
app/routes/mail-auth.tsx                       (callback uses saveConnection by (shop, email))
app/routes/app.inbox.tsx                       (loader: mailConnectionId filter; UI: badge, filter, indicator, paused state)
app/routes/app.dashboard.tsx                   (mailbox filter)
app/routes/app.billing.tsx                     (mailbox counter + downgrade interceptor)
app/routes/webhooks.app.uninstalled.tsx        (deletes all connections — already by shop, still works)
TECHNICAL_DEBT.md                              (mark ARCH-C2 resolved, DB-M5 resolved)
CLAUDE.md                                      (multi-mailbox section)
```

---

## Phase 1 — Schema migration

This phase is foundational. Nothing else compiles or runs until it's done.

### Task 1.1: Wipe dev DB for clean migration baseline

The test mailbox already has data the user said is disposable. We start clean so the migration runs against a known state.

**Files:** none (operates on dev DB).

- [ ] **Step 1: Reset the dev DB**

Run:
```bash
npx prisma migrate reset --force
```
Expected: drops all tables, recreates from migrations, generates client. Output ends with `Database reset successful`.

- [ ] **Step 2: Verify empty state**

Run:
```bash
npx tsx -e "import prisma from './app/db.server'; const c = await prisma.mailConnection.count(); console.log('mc count:', c); await prisma.\$disconnect();"
```
Expected: `mc count: 0`.

- [ ] **Step 3: No commit**

(Dev DB state is not in git.)

### Task 1.2: Write the Prisma migration SQL

**Files:**
- Create: `prisma/migrations/20260523_multi_mailbox/migration.sql` (replace timestamp with `npx prisma migrate dev --create-only` output)

- [ ] **Step 1: Create the migration shell**

Run:
```bash
npx prisma migrate dev --create-only --name multi_mailbox
```
Expected: creates `prisma/migrations/<timestamp>_multi_mailbox/migration.sql` with an empty body (Prisma diffs against schema, which we haven't modified yet, so the file may be empty or have stale content). We will replace the body fully.

- [ ] **Step 2: Replace the migration body**

Open the new file and replace its contents with:

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

-- 3. Backfill (each shop has at most one MailConnection at this point)
UPDATE "Thread" t
  SET "mailConnectionId" = (SELECT mc."id" FROM "MailConnection" mc WHERE mc.shop = t.shop);
UPDATE "IncomingEmail" e
  SET "mailConnectionId" = (SELECT mc."id" FROM "MailConnection" mc WHERE mc.shop = e.shop);
UPDATE "SyncJob" j
  SET "mailConnectionId" = (SELECT mc."id" FROM "MailConnection" mc WHERE mc.shop = j.shop)
  WHERE j.kind NOT IN ('recompute', 'reclassify');

-- 4. Guard against orphans (would indicate a row with no matching MailConnection)
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

- [ ] **Step 3: Apply the migration to dev**

Run:
```bash
npx prisma migrate deploy
```
Expected: `1 migration found in prisma/migrations` then `The following migration(s) have been applied: 20260523_multi_mailbox`. No errors.

- [ ] **Step 4: Verify schema state**

Run:
```bash
npx tsx -e "
import prisma from './app/db.server';
const r = await prisma.\$queryRaw\`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'Thread' AND column_name IN ('shop', 'mailConnectionId')
  ORDER BY column_name
\`;
console.log(r);
await prisma.\$disconnect();
"
```
Expected: prints two rows showing both columns exist; `mailConnectionId` is `NO` (not nullable).

- [ ] **Step 5: Commit**

```bash
git add prisma/migrations/
git commit -m "chore(migration): introduce mailConnectionId on Thread/IncomingEmail/SyncJob + swap MailConnection PK"
```

### Task 1.3: Update `prisma/schema.prisma`

Reflect the new schema state so Prisma client regeneration matches the migrated DB.

**Files:**
- Modify: `prisma/schema.prisma` (MailConnection, Thread, IncomingEmail, SyncJob models)

- [ ] **Step 1: Read current schema for the four models**

Run:
```bash
grep -n "^model \(MailConnection\|Thread\|IncomingEmail\|SyncJob\)" prisma/schema.prisma
```
Note the line numbers so you can find each block.

- [ ] **Step 2: Replace `MailConnection` block**

Find the `model MailConnection { ... }` block and replace its header + indexes section. Keep all existing fields (tokens, historyId, deltaToken, autoSyncEnabled, etc.) unchanged. The new model body:

```prisma
model MailConnection {
  id              String   @id @default(cuid())
  shop            String
  provider        String   @default("gmail")
  email           String   @default("")
  outgoingAliases String   @default("[]")
  accessToken     String
  refreshToken    String
  tokenExpiry     DateTime
  historyId       String?
  deltaToken      String?
  lastSyncAt      DateTime?
  lastSyncError   String?
  syncCancelledAt DateTime?
  zohoAccountId   String?
  autoSyncEnabled         Boolean   @default(true)
  autoSyncIntervalMinutes Int       @default(5)
  onboardingBackfillDoneAt DateTime?
  onboardingBackfillDays   Int       @default(60)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  threads        Thread[]
  incomingEmails IncomingEmail[]
  syncJobs       SyncJob[]

  @@unique([shop, email])
  @@index([shop])
  @@index([autoSyncEnabled, lastSyncAt])
}
```

- [ ] **Step 3: Add `mailConnectionId` + relation on `Thread`**

Inside the `model Thread { ... }` block, just after the `shop` line, insert:

```prisma
  mailConnectionId String
  mailConnection   MailConnection @relation(fields: [mailConnectionId], references: [id], onDelete: Cascade)
```

In the block's index section at the bottom, add:

```prisma
  @@index([mailConnectionId])
```

- [ ] **Step 4: Add `mailConnectionId` + relation on `IncomingEmail`**

Inside the `model IncomingEmail { ... }` block, just after the `shop` line, insert:

```prisma
  mailConnectionId String
  mailConnection   MailConnection @relation(fields: [mailConnectionId], references: [id], onDelete: Cascade)
```

In the index section, add:

```prisma
  @@index([mailConnectionId])
```

- [ ] **Step 5: Add `mailConnectionId` (nullable) on `SyncJob`**

Inside the `model SyncJob { ... }` block, just after the `shop` line, insert:

```prisma
  mailConnectionId String?
  mailConnection   MailConnection? @relation(fields: [mailConnectionId], references: [id], onDelete: Cascade)
```

In the index section, add:

```prisma
  @@index([mailConnectionId])
```

- [ ] **Step 6: Regenerate the Prisma client and confirm schema matches DB**

Run:
```bash
npx prisma generate
npx prisma migrate status
```
Expected: `Database schema is up to date!`. No drift warning.

- [ ] **Step 7: Typecheck**

Run:
```bash
npm run typecheck 2>&1 | grep -E "error TS" | wc -l
```
Note the count. At this stage it will be high — the new required fields break many call sites that don't yet pass `mailConnectionId`. That's expected; the next phases fix them.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma
git commit -m "chore(schema): reflect multi-mailbox columns on Prisma models"
```

---

## Phase 2 — Auth flow (saveConnection, deleteConnection, mail-auth callback)

We refactor the auth layer first because it's the smallest self-contained unit and unblocks the rest.

### Task 2.1: Refactor `gmail/auth.ts saveConnection` to upsert by `(shop, email)`

**Files:**
- Modify: `app/lib/gmail/auth.ts` (function `saveConnection`)

- [ ] **Step 1: Find current `saveConnection`**

Run:
```bash
grep -n "saveConnection" app/lib/gmail/auth.ts
```

- [ ] **Step 2: Replace the function body**

Replace the entire `export async function saveConnection(...)` with:

```ts
export async function saveConnection(
  shop: string,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiry: Date;
    email: string;
    aliases?: string[];
  },
) {
  const outgoingAliases = JSON.stringify(tokens.aliases ?? []);
  await prisma.mailConnection.upsert({
    where: { shop_email: { shop, email: tokens.email } },
    create: {
      shop,
      provider: "gmail",
      email: tokens.email,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      outgoingAliases,
    },
    update: {
      provider: "gmail",
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      outgoingAliases,
      lastSyncError: null,
      lastSyncAt: null,
      historyId: null,
      deltaToken: null,
      syncCancelledAt: null,
    },
  });
}
```

Note: `onboardingBackfillDoneAt` is intentionally NOT reset on update — if a re-auth happens for the same mailbox, the backfill has already run.

- [ ] **Step 3: Typecheck this file**

Run:
```bash
npm run typecheck 2>&1 | grep "app/lib/gmail/auth.ts"
```
Expected: no errors on this file (the upsert composite key `shop_email` matches the new schema).

- [ ] **Step 4: Commit**

```bash
git add app/lib/gmail/auth.ts
git commit -m "refactor(gmail-auth): upsert MailConnection by (shop, email)"
```

### Task 2.2: Refactor `gmail/auth.ts deleteConnection` to scope by `mailConnectionId`

**Files:**
- Modify: `app/lib/gmail/auth.ts` (function `deleteConnection`)

- [ ] **Step 1: Replace function signature and body**

Replace the entire `export async function deleteConnection(shop: string)` with:

```ts
export async function deleteConnection(params: {
  shop: string;
  mailConnectionId: string;
}) {
  const { shop, mailConnectionId } = params;
  console.warn(
    `[audit] deleteConnection shop=${shop} mailConnectionId=${mailConnectionId} action=cascade-delete`,
  );
  await prisma.mailConnection.delete({
    where: { id: mailConnectionId, shop },
  });
  // Cascade onDelete handles Thread, IncomingEmail, ThreadProviderId,
  // ThreadStateHistory, ReplyDraft. Single statement, single transaction.
}
```

Note: we no longer need `$transaction` wrapping because the cascade does everything in one statement. The Prisma `delete` is the transaction boundary.

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck 2>&1 | grep "app/lib/gmail/auth.ts"
```
Expected: no errors on this file. Errors will surface at call sites (covered next).

- [ ] **Step 3: Commit**

```bash
git add app/lib/gmail/auth.ts
git commit -m "refactor(gmail-auth): scope deleteConnection by mailConnectionId, rely on FK cascade"
```

### Task 2.3: Update `handleDisconnect` to pass `mailConnectionId`

**Files:**
- Modify: `app/lib/support/inbox-actions.ts` (function `handleDisconnect`)

- [ ] **Step 1: Replace the function**

Find `export async function handleDisconnect(...)` and replace with:

```ts
export async function handleDisconnect(params: {
  shop: string;
  mailConnectionId: string;
}) {
  await deleteConnection({ shop: params.shop, mailConnectionId: params.mailConnectionId });
  return { disconnected: true, report: null, reanalyzed: null, refined: null, stopped: false };
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck 2>&1 | grep "app/lib/support/inbox-actions.ts"
```
Expected: errors only at call sites of `handleDisconnect` (in routes) that don't yet pass `mailConnectionId`. We fix those next.

- [ ] **Step 3: Find call sites**

Run:
```bash
grep -rn "handleDisconnect" app/routes/
```

- [ ] **Step 4: Update call sites in `app.inbox.tsx` and `app.connections.tsx` (created later) for now**

For now, in `app/routes/app.inbox.tsx`, find any `handleDisconnect({ shop })` and change to:

```ts
const mailConnectionId = String(formData.get("mailConnectionId") ?? "");
if (!mailConnectionId) return json({ error: "missing_mailConnectionId" }, { status: 400 });
return await handleDisconnect({ shop, mailConnectionId });
```

The inbox's disconnect action is invoked from the existing "Déconnecter" button (legacy single-mailbox flow). In v1 this button will be removed (the action moves to `/app/connections`); update the form to include the `mailConnectionId` field referencing `connection.id`.

If unsure where exactly, search for `intent === "disconnect"`:

```bash
grep -n 'intent === "disconnect"' app/routes/app.inbox.tsx
```

Apply the change at that branch.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck 2>&1 | grep "handleDisconnect"
```
Expected: no errors mentioning `handleDisconnect`.

- [ ] **Step 6: Commit**

```bash
git add app/lib/support/inbox-actions.ts app/routes/app.inbox.tsx
git commit -m "refactor(inbox): pass mailConnectionId to handleDisconnect"
```

### Task 2.4: Apply the same `saveConnection`/`deleteConnection` shape to `zoho/auth.ts`

**Files:**
- Modify: `app/lib/zoho/auth.ts`

- [ ] **Step 1: Apply Task 2.1 pattern to Zoho's `saveConnection`**

Open `app/lib/zoho/auth.ts`, find `saveConnection`, replace using the same upsert keyed by `shop_email` as Gmail's version. Preserve all Zoho-specific fields (notably `zohoAccountId` if set on the connection).

```ts
export async function saveConnection(
  shop: string,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiry: Date;
    email: string;
    aliases?: string[];
    zohoAccountId?: string | null;
  },
) {
  const outgoingAliases = JSON.stringify(tokens.aliases ?? []);
  await prisma.mailConnection.upsert({
    where: { shop_email: { shop, email: tokens.email } },
    create: {
      shop,
      provider: "zoho",
      email: tokens.email,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      outgoingAliases,
      zohoAccountId: tokens.zohoAccountId ?? null,
    },
    update: {
      provider: "zoho",
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      outgoingAliases,
      zohoAccountId: tokens.zohoAccountId ?? null,
      lastSyncError: null,
      lastSyncAt: null,
      historyId: null,
      deltaToken: null,
      syncCancelledAt: null,
    },
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck 2>&1 | grep "app/lib/zoho/auth.ts"
```

- [ ] **Step 3: Commit**

```bash
git add app/lib/zoho/auth.ts
git commit -m "refactor(zoho-auth): upsert MailConnection by (shop, email)"
```

### Task 2.5: Apply the same shape to `outlook/auth.ts`, drop the dead `deleteConnection` duplicate

**Files:**
- Modify: `app/lib/outlook/auth.ts`

- [ ] **Step 1: Apply the `saveConnection` upsert pattern**

In `app/lib/outlook/auth.ts`, find `saveConnection` and replace the upsert key with `shop_email`. Use `provider: "outlook"`.

```ts
export async function saveConnection(
  shop: string,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiry: Date;
    email: string;
    aliases?: string[];
  },
) {
  const outgoingAliases = JSON.stringify(tokens.aliases ?? []);
  await prisma.mailConnection.upsert({
    where: { shop_email: { shop, email: tokens.email } },
    create: {
      shop,
      provider: "outlook",
      email: tokens.email,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      outgoingAliases,
    },
    update: {
      provider: "outlook",
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      outgoingAliases,
      lastSyncError: null,
      lastSyncAt: null,
      historyId: null,
      deltaToken: null,
      syncCancelledAt: null,
    },
  });
}
```

- [ ] **Step 2: Delete the dead `deleteConnection` in this file**

The Outlook file has its own `deleteConnection` that nothing imports (the brainstorming established this). Delete it entirely. The Gmail one (now refactored) is the canonical entry point used by all providers.

Run:
```bash
grep -n "export async function deleteConnection" app/lib/outlook/auth.ts
```
Delete the entire function body.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | grep "app/lib/outlook/auth.ts"
```

- [ ] **Step 4: Commit**

```bash
git add app/lib/outlook/auth.ts
git commit -m "refactor(outlook-auth): upsert by (shop, email); remove dead deleteConnection duplicate"
```

### Task 2.6: `mail-auth.tsx` callback — no signature change, semantic update

**Files:**
- Modify: `app/routes/mail-auth.tsx` (callback action; the per-provider `saveConnection` is now called with the new shape)

- [ ] **Step 1: Read the current callback flow**

Run:
```bash
grep -n "saveConnection\|canConnectMailbox" app/routes/mail-auth.tsx
```
Confirm the existing guard at line ~207 still calls `resolveEntitlements({ shop, admin })` and returns the `mailboxLimit` error page before invoking `saveConnection`.

- [ ] **Step 2: Verify the call site still works with the new `saveConnection` signature**

The `saveConnection` signature didn't change — only the upsert internals did. The callback should compile as-is. Confirm:

```bash
npm run typecheck 2>&1 | grep "mail-auth.tsx"
```

If there are errors, they're likely about something else. Read the message and fix accordingly.

- [ ] **Step 3: Commit (no functional changes — touch only if there's a typo or comment)**

If nothing changed, skip the commit. Otherwise:

```bash
git add app/routes/mail-auth.tsx
git commit -m "refactor(mail-auth): align with new saveConnection upsert key"
```

### Task 2.7: Integration test — `saveConnection` allows multiple per shop

**Files:**
- Create: `app/lib/__tests__/integration/multi-mailbox-auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/__tests__/integration/multi-mailbox-auth.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import { resetTestDb, TEST_SHOP } from "./helpers/db";
import { saveConnection as saveGmail } from "../../gmail/auth";
import { saveConnection as saveOutlook } from "../../outlook/auth";

describe("multi-mailbox auth", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("allows two different mailboxes on the same shop", async () => {
    await saveGmail(TEST_SHOP, {
      accessToken: "g-access",
      refreshToken: "g-refresh",
      expiry: new Date(Date.now() + 3600_000),
      email: "support@brand.com",
    });
    await saveOutlook(TEST_SHOP, {
      accessToken: "o-access",
      refreshToken: "o-refresh",
      expiry: new Date(Date.now() + 3600_000),
      email: "returns@brand.com",
    });

    const conns = await prisma.mailConnection.findMany({ where: { shop: TEST_SHOP } });
    expect(conns).toHaveLength(2);
    const emails = conns.map((c) => c.email).sort();
    expect(emails).toEqual(["returns@brand.com", "support@brand.com"]);
  });

  it("upserts the same (shop, email) instead of creating a duplicate", async () => {
    await saveGmail(TEST_SHOP, {
      accessToken: "v1",
      refreshToken: "r1",
      expiry: new Date(Date.now() + 3600_000),
      email: "support@brand.com",
    });
    await saveGmail(TEST_SHOP, {
      accessToken: "v2",
      refreshToken: "r2",
      expiry: new Date(Date.now() + 3600_000),
      email: "support@brand.com",
    });
    const conns = await prisma.mailConnection.findMany({ where: { shop: TEST_SHOP } });
    expect(conns).toHaveLength(1);
  });

  it("rejects two connections on (shop, email) regardless of provider", async () => {
    await saveGmail(TEST_SHOP, {
      accessToken: "g",
      refreshToken: "g",
      expiry: new Date(Date.now() + 3600_000),
      email: "support@brand.com",
    });
    // Outlook upsert for the same (shop, email) — should overwrite, not create a new row
    await saveOutlook(TEST_SHOP, {
      accessToken: "o",
      refreshToken: "o",
      expiry: new Date(Date.now() + 3600_000),
      email: "support@brand.com",
    });
    const conns = await prisma.mailConnection.findMany({ where: { shop: TEST_SHOP } });
    expect(conns).toHaveLength(1);
    expect(conns[0].provider).toBe("outlook"); // last write wins
  });
});
```

- [ ] **Step 2: Run the test**

```bash
npm run test:integration -- app/lib/__tests__/integration/multi-mailbox-auth.test.ts
```
Expected: all three tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/lib/__tests__/integration/multi-mailbox-auth.test.ts
git commit -m "test(auth): multi-mailbox saveConnection upsert semantics"
```

---

## Phase 3 — Sync pipeline (per-mailbox jobs, MailClient factory, concurrency)

### Task 3.1: Change `MailClient` factory signature to accept a `MailConnection`

**Files:**
- Modify: `app/lib/mail/types.ts` (or wherever `getMailClient` is exported)
- Modify: every provider mail client implementation (`gmail/mail-client.ts`, `zoho/mail-client.ts`, `outlook/mail-client.ts`)

- [ ] **Step 1: Find the factory**

```bash
grep -rn "getMailClient\|MailClient" app/lib/mail/types.ts app/lib/mail/
```

- [ ] **Step 2: Update the factory signature**

In `app/lib/mail/types.ts` (or whichever file exports `getMailClient`), change the signature from `(shop: string, provider: string)` to `(connection: MailConnection)`:

```ts
import type { MailConnection } from "@prisma/client";

export async function getMailClient(connection: MailConnection): Promise<MailClient> {
  switch (connection.provider) {
    case "gmail":
      return (await import("../gmail/mail-client")).createGmailClient(connection);
    case "outlook":
      return (await import("../outlook/mail-client")).createOutlookClient(connection);
    case "zoho":
      return (await import("../zoho/mail-client")).createZohoClient(connection);
    default:
      throw new Error(`Unknown provider: ${connection.provider}`);
  }
}
```

- [ ] **Step 3: Update each provider's mail-client factory**

For each of `gmail/mail-client.ts`, `outlook/mail-client.ts`, `zoho/mail-client.ts`, find the existing factory (likely `createXxxClient(shop)` or similar) and change it to accept a `MailConnection`. Within the function, use `connection.id`, `connection.email`, `connection.accessToken`, etc., from the parameter instead of re-querying by shop.

Pattern for each provider:

```ts
import type { MailConnection } from "@prisma/client";

export function createGmailClient(connection: MailConnection): MailClient {
  return {
    // ... use connection.accessToken / connection.refreshToken / connection.historyId etc.
  };
}
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck 2>&1 | grep "mail-client\|getMailClient"
```
Expected: errors at call sites that haven't been updated yet. Note them.

- [ ] **Step 5: Update call sites**

Search:
```bash
grep -rn "getMailClient(" app/lib/ app/routes/
```

For each call site, replace `getMailClient(shop, provider)` with:

```ts
const connection = await prisma.mailConnection.findFirst({ where: { shop, id: mailConnectionId } });
if (!connection) throw new Error(`No connection ${mailConnectionId} for shop ${shop}`);
const client = await getMailClient(connection);
```

(In contexts where the caller already has a `MailConnection` object loaded — e.g., the sync job runner — pass it directly without re-querying.)

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck 2>&1 | grep -E "mail-client|getMailClient" | wc -l
```
Expected: 0.

- [ ] **Step 7: Commit**

```bash
git add app/lib/mail/types.ts app/lib/gmail/mail-client.ts app/lib/outlook/mail-client.ts app/lib/zoho/mail-client.ts
git add -p   # interactive add for any call sites you updated
git commit -m "refactor(mail-client): factory takes a MailConnection instead of (shop, provider)"
```

### Task 3.2: Add `mailConnectionId` to `SyncJob` enqueue helpers

**Files:**
- Modify: `app/lib/mail/job-queue.ts`

- [ ] **Step 1: Find `enqueueJob`**

```bash
grep -n "export async function enqueueJob\|export function enqueueJob" app/lib/mail/job-queue.ts
```

- [ ] **Step 2: Update the signature**

Change `enqueueJob(shop, kind, params?)` to:

```ts
export type EnqueueOptions = {
  shop: string;
  kind: SyncJobKind;
  mailConnectionId?: string | null;   // required for sync/backfill/resync/analyze_thread; null for recompute/reclassify
  params?: Record<string, unknown>;
};

export async function enqueueJob(opts: EnqueueOptions): Promise<SyncJob> {
  // Validate that mailbox-scoped kinds receive a mailConnectionId
  const mailboxScoped: SyncJobKind[] = ["sync", "backfill", "resync", "analyze_thread"];
  if (mailboxScoped.includes(opts.kind) && !opts.mailConnectionId) {
    throw new Error(`Job kind ${opts.kind} requires mailConnectionId`);
  }
  return prisma.syncJob.create({
    data: {
      shop: opts.shop,
      kind: opts.kind,
      mailConnectionId: opts.mailConnectionId ?? null,
      params: opts.params ? JSON.stringify(opts.params) : null,
    },
  });
}
```

- [ ] **Step 3: Update call sites of `enqueueJob`**

```bash
grep -rn "enqueueJob(" app/lib/ app/routes/
```

For each call site, change `enqueueJob(shop, kind, params)` to `enqueueJob({ shop, kind, mailConnectionId, params })`. The `mailConnectionId` value depends on the kind:
- `sync` / `backfill` / `resync` / `analyze_thread`: pass the relevant mailbox id (the caller knows it from the action input).
- `recompute` / `reclassify`: omit `mailConnectionId` or pass `null`.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck 2>&1 | grep "enqueueJob"
```
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add app/lib/mail/job-queue.ts
git add -p  # any call sites you updated
git commit -m "refactor(job-queue): enqueueJob takes mailConnectionId for mailbox-scoped kinds"
```

### Task 3.3: Switch `enqueueDuePeriodicSyncs` to per-mailbox + SQL due-time filter (resolves DB-M5)

**Files:**
- Modify: `app/lib/mail/auto-sync.ts`

- [ ] **Step 1: Find the current implementation**

```bash
grep -n "enqueueDuePeriodicSyncs\|autoSyncEnabled" app/lib/mail/auto-sync.ts
```

- [ ] **Step 2: Replace the function**

Replace the body to:
1. Push the due-time filter into SQL (resolves `[DB-M5]`).
2. Iterate over `MailConnection` rows directly (one row = one mailbox).
3. Enqueue one sync job per due mailbox.

```ts
export async function enqueueDuePeriodicSyncs(now: Date = new Date()): Promise<number> {
  // Push the due-time filter into SQL: only mailboxes whose
  // (lastSyncAt + autoSyncIntervalMinutes minutes) <= now.
  // NULL lastSyncAt means "never synced" → always due.
  const dueMailboxes = await prisma.$queryRaw<
    { id: string; shop: string }[]
  >`
    SELECT id, shop
    FROM "MailConnection"
    WHERE "autoSyncEnabled" = true
      AND ("lastSyncAt" IS NULL OR "lastSyncAt" + ("autoSyncIntervalMinutes" * INTERVAL '1 minute') <= ${now})
  `;

  let enqueued = 0;
  for (const m of dueMailboxes) {
    // Skip if there's already a pending or running sync for this mailbox.
    const existing = await prisma.syncJob.count({
      where: {
        mailConnectionId: m.id,
        kind: "sync",
        status: { in: ["pending", "running"] },
      },
    });
    if (existing > 0) continue;

    await enqueueJob({ shop: m.shop, kind: "sync", mailConnectionId: m.id });
    enqueued++;
  }
  return enqueued;
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | grep "auto-sync.ts"
```

- [ ] **Step 4: Commit**

```bash
git add app/lib/mail/auto-sync.ts
git commit -m "refactor(auto-sync): per-mailbox enqueue + SQL due-time filter (resolves DB-M5)"
```

### Task 3.4: Per-mailbox concurrency in `claimNextJob` with per-shop cap

**Files:**
- Modify: `app/lib/mail/job-queue.ts` (`claimNextJob`)
- Modify: `app/lib/mail/auto-sync.ts` (the `drainJobQueue` loop reads `JOB_LOCK_GRANULARITY` env)

- [ ] **Step 1: Find `claimNextJob`**

```bash
grep -n "claimNextJob\|FOR UPDATE SKIP LOCKED" app/lib/mail/job-queue.ts
```

- [ ] **Step 2: Update the SQL claim**

Replace the claim query so it:
1. Filters out jobs whose `mailConnectionId` is already running (instead of filtering by shop).
2. Applies a per-shop cap: skip jobs of shops whose running job count is already >= plan limit. For v1 we approximate the cap by joining on `ShopFlag` to read `currentPlanId`, then resolve the limit from a hardcoded map (Trial 3 / Starter 1 / Pro 3 / internal Infinity).

The simplest implementation: maintain in-memory the set of running `(shop, mailConnectionId)` plus a per-shop running count, then build the SQL excluding the running mailboxes:

```ts
type RunningSet = {
  mailConnectionIds: Set<string>;
  perShopCount: Map<string, number>;
};

export async function claimNextJob(running: RunningSet): Promise<SyncJob | null> {
  const lockGranularity = process.env.JOB_LOCK_GRANULARITY === "shop" ? "shop" : "mailbox";

  // Build the exclusion list. With granularity=mailbox we exclude individual
  // mailbox ids; with granularity=shop we exclude every shop that has a running
  // job (legacy behaviour).
  const excludedMailboxIds = Array.from(running.mailConnectionIds);
  const shopsAtCap = lockGranularity === "mailbox"
    ? shopsThatReachedTheirCap(running.perShopCount)
    : Array.from(running.perShopCount.keys());

  const rows = await prisma.$queryRaw<SyncJob[]>`
    SELECT * FROM "SyncJob"
    WHERE status = 'pending'
      AND ("mailConnectionId" IS NULL OR "mailConnectionId" NOT IN (${Prisma.join(excludedMailboxIds.length > 0 ? excludedMailboxIds : ["__none__"])}))
      AND shop NOT IN (${Prisma.join(shopsAtCap.length > 0 ? shopsAtCap : ["__none__"])})
      AND ("scheduledAt" IS NULL OR "scheduledAt" <= NOW())
    ORDER BY "createdAt" ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `;
  // ... rest unchanged (mark status='running', set startedAt, etc.)
}

function shopsThatReachedTheirCap(perShopCount: Map<string, number>): string[] {
  // We don't have plan info in-memory; defer the precise cap to a follow-up.
  // For v1 we cap at `Math.max(maxPlanLimit, 3)` per shop, which equals the
  // Pro limit and is safe for Trial too. Starter shops can only ever have 1
  // mailbox connected anyway, so the cap is trivially observed.
  const HARD_CAP_PER_SHOP = 3;
  const result: string[] = [];
  for (const [shop, count] of perShopCount) {
    if (count >= HARD_CAP_PER_SHOP) result.push(shop);
  }
  return result;
}
```

- [ ] **Step 3: Update `drainJobQueue` in `auto-sync.ts`**

Find the running-set bookkeeping in `drainJobQueue` (`auto-sync.ts`). It currently maintains a `runningShops: Set<string>`. Replace with:

```ts
const running: RunningSet = {
  mailConnectionIds: new Set<string>(),
  perShopCount: new Map<string, number>(),
};
```

When a job is claimed: if `job.mailConnectionId` is not null, add it to `running.mailConnectionIds`; increment `running.perShopCount.get(job.shop) ?? 0`.

When a job finishes: remove from both.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck 2>&1 | grep -E "auto-sync|job-queue"
```

- [ ] **Step 5: Commit**

```bash
git add app/lib/mail/job-queue.ts app/lib/mail/auto-sync.ts
git commit -m "refactor(job-queue): per-mailbox lock with per-shop cap; honour JOB_LOCK_GRANULARITY"
```

### Task 3.5: Race-safe `resolveCanonicalThread` (transaction wrap, FK error catch)

**Files:**
- Modify: `app/lib/mail/thread-resolver.ts`
- Modify: any caller that wraps the resolver call (typically `pipeline.ts`)

- [ ] **Step 1: Find the current resolver**

```bash
grep -n "export async function resolveCanonicalThread" app/lib/mail/thread-resolver.ts
```

- [ ] **Step 2: Add `mailConnectionId` to the input**

The `ResolveThreadInput` interface needs `mailConnectionId`. Update:

```ts
export interface ResolveThreadInput {
  shop: string;
  mailConnectionId: string;        // NEW
  provider: string;
  providerThreadId: string;
  externalMessageId: string;
  subject: string;
  receivedAt: Date;
  rfcMessageId?: string;
  inReplyTo?: string;
  rfcReferences?: string;
}
```

- [ ] **Step 3: Pass it through to `Thread.create`**

Find the `db.thread.create({ data: { shop, provider, ... } })` block and add `mailConnectionId: input.mailConnectionId`:

```ts
const thread = await db.thread.create({
  data: {
    shop,
    mailConnectionId: input.mailConnectionId,   // NEW
    provider,
    // ... existing fields
  },
  select: { id: true },
});
```

- [ ] **Step 4: Catch FK violation as "mailbox disconnected mid-ingest"**

In the catch block at the end of `resolveCanonicalThread`, add a P2003 check (foreign key violation):

```ts
} catch (err) {
  if (err instanceof PrismaNS.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      // Existing unique-conflict path — same as today.
      // ...
    }
    if (err.code === "P2003") {
      // Foreign key violation — mailConnectionId no longer exists.
      // The mailbox was disconnected concurrently with this ingest.
      console.warn(
        `[resolver] mailbox ${input.mailConnectionId} disconnected mid-ingest for shop=${shop}`,
      );
      throw new MailboxGoneError(input.mailConnectionId);
    }
  }
  throw err;
}
```

Add at the top of the file:

```ts
export class MailboxGoneError extends Error {
  constructor(public readonly mailConnectionId: string) {
    super(`Mailbox ${mailConnectionId} no longer exists`);
    this.name = "MailboxGoneError";
  }
}
```

- [ ] **Step 5: Catch `MailboxGoneError` in the pipeline caller**

In `app/lib/gmail/pipeline.ts` (and equivalent Zoho/Outlook ingestion paths), wrap each per-message resolver call:

```ts
try {
  const resolved = await resolveCanonicalThread(input);
  // ...
} catch (err) {
  if (err instanceof MailboxGoneError) {
    console.warn(`[pipeline] skipping message — mailbox gone: ${err.mailConnectionId}`);
    continue;   // skip this message, continue with the batch
  }
  throw err;
}
```

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck 2>&1 | grep -E "thread-resolver|pipeline"
```

- [ ] **Step 7: Commit**

```bash
git add app/lib/mail/thread-resolver.ts app/lib/gmail/pipeline.ts
git commit -m "fix(resolver): race-safe Thread.create with FK violation catch (MailboxGoneError)"
```

### Task 3.6: Mailbox-scoped outgoing detection

**Files:**
- Modify: `app/lib/mail/outgoing-detection.ts`

- [ ] **Step 1: Find the current implementation**

```bash
grep -n "outgoingAliases\|isOutgoing\|detectOutgoing" app/lib/mail/outgoing-detection.ts
```

- [ ] **Step 2: Update the function signature**

Change the function to accept the `MailConnection` whose mailbox received the mail, not the shop:

```ts
export function isOutgoingMessage(
  fromAddress: string,
  connection: { outgoingAliases: string },
): boolean {
  if (!fromAddress) return false;
  let aliases: string[];
  try {
    aliases = JSON.parse(connection.outgoingAliases) as string[];
  } catch {
    return false;
  }
  const normalized = fromAddress.trim().toLowerCase();
  return aliases.some((a) => a.trim().toLowerCase() === normalized);
}
```

- [ ] **Step 3: Update all call sites**

```bash
grep -rn "isOutgoingMessage\|detectOutgoing" app/lib/
```

For each call site, replace the shop-level lookup with the connection of the mailbox currently being synced. The ingestion pipeline already has the `connection` in scope (it's the mailbox we're syncing).

Example call site update in pipeline:

```ts
// Before:
const isOutgoing = await isOutgoingMessage(msg.from, shop);
// After:
const isOutgoing = isOutgoingMessage(msg.from, connection);
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck 2>&1 | grep "outgoing-detection\|isOutgoing"
```

- [ ] **Step 5: Commit**

```bash
git add app/lib/mail/outgoing-detection.ts app/lib/gmail/pipeline.ts
git add -p  # any other call sites
git commit -m "refactor(outgoing-detection): mailbox-scoped alias match"
```

---

## Phase 4 — Backend refactor: `where: { shop }` audit

Goal: every query that returns mailbox-scoped data (Thread, IncomingEmail) gains a `mailConnectionId` filter when it should be limited to one mailbox, and is verified to still be correct when it's intentionally aggregating across mailboxes of a shop.

### Task 4.1: Audit and tag every `where: { shop }` site

**Files:** none directly (produces a tracking document)

- [ ] **Step 1: Generate the audit list**

```bash
grep -rn "where:\s*{\s*shop" app/lib/ app/routes/ > /tmp/shop-queries.txt
wc -l /tmp/shop-queries.txt
```
Expected: ~130 lines.

- [ ] **Step 2: Classify each entry**

Go through `/tmp/shop-queries.txt` and tag each entry as one of:
- **MAILBOX-SCOPED**: should add `mailConnectionId` filter (most Thread / IncomingEmail queries in inbox, support helpers).
- **SHOP-WIDE intentional**: stays as-is (billing, entitlements, dashboard aggregates, GDPR webhooks, recompute jobs).
- **AMBIGUOUS**: read the surrounding code to decide.

Create `docs/superpowers/plans/2026-05-23-multi-mailbox-audit.md` with one line per entry:

```
- app/lib/dashboard-stats.ts:138  getCurrentThreadStates  SHOP-WIDE   (dashboard aggregate, optional filter via param)
- app/lib/dashboard-stats.ts:194  _fetchResponseTimesMs   SHOP-WIDE   (same)
- app/lib/mail/backfill.ts:139    runOpportunistic...     MAILBOX     (per-mailbox sync state)
- ...
```

- [ ] **Step 3: Commit the audit doc**

```bash
git add docs/superpowers/plans/2026-05-23-multi-mailbox-audit.md
git commit -m "docs(plan): audit of where:{shop} sites for multi-mailbox refactor"
```

### Task 4.2: Update `app/lib/dashboard-stats.ts` — every helper takes optional `mailConnectionId`

**Files:**
- Modify: `app/lib/dashboard-stats.ts` (every public helper)

- [ ] **Step 1: Pattern — add optional param + propagate to WHERE**

For each helper (`getCurrentThreadStates`, `_fetchResponseTimesMs`, `getResponseTimeDailyBreakdown`, `getDraftUsageDailyBreakdown`, `getHeatmap`, `getTopIntentsWithPerf`, `getReopenedThreads`, `getAlerts`, `getDashboardKpis`):

Change signature from `(shop: string, start, end, ...)` to `(shop: string, start, end, ..., mailConnectionId?: string)`. Inside, add `AND "mailConnectionId" = ${mailConnectionId}` when the param is provided. For Prisma-builder queries, add `mailConnectionId: { equals: mailConnectionId }` conditionally.

Concrete example for `getCurrentThreadStates`:

```ts
export async function getCurrentThreadStates(
  shop: string,
  mailConnectionId?: string,
): Promise<ThreadStateCounts> {
  const rows = await prisma.thread.groupBy({
    by: ["operationalState"],
    where: {
      shop,
      supportNature: { not: "non_support" },
      messages: { some: {} },
      ...(mailConnectionId ? { mailConnectionId } : {}),
    },
    _count: { _all: true },
  });
  // ... unchanged
}
```

For raw SQL helpers, use `Prisma.sql` to conditionally append:

```ts
const filterMC = mailConnectionId
  ? Prisma.sql`AND t."mailConnectionId" = ${mailConnectionId}`
  : Prisma.empty;

const rows = await prisma.$queryRaw<...>`
  SELECT ...
  FROM "Thread" t
  WHERE t.shop = ${shop}
    ${filterMC}
    AND ...
`;
```

- [ ] **Step 2: Apply the pattern to every helper in the file**

Read the file from top to bottom and update each export. List of helpers to update (based on a grep of `export async function` at the time of writing):

```
getCurrentThreadStates
getResponseTimeStats          (uses _fetchResponseTimesMs)
getResponseTimeDailyBreakdown
getDraftUsageDailyBreakdown
getHeatmap
getTopIntentsWithPerf
getReopenedThreads
getAlerts
getDashboardKpis              (calls the others; propagate param)
```

For each, the change is mechanical: add `mailConnectionId?: string` to the signature (after the period params), thread it through to the WHERE clause.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | grep "dashboard-stats"
```

- [ ] **Step 4: Commit**

```bash
git add app/lib/dashboard-stats.ts
git commit -m "refactor(dashboard-stats): every helper accepts optional mailConnectionId filter"
```

### Task 4.3: Update inbox loader — mailbox filter parameter

**Files:**
- Modify: `app/routes/app.inbox.tsx` (loader)

- [ ] **Step 1: Read the loader's query block**

```bash
grep -n "loader\|prisma.thread\|prisma.incomingEmail" app/routes/app.inbox.tsx | head -30
```

- [ ] **Step 2: Add mailbox filter parsing**

In the loader, just after reading the search params, add:

```ts
const mailConnectionId = url.searchParams.get("mailbox") || undefined;
```

- [ ] **Step 3: Propagate to the email/thread queries**

Find the main `prisma.incomingEmail.findMany({ where: { shop, ... } })` block. Add:

```ts
where: {
  shop,
  ...(mailConnectionId ? { mailConnectionId } : {}),
  // ... existing filters
},
```

Same for the `prisma.thread` queries in the loader (and the `analyzedPerThread` count query).

- [ ] **Step 4: Return mailbox metadata to the UI**

After loading, also fetch:

```ts
const connections = await prisma.mailConnection.findMany({
  where: { shop },
  select: {
    id: true,
    email: true,
    provider: true,
    autoSyncEnabled: true,
    lastSyncError: true,
    lastSyncAt: true,
  },
});

// Counts per connection (cheap)
const threadCountsRaw = await prisma.thread.groupBy({
  by: ["mailConnectionId"],
  where: { shop, messages: { some: {} }, supportNature: { not: "non_support" } },
  _count: { _all: true },
});
const threadCountsByMailbox = Object.fromEntries(
  threadCountsRaw.map((r) => [r.mailConnectionId, r._count._all]),
);
```

Include `connections, threadCountsByMailbox, mailConnectionId` in the loader's return.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck 2>&1 | grep "app.inbox.tsx"
```
Pre-existing errors in this file are OK (tracked in TECHNICAL_DEBT.md). Only new errors related to our change need fixing.

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat(inbox): loader reads ?mailbox= filter + returns per-mailbox counts"
```

### Task 4.4: Update `app/lib/support/inbox-actions.ts` — handleResync per-mailbox

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`

- [ ] **Step 1: Find handleResync**

```bash
grep -n "export async function handle" app/lib/support/inbox-actions.ts
```

- [ ] **Step 2: Update handleResync to per-mailbox**

```ts
export async function handleResync(params: {
  shop: string;
  mailConnectionId: string;
}) {
  const { shop, mailConnectionId } = params;
  console.warn(
    `[audit] resync shop=${shop} mailConnectionId=${mailConnectionId} action=delete-incoming-emails-and-reset-cursor`,
  );

  // Snapshot manual overrides for this mailbox's threads only.
  // (snapshotManualOverridesForShop already filters by shop; tighten to mailbox.)
  try {
    const { snapshotManualOverridesForMailbox } = await import("./preserved-overrides");
    const n = await snapshotManualOverridesForMailbox(shop, mailConnectionId);
    if (n > 0) console.log(`[resync] snapshotted ${n} thread overrides for mailbox=${mailConnectionId}`);
  } catch (err) {
    console.error("[resync] snapshot failed:", err);
  }

  // Wipe IncomingEmail for this mailbox only.
  await prisma.incomingEmail.deleteMany({ where: { shop, mailConnectionId } });

  // Reset cursor on the connection.
  await prisma.mailConnection.update({
    where: { id: mailConnectionId },
    data: {
      historyId: null,
      deltaToken: null,
      lastSyncAt: null,
      onboardingBackfillDoneAt: null,
    },
  });

  // Re-enqueue a resync job for this mailbox.
  await enqueueJob({ shop, kind: "resync", mailConnectionId });

  return { syncStarted: true, report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
}
```

- [ ] **Step 3: Add `snapshotManualOverridesForMailbox` to preserved-overrides**

Open `app/lib/support/preserved-overrides.ts`. Add a new exported variant alongside the existing shop-scoped one:

```ts
export async function snapshotManualOverridesForMailbox(
  shop: string,
  mailConnectionId: string,
): Promise<number> {
  const rows = await prisma.incomingEmail.findMany({
    where: {
      shop,
      mailConnectionId,
      analysisResult: { not: null },
      canonicalThreadId: { not: null },
    },
    orderBy: { receivedAt: "desc" },
    select: { canonicalThreadId: true, analysisResult: true },
  });
  // ... same body as snapshotManualOverridesForShop
}
```

Or, refactor `snapshotManualOverridesForShop` to take an optional `mailConnectionId` and have the per-shop version call it with `undefined`. Either approach is acceptable; the variant approach is simpler to read.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck 2>&1 | grep -E "inbox-actions|preserved-overrides"
```

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/inbox-actions.ts app/lib/support/preserved-overrides.ts
git commit -m "refactor(resync): scope handleResync to one mailbox"
```

### Task 4.5: Update `app/lib/support/inbox-actions.ts` — handleSync and handleBackfill per-mailbox

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`

- [ ] **Step 1: Update handleSync**

`handleSync` currently calls `processNewEmails(shop, admin, ...)`. Update it to iterate over all mailboxes of the shop OR to take a specific mailbox:

```ts
export async function handleSync(params: {
  shop: string;
  admin: AdminGraphqlClient;
  mailConnectionId?: string;   // if provided, sync only that mailbox; otherwise sync all
}) {
  const { shop, admin, mailConnectionId } = params;
  const ent = await resolveEntitlements({ shop, admin });
  const tier3Allowed = !ent.isSyncSuspended;

  const connections = mailConnectionId
    ? await prisma.mailConnection.findMany({ where: { shop, id: mailConnectionId } })
    : await prisma.mailConnection.findMany({ where: { shop, autoSyncEnabled: true } });

  let report = null as Awaited<ReturnType<typeof processNewEmails>> | null;
  let syncError: string | null = null;
  for (const connection of connections) {
    try {
      const r = await processNewEmails(shop, admin, { tier3Allowed, connection });
      // Merge reports if syncing multiple mailboxes
      report = report
        ? { processed: (report.processed ?? 0) + (r.processed ?? 0), errors: [...(report.errors ?? []), ...(r.errors ?? [])] } as typeof report
        : r;
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
      break;
    }
  }
  // ... rest unchanged (staleRefresh, return shape)
}
```

- [ ] **Step 2: Update `processNewEmails` signature in `app/lib/gmail/pipeline.ts`**

Find `export async function processNewEmails`:

```bash
grep -n "export async function processNewEmails" app/lib/gmail/pipeline.ts
```

Replace signature to accept `connection` instead of resolving by shop+provider internally:

```ts
export async function processNewEmails(
  shop: string,
  admin: AdminGraphqlClient,
  opts: { tier3Allowed: boolean; connection: MailConnection },
): Promise<ProcessReport> {
  const client = await getMailClient(opts.connection);
  // ... use opts.connection wherever the function previously fetched MailConnection by shop
}
```

- [ ] **Step 3: Update `handleBackfill`**

```ts
export async function handleBackfill(params: {
  shop: string;
  mailConnectionId: string;
  days: number;
}) {
  const afterDate = new Date(Date.now() - Math.max(1, params.days) * 24 * 3600_000);
  await enqueueJob({
    shop: params.shop,
    kind: "backfill",
    mailConnectionId: params.mailConnectionId,
    params: { afterDateIso: afterDate.toISOString() },
  });
  return { syncStarted: true, report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
}
```

- [ ] **Step 4: Update `handleToggleAutoSync`**

```ts
export async function handleToggleAutoSync(params: {
  shop: string;
  mailConnectionId: string;
  enable: boolean;
}) {
  await prisma.mailConnection.update({
    where: { id: params.mailConnectionId, shop: params.shop },
    data: { autoSyncEnabled: params.enable },
  });
  return { report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
}
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck 2>&1 | grep -E "inbox-actions|pipeline"
```

- [ ] **Step 6: Commit**

```bash
git add app/lib/support/inbox-actions.ts app/lib/gmail/pipeline.ts
git commit -m "refactor(actions): handleSync/handleBackfill/handleToggleAutoSync per-mailbox"
```

### Task 4.6: Update remaining MAILBOX-tagged queries from the audit

**Files:**
- Modify: any file flagged MAILBOX in the audit (Task 4.1) that has not yet been touched

- [ ] **Step 1: Iterate through the audit doc**

Open `docs/superpowers/plans/2026-05-23-multi-mailbox-audit.md` and process every entry tagged MAILBOX that hasn't been resolved by Tasks 4.2-4.5.

- [ ] **Step 2: Pattern for each**

For each entry, the change is:
- Add `mailConnectionId: string` to the function signature (or `mailConnectionId?: string` if the caller has flexibility).
- Add `mailConnectionId` to the `where` clause.
- Update callers to pass the value.

Files likely to need updates (non-exhaustive):
- `app/lib/mail/backfill.ts`
- `app/lib/support/refresh-thread-analysis.ts`
- `app/lib/support/refresh-stale-analyses.ts`
- `app/lib/support/thread-state.ts` (recomputeThreadState is per-thread → already mailbox-scoped via the thread)
- `app/lib/support/manual-classification.ts`

- [ ] **Step 3: After each file, typecheck that file**

```bash
npm run typecheck 2>&1 | grep <file>
```

- [ ] **Step 4: Commit at logical boundaries**

Group commits by module (e.g., one commit for `app/lib/mail/`, one for `app/lib/support/`):

```bash
git add app/lib/mail/backfill.ts
git commit -m "refactor(backfill): scope all queries by mailConnectionId"
```

```bash
git add app/lib/support/refresh-thread-analysis.ts app/lib/support/refresh-stale-analyses.ts
git commit -m "refactor(support-refresh): pass mailConnectionId through refresh helpers"
```

### Task 4.7: Verify the audit is complete

**Files:** none

- [ ] **Step 1: Re-run the audit**

```bash
grep -rn "where:\s*{\s*shop" app/lib/ app/routes/ > /tmp/shop-queries-after.txt
diff /tmp/shop-queries.txt /tmp/shop-queries-after.txt
```

Verify every entry remaining is intentionally shop-wide (matches your audit doc's SHOP-WIDE tagging).

- [ ] **Step 2: Typecheck the whole project**

```bash
npm run typecheck 2>&1 | grep -E "error TS" | wc -l
```
Expected: number is at or below the baseline at end of Task 1.3. Pre-existing errors (in `app.inbox.tsx`, etc.) are OK.

- [ ] **Step 3: Commit nothing (verification only)**

---

## Phase 5 — Integration tests: cross-mailbox-same-shop isolation (high-priority)

This is the test category that catches the highest-risk refactor bug class: a `where: { shop }` that forgot to add `mailConnectionId` and silently leaks data between mailboxes of the same shop.

### Task 5.1: Test helpers — multi-mailbox seeders

**Files:**
- Modify: `app/lib/__tests__/integration/helpers/db.ts`

- [ ] **Step 1: Add seeders**

Add helper functions at the bottom of `db.ts`:

```ts
export async function seedMailConnection(opts: {
  shop?: string;
  email?: string;
  provider?: string;
  id?: string;
}): Promise<MailConnection> {
  return prisma.mailConnection.create({
    data: {
      id: opts.id,
      shop: opts.shop ?? TEST_SHOP,
      email: opts.email ?? `box-${Math.random().toString(36).slice(2, 8)}@brand.com`,
      provider: opts.provider ?? "gmail",
      accessToken: "test-access",
      refreshToken: "test-refresh",
      tokenExpiry: new Date(Date.now() + 3600_000),
    },
  });
}

export async function seedThread(opts: {
  shop: string;
  mailConnectionId: string;
  receivedAt?: Date;
  supportNature?: string;
  operationalState?: string;
}): Promise<Thread> {
  const now = opts.receivedAt ?? new Date();
  return prisma.thread.create({
    data: {
      shop: opts.shop,
      mailConnectionId: opts.mailConnectionId,
      provider: "gmail",
      firstMessageAt: now,
      lastMessageAt: now,
      supportNature: opts.supportNature ?? "confirmed_support",
      operationalState: opts.operationalState ?? "open",
    },
  });
}

export async function seedIncomingEmail(opts: {
  shop: string;
  mailConnectionId: string;
  canonicalThreadId: string;
  receivedAt?: Date;
}): Promise<IncomingEmail> {
  return prisma.incomingEmail.create({
    data: {
      shop: opts.shop,
      mailConnectionId: opts.mailConnectionId,
      canonicalThreadId: opts.canonicalThreadId,
      provider: "gmail",
      externalMessageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
      threadId: `t-${Math.random().toString(36).slice(2, 8)}`,
      receivedAt: opts.receivedAt ?? new Date(),
      processingStatus: "ingested",
      fromAddress: "customer@example.com",
      subject: "Test subject",
      bodyText: "Test body",
      bodyHtml: "<p>Test body</p>",
    },
  });
}
```

- [ ] **Step 2: Typecheck the helpers**

```bash
npm run typecheck 2>&1 | grep "helpers/db.ts"
```

- [ ] **Step 3: Commit**

```bash
git add app/lib/__tests__/integration/helpers/db.ts
git commit -m "test(helpers): seedMailConnection/Thread/IncomingEmail multi-mailbox seeders"
```

### Task 5.2: Cross-mailbox isolation tests

**Files:**
- Create: `app/lib/__tests__/integration/multi-mailbox-isolation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import {
  resetTestDb, TEST_SHOP,
  seedMailConnection, seedThread, seedIncomingEmail,
} from "./helpers/db";
import { getCurrentThreadStates } from "../../dashboard-stats";

describe("multi-mailbox isolation within the same shop", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("getCurrentThreadStates with mailConnectionId returns only that mailbox's threads", async () => {
    const mcA = await seedMailConnection({ email: "support@brand.com" });
    const mcB = await seedMailConnection({ email: "returns@brand.com" });

    // Mailbox A: 2 open threads
    const tA1 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id, operationalState: "open" });
    const tA2 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id, operationalState: "open" });
    // Mailbox B: 3 waiting_customer threads
    const tB1 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id, operationalState: "waiting_customer" });
    const tB2 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id, operationalState: "waiting_customer" });
    const tB3 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id, operationalState: "waiting_customer" });

    // Attach a message to each so they pass the messages:{some:{}} filter
    for (const t of [tA1, tA2, tB1, tB2, tB3]) {
      await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: t.mailConnectionId, canonicalThreadId: t.id });
    }

    // Aggregated: 2 open + 3 waiting_customer
    const all = await getCurrentThreadStates(TEST_SHOP);
    expect(all.open).toBe(2);
    expect(all.waiting_customer).toBe(3);

    // Filtered by mailbox A: 2 open, 0 waiting_customer
    const onlyA = await getCurrentThreadStates(TEST_SHOP, mcA.id);
    expect(onlyA.open).toBe(2);
    expect(onlyA.waiting_customer).toBe(0);

    // Filtered by mailbox B: 0 open, 3 waiting_customer
    const onlyB = await getCurrentThreadStates(TEST_SHOP, mcB.id);
    expect(onlyB.open).toBe(0);
    expect(onlyB.waiting_customer).toBe(3);
  });

  it("inbox thread query with mailConnectionId returns only that mailbox's threads", async () => {
    const mcA = await seedMailConnection({ email: "support@brand.com" });
    const mcB = await seedMailConnection({ email: "returns@brand.com" });

    const tA = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id });
    const tB = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id });

    const onlyA = await prisma.thread.findMany({
      where: { shop: TEST_SHOP, mailConnectionId: mcA.id },
    });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].id).toBe(tA.id);
  });

  it("Email count by mailbox does not leak across mailboxes", async () => {
    const mcA = await seedMailConnection({ email: "support@brand.com" });
    const mcB = await seedMailConnection({ email: "returns@brand.com" });

    const tA = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id });
    const tB = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id });
    await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: mcA.id, canonicalThreadId: tA.id });
    await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: mcA.id, canonicalThreadId: tA.id });
    await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: mcB.id, canonicalThreadId: tB.id });

    const countA = await prisma.incomingEmail.count({ where: { shop: TEST_SHOP, mailConnectionId: mcA.id } });
    const countB = await prisma.incomingEmail.count({ where: { shop: TEST_SHOP, mailConnectionId: mcB.id } });
    expect(countA).toBe(2);
    expect(countB).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
npm run test:integration -- app/lib/__tests__/integration/multi-mailbox-isolation.test.ts
```
Expected: all three tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/lib/__tests__/integration/multi-mailbox-isolation.test.ts
git commit -m "test(isolation): cross-mailbox isolation within same shop"
```

### Task 5.3: Cross-shop isolation tests with multi-mailbox

**Files:**
- Create: `app/lib/__tests__/integration/multi-mailbox-cross-shop.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import { resetTestDb, TEST_SHOP, seedMailConnection, seedThread, seedIncomingEmail } from "./helpers/db";

const TEST_SHOP_B = "integration-test-b.myshopify.com";

describe("cross-shop isolation with multi-mailbox", () => {
  beforeEach(async () => {
    await resetTestDb();
    // resetTestDb only cleans TEST_SHOP; also clean TEST_SHOP_B
    await prisma.mailConnection.deleteMany({ where: { shop: TEST_SHOP_B } });
  });

  it("different shops can each connect the same email", async () => {
    const mcA = await seedMailConnection({ shop: TEST_SHOP, email: "support@example.com" });
    const mcB = await seedMailConnection({ shop: TEST_SHOP_B, email: "support@example.com" });
    expect(mcA.id).not.toBe(mcB.id);

    const conns = await prisma.mailConnection.findMany({
      where: { email: "support@example.com" },
    });
    expect(conns).toHaveLength(2);
  });

  it("threads of shop A's mailbox are not visible when querying shop B", async () => {
    const mcA = await seedMailConnection({ shop: TEST_SHOP, email: "a@brand.com" });
    const mcB = await seedMailConnection({ shop: TEST_SHOP_B, email: "b@brand.com" });
    await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id });
    await seedThread({ shop: TEST_SHOP_B, mailConnectionId: mcB.id });

    const shopAThreads = await prisma.thread.findMany({ where: { shop: TEST_SHOP } });
    const shopBThreads = await prisma.thread.findMany({ where: { shop: TEST_SHOP_B } });
    expect(shopAThreads).toHaveLength(1);
    expect(shopBThreads).toHaveLength(1);
    expect(shopAThreads[0].mailConnectionId).toBe(mcA.id);
    expect(shopBThreads[0].mailConnectionId).toBe(mcB.id);
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
npm run test:integration -- app/lib/__tests__/integration/multi-mailbox-cross-shop.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/lib/__tests__/integration/multi-mailbox-cross-shop.test.ts
git commit -m "test(isolation): cross-shop isolation with multi-mailbox"
```

### Task 5.4: deleteConnection cascade test

**Files:**
- Create: `app/lib/__tests__/integration/deleteConnection-cascade.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import { resetTestDb, TEST_SHOP, seedMailConnection, seedThread, seedIncomingEmail } from "./helpers/db";
import { deleteConnection } from "../../gmail/auth";

describe("deleteConnection cascade", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("deletes the MailConnection and cascades to Thread + IncomingEmail of that mailbox only", async () => {
    const mcA = await seedMailConnection({ email: "a@brand.com" });
    const mcB = await seedMailConnection({ email: "b@brand.com" });

    const tA = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id });
    const tB = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id });
    await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: mcA.id, canonicalThreadId: tA.id });
    await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: mcB.id, canonicalThreadId: tB.id });

    await deleteConnection({ shop: TEST_SHOP, mailConnectionId: mcA.id });

    expect(await prisma.mailConnection.count({ where: { id: mcA.id } })).toBe(0);
    expect(await prisma.thread.count({ where: { mailConnectionId: mcA.id } })).toBe(0);
    expect(await prisma.incomingEmail.count({ where: { mailConnectionId: mcA.id } })).toBe(0);

    // Mailbox B untouched
    expect(await prisma.mailConnection.count({ where: { id: mcB.id } })).toBe(1);
    expect(await prisma.thread.count({ where: { mailConnectionId: mcB.id } })).toBe(1);
    expect(await prisma.incomingEmail.count({ where: { mailConnectionId: mcB.id } })).toBe(1);
  });

  it("refuses to delete a MailConnection that belongs to another shop", async () => {
    const mcOther = await seedMailConnection({ shop: "other.myshopify.com", email: "x@y.com" });
    await expect(
      deleteConnection({ shop: TEST_SHOP, mailConnectionId: mcOther.id }),
    ).rejects.toThrow();
    expect(await prisma.mailConnection.count({ where: { id: mcOther.id } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run**

```bash
npm run test:integration -- app/lib/__tests__/integration/deleteConnection-cascade.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/lib/__tests__/integration/deleteConnection-cascade.test.ts
git commit -m "test(cascade): deleteConnection cascade + cross-shop refusal"
```

---

## Phase 6 — Billing changes

### Task 6.1: Bump `Trial.maxMailboxes` to 3

**Files:**
- Modify: `app/lib/billing/plans.ts`

- [ ] **Step 1: Edit the trial plan**

In `app/lib/billing/plans.ts`, in the `trial` entry:

```ts
trial: {
  id: 'trial',
  priceUsd: 0,
  analyzedThreadsPerMonth: Infinity,
  maxMailboxes: 3,            // was 1
  advancedDashboard: true,
  dashboardMaxRangeDays: 90,
  durationDays: 14,
},
```

- [ ] **Step 2: Run plan tests**

```bash
npm test -- app/lib/billing/__tests__/plans.test.ts
```
Expected: if there are existing assertions on `maxMailboxes: 1` for trial, update them (Task 6.2). Otherwise PASS.

- [ ] **Step 3: Commit**

```bash
git add app/lib/billing/plans.ts
git commit -m "feat(billing): Trial plan now allows 3 mailboxes (matches Pro)"
```

### Task 6.2: Update existing entitlement tests that asserted Trial=1 mailbox

**Files:**
- Modify: `app/lib/billing/__tests__/plans.test.ts`
- Modify: `app/lib/__tests__/integration/billing-entitlements.test.ts`

- [ ] **Step 1: Search for `maxMailboxes` assertions**

```bash
grep -rn "maxMailboxes\|mailboxStatus" app/lib/billing/__tests__/ app/lib/__tests__/integration/
```

- [ ] **Step 2: Update each test that asserted `limit: 1` for trial**

Change to `limit: 3`.

- [ ] **Step 3: Run**

```bash
npm test -- app/lib/billing/
npm run test:integration -- app/lib/__tests__/integration/billing-entitlements.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/lib/billing/__tests__/ app/lib/__tests__/integration/billing-entitlements.test.ts
git commit -m "test(billing): update trial mailbox limit assertions to 3"
```

### Task 6.3: `downgrade-overflow` helper

**Files:**
- Create: `app/lib/billing/downgrade-overflow.ts`

- [ ] **Step 1: Write the helper**

```ts
import prisma from "../../db.server";
import { getPlan, type PlanId, type PlanDefinition } from "./plans";

export type OverflowSummary = {
  hasOverflow: boolean;
  currentCount: number;
  targetLimit: number;
  toDisconnect: number;     // currentCount - targetLimit (0 if no overflow)
  mailboxes: { id: string; email: string; provider: string }[];
};

export async function computeOverflowForPlanSwitch(opts: {
  shop: string;
  targetPlanId: PlanId;
}): Promise<OverflowSummary> {
  const target: PlanDefinition | null = getPlan(opts.targetPlanId);
  if (!target) throw new Error(`Unknown target plan: ${opts.targetPlanId}`);

  const mailboxes = await prisma.mailConnection.findMany({
    where: { shop: opts.shop },
    select: { id: true, email: true, provider: true },
    orderBy: { createdAt: "asc" },
  });
  const currentCount = mailboxes.length;
  const targetLimit = target.maxMailboxes;
  const hasOverflow = currentCount > targetLimit;
  return {
    hasOverflow,
    currentCount,
    targetLimit,
    toDisconnect: hasOverflow ? currentCount - targetLimit : 0,
    mailboxes,
  };
}

export async function resolveOverflowImmediate(opts: {
  shop: string;
  keepMailConnectionId: string;
  targetPlanId: PlanId;
}): Promise<void> {
  const summary = await computeOverflowForPlanSwitch({
    shop: opts.shop,
    targetPlanId: opts.targetPlanId,
  });
  if (!summary.hasOverflow) return;

  // Validate that keepMailConnectionId belongs to this shop and exists
  const keepIds = summary.mailboxes.map((m) => m.id);
  if (!keepIds.includes(opts.keepMailConnectionId)) {
    throw new Error(`Selected mailbox ${opts.keepMailConnectionId} not found for shop ${opts.shop}`);
  }

  const toDelete = summary.mailboxes.filter((m) => m.id !== opts.keepMailConnectionId);
  // Cascade handles all dependent rows
  for (const m of toDelete) {
    await prisma.mailConnection.delete({ where: { id: m.id, shop: opts.shop } });
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck 2>&1 | grep "downgrade-overflow"
```

- [ ] **Step 3: Commit**

```bash
git add app/lib/billing/downgrade-overflow.ts
git commit -m "feat(billing): downgrade-overflow helper (detect + resolve)"
```

### Task 6.4: `downgrade-overflow` tests

**Files:**
- Create: `app/lib/billing/__tests__/downgrade-overflow.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import { resetTestDb, TEST_SHOP, seedMailConnection } from "../../__tests__/integration/helpers/db";
import { computeOverflowForPlanSwitch, resolveOverflowImmediate } from "../downgrade-overflow";

describe("downgrade-overflow", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("returns hasOverflow=false when current = target", async () => {
    await seedMailConnection({ email: "a@b.com" });
    const r = await computeOverflowForPlanSwitch({ shop: TEST_SHOP, targetPlanId: "starter" });
    expect(r.hasOverflow).toBe(false);
    expect(r.toDisconnect).toBe(0);
  });

  it("returns hasOverflow=true when downgrading Pro(3) → Starter(1) with 3 mailboxes", async () => {
    await seedMailConnection({ email: "a@b.com" });
    await seedMailConnection({ email: "b@b.com" });
    await seedMailConnection({ email: "c@b.com" });
    const r = await computeOverflowForPlanSwitch({ shop: TEST_SHOP, targetPlanId: "starter" });
    expect(r.hasOverflow).toBe(true);
    expect(r.toDisconnect).toBe(2);
    expect(r.targetLimit).toBe(1);
    expect(r.currentCount).toBe(3);
  });

  it("resolveOverflowImmediate deletes all but the kept mailbox", async () => {
    const a = await seedMailConnection({ email: "a@b.com" });
    const b = await seedMailConnection({ email: "b@b.com" });
    const c = await seedMailConnection({ email: "c@b.com" });
    await resolveOverflowImmediate({
      shop: TEST_SHOP,
      keepMailConnectionId: b.id,
      targetPlanId: "starter",
    });
    const remaining = await prisma.mailConnection.findMany({ where: { shop: TEST_SHOP } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(b.id);
  });

  it("resolveOverflowImmediate refuses to keep a mailbox from another shop", async () => {
    await seedMailConnection({ email: "a@b.com" });
    const other = await seedMailConnection({ shop: "other.myshopify.com", email: "x@y.com" });
    await expect(
      resolveOverflowImmediate({
        shop: TEST_SHOP,
        keepMailConnectionId: other.id,
        targetPlanId: "starter",
      }),
    ).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run**

```bash
npm run test:integration -- app/lib/billing/__tests__/downgrade-overflow.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/lib/billing/__tests__/downgrade-overflow.test.ts
git commit -m "test(billing): downgrade-overflow helper"
```

### Task 6.5: Soft-pause helper for scheduled downgrades

**Files:**
- Create: `app/lib/billing/soft-pause.ts`
- Create: `app/lib/billing/__tests__/soft-pause.test.ts`

- [ ] **Step 1: Write the helper**

```ts
import prisma from "../../db.server";
import { getPlan, type PlanId } from "./plans";

/**
 * Detect whether the shop currently has more mailboxes than its active plan
 * allows. If so, set autoSyncEnabled=false on ALL mailboxes (no arbitrary
 * choice). Idempotent — calling twice is a no-op.
 *
 * Returns the number of mailboxes that got paused (0 if no overflow or
 * already paused).
 */
export async function applySoftPauseIfOverflow(opts: {
  shop: string;
  activePlanId: PlanId;
}): Promise<number> {
  const plan = getPlan(opts.activePlanId);
  if (!plan) throw new Error(`Unknown plan: ${opts.activePlanId}`);

  const all = await prisma.mailConnection.findMany({
    where: { shop: opts.shop },
    select: { id: true, autoSyncEnabled: true },
  });
  if (all.length <= plan.maxMailboxes) return 0;

  // Overflow detected. Pause every mailbox that's still active.
  const toPause = all.filter((m) => m.autoSyncEnabled).map((m) => m.id);
  if (toPause.length === 0) return 0;

  await prisma.mailConnection.updateMany({
    where: { shop: opts.shop, id: { in: toPause } },
    data: { autoSyncEnabled: false },
  });
  return toPause.length;
}
```

- [ ] **Step 2: Write tests**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import { resetTestDb, TEST_SHOP, seedMailConnection } from "../../__tests__/integration/helpers/db";
import { applySoftPauseIfOverflow } from "../soft-pause";

describe("soft-pause", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("pauses all mailboxes when current count > plan limit", async () => {
    await seedMailConnection({ email: "a@b.com" });
    await seedMailConnection({ email: "b@b.com" });
    await seedMailConnection({ email: "c@b.com" });
    const n = await applySoftPauseIfOverflow({ shop: TEST_SHOP, activePlanId: "starter" });
    expect(n).toBe(3);
    const all = await prisma.mailConnection.findMany({ where: { shop: TEST_SHOP } });
    expect(all.every((m) => !m.autoSyncEnabled)).toBe(true);
  });

  it("is idempotent — second call pauses 0", async () => {
    await seedMailConnection({ email: "a@b.com" });
    await seedMailConnection({ email: "b@b.com" });
    await applySoftPauseIfOverflow({ shop: TEST_SHOP, activePlanId: "starter" });
    const n = await applySoftPauseIfOverflow({ shop: TEST_SHOP, activePlanId: "starter" });
    expect(n).toBe(0);
  });

  it("does nothing when count <= plan limit", async () => {
    await seedMailConnection({ email: "a@b.com" });
    const n = await applySoftPauseIfOverflow({ shop: TEST_SHOP, activePlanId: "starter" });
    expect(n).toBe(0);
    const all = await prisma.mailConnection.findMany({ where: { shop: TEST_SHOP } });
    expect(all[0].autoSyncEnabled).toBe(true);
  });
});
```

- [ ] **Step 3: Run**

```bash
npm run test:integration -- app/lib/billing/__tests__/soft-pause.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/lib/billing/soft-pause.ts app/lib/billing/__tests__/soft-pause.test.ts
git commit -m "feat(billing): soft-pause helper for scheduled-downgrade effective date"
```

### Task 6.6: Wire soft-pause into the inbox loader

**Files:**
- Modify: `app/routes/app.inbox.tsx` (loader)

- [ ] **Step 1: Call `applySoftPauseIfOverflow` at the top of the loader**

Right after `resolveEntitlements`, add:

```ts
const ent = await resolveEntitlements({ shop, admin });
if (ent.state === "paid_active" || ent.state === "trial_active") {
  // Idempotent — detects whether the shop is currently over its plan limit
  // (could happen after a scheduled downgrade kicks in) and pauses all
  // mailboxes if so.
  const { applySoftPauseIfOverflow } = await import("../lib/billing/soft-pause");
  const paused = await applySoftPauseIfOverflow({ shop, activePlanId: ent.planId });
  if (paused > 0) {
    console.warn(`[inbox] soft-paused ${paused} mailboxes for shop=${shop} (plan=${ent.planId})`);
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck 2>&1 | grep "app.inbox.tsx"
```
Pre-existing errors OK.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat(inbox): apply soft-pause on overflow at loader entry"
```

### Task 6.7: Billing page shows mailbox counter

**Files:**
- Modify: `app/routes/app.billing.tsx`
- Modify: `app/i18n/locales/fr.json` and `en.json`

- [ ] **Step 1: Add i18n keys**

In both locale files, add to the `billing` section:

```json
"mailboxCounter": {
  "label": "Boîtes connectées",
  "value": "{{used}} / {{limit}}",
  "atLimit": "Vous avez atteint la limite de votre plan."
}
```

English equivalent: `"label": "Connected mailboxes"`, `"atLimit": "You have reached your plan limit."`.

- [ ] **Step 2: Surface `mailboxStatus` in the billing page UI**

In `app/routes/app.billing.tsx`, locate where the `analyzedThreads` counter is rendered. Adjacent to it, render a similar counter using `entitlements.mailboxStatus.used / .limit`. Use `t("billing.mailboxCounter.label")` and the value format.

- [ ] **Step 3: Test in browser**

Run dev server:
```bash
npm run dev
```
Open the test shop, navigate to `/app/billing`. Verify the new counter renders.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.billing.tsx app/i18n/locales/
git commit -m "feat(billing-page): display mailbox counter alongside quota counter"
```

### Task 6.8: Downgrade interceptor on `/app/billing` action

**Files:**
- Modify: `app/routes/app.billing.tsx` (action)

- [ ] **Step 1: Find the action handler for plan changes**

```bash
grep -n "appSubscriptionCreate\|targetPlan\|subscribe" app/routes/app.billing.tsx | head
```

- [ ] **Step 2: Intercept downgrades with overflow before calling Shopify Billing**

At the top of the action handler that processes plan changes, after parsing `targetPlanId`:

```ts
import { computeOverflowForPlanSwitch } from "../lib/billing/downgrade-overflow";

// ...

const targetPlanId = String(formData.get("planId") ?? "");
if (targetPlanId === "starter" || targetPlanId === "trial") {
  const overflow = await computeOverflowForPlanSwitch({ shop, targetPlanId });
  if (overflow.hasOverflow) {
    // Redirect to the guided choice screen.
    return redirect(`/app/billing/downgrade/select-mailbox?to=${targetPlanId}`);
  }
}
// ... existing Shopify Billing API call
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | grep "app.billing.tsx"
```

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.billing.tsx
git commit -m "feat(billing): intercept downgrades with mailbox overflow"
```

### Task 6.9: `/app/billing/downgrade/select-mailbox` route

**Files:**
- Create: `app/routes/app.billing.downgrade.select-mailbox.tsx`

- [ ] **Step 1: Write the route**

```tsx
import { json, redirect, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { useLoaderData, Form, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveEntitlements } from "../lib/billing/entitlements";
import {
  computeOverflowForPlanSwitch,
  resolveOverflowImmediate,
} from "../lib/billing/downgrade-overflow";
import { useTranslation } from "react-i18next";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const to = (url.searchParams.get("to") ?? "starter") as "starter" | "trial";

  const ent = await resolveEntitlements({ shop, admin });
  const overflow = await computeOverflowForPlanSwitch({ shop, targetPlanId: to });
  if (!overflow.hasOverflow) {
    return redirect("/app/billing");
  }
  return json({ overflow, targetPlanId: to, entitlements: ent });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const keepId = String(formData.get("keep") ?? "");
  const to = String(formData.get("to") ?? "starter") as "starter" | "trial";

  if (!keepId) return json({ error: "missing_keep" }, { status: 400 });

  await resolveOverflowImmediate({ shop, keepMailConnectionId: keepId, targetPlanId: to });

  // After cleanup, redirect back to /app/billing with the original
  // target plan parameter so the original downgrade flow resumes.
  return redirect(`/app/billing?planId=${to}&downgrade-confirmed=1`);
}

export default function DowngradeSelectMailbox() {
  const { overflow, targetPlanId } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  return (
    <div className="downgrade-select">
      <h1>{t("billing.downgrade.title", { targetPlanId })}</h1>
      <p>{t("billing.downgrade.intro", { current: overflow.currentCount, limit: overflow.targetLimit })}</p>
      <p className="warning">{t("billing.downgrade.warning")}</p>
      <Form method="post">
        <input type="hidden" name="to" value={targetPlanId} />
        {overflow.mailboxes.map((m) => (
          <label key={m.id} className="mailbox-row">
            <input type="radio" name="keep" value={m.id} required />
            <span>📧 {m.email} ({m.provider})</span>
          </label>
        ))}
        <div className="actions">
          <a href="/app/billing">{t("common.cancel")}</a>
          <button type="submit">{t("billing.downgrade.confirm")}</button>
        </div>
      </Form>
    </div>
  );
}
```

- [ ] **Step 2: Add i18n keys**

In `fr.json` and `en.json`, add the `billing.downgrade.*` keys used above. Use vouvoiement for French (e.g., `"Vous avez {{current}} boîtes connectées..."`).

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | grep "downgrade.select-mailbox"
```

- [ ] **Step 4: Test in browser**

```bash
npm run dev
```

On the test shop, seed 3 mailboxes via the helper, then navigate to `/app/billing/downgrade/select-mailbox?to=starter`. Verify the radio selection works and submitting deletes the unselected mailboxes.

- [ ] **Step 5: Commit**

```bash
git add app/routes/app.billing.downgrade.select-mailbox.tsx app/i18n/locales/
git commit -m "feat(billing): guided downgrade screen — pick mailbox to keep"
```

---

## Phase 7 — `/app/connections` page

### Task 7.1: Route + loader

**Files:**
- Create: `app/routes/app.connections.tsx`

- [ ] **Step 1: Write the route**

```tsx
import { json, redirect, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveEntitlements } from "../lib/billing/entitlements";
import prisma from "../db.server";
import {
  handleDisconnect,
  handleToggleAutoSync,
  handleResync,
} from "../lib/support/inbox-actions";
import ConnectionCard from "../components/connections/ConnectionCard";
import AddMailboxModal from "../components/connections/AddMailboxModal";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const ent = await resolveEntitlements({ shop, admin });

  const connections = await prisma.mailConnection.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" },
  });

  // Per-mailbox counts (used in the card metadata)
  const threadCountsRaw = await prisma.thread.groupBy({
    by: ["mailConnectionId"],
    where: { shop },
    _count: { _all: true },
  });
  const threadCountsByMailbox = Object.fromEntries(
    threadCountsRaw.map((r) => [r.mailConnectionId, r._count._all]),
  );
  const draftCountsRaw = await prisma.replyDraft.groupBy({
    by: ["mailConnectionId"],
    where: { shop },
    _count: { _all: true },
  });
  // NOTE: ReplyDraft.mailConnectionId doesn't exist in v1. Substitute the
  // count via a Thread → IncomingEmail → ReplyDraft join, or skip this counter
  // for v1 if it requires a denormalisation. Decision: skip for v1; the card
  // shows only the thread count.
  const draftCountsByMailbox: Record<string, number> = {};

  return json({
    entitlements: ent,
    connections,
    threadCountsByMailbox,
    draftCountsByMailbox,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const mailConnectionId = String(formData.get("mailConnectionId") ?? "");

  if (!mailConnectionId) return json({ error: "missing_mailConnectionId" }, { status: 400 });

  switch (intent) {
    case "disconnect": {
      const expectedEmail = String(formData.get("confirmEmail") ?? "");
      const conn = await prisma.mailConnection.findUnique({
        where: { id: mailConnectionId, shop },
      });
      if (!conn) return json({ error: "not_found" }, { status: 404 });
      if (conn.email !== expectedEmail) {
        return json({ error: "confirmation_mismatch" }, { status: 400 });
      }
      await handleDisconnect({ shop, mailConnectionId });
      return redirect("/app/connections");
    }
    case "toggleAutoSync": {
      const enabled = formData.get("enable") === "true";
      await handleToggleAutoSync({ shop, mailConnectionId, enable: enabled });
      return redirect("/app/connections");
    }
    case "resync": {
      await handleResync({ shop, mailConnectionId });
      return redirect("/app/connections");
    }
    case "reauth": {
      const provider = String(formData.get("provider") ?? "");
      // Redirect to the provider OAuth flow. The callback uses
      // saveConnection's upsert by (shop, email) which automatically
      // updates the existing row.
      return redirect(`/mail-auth/${provider}/start`);
    }
    default:
      return json({ error: "unknown_intent" }, { status: 400 });
  }
}

export default function ConnectionsPage() {
  const { entitlements, connections, threadCountsByMailbox } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="connections-page">
      <header>
        <h1>{t("connections.title")}</h1>
        <p>{t("connections.subtitle", {
          used: entitlements.mailboxStatus.used,
          limit: entitlements.mailboxStatus.limit,
        })}</p>
        <button
          onClick={() => setShowAdd(true)}
          disabled={!entitlements.canConnectMailbox}
        >
          {t("connections.connectMailbox")}
        </button>
      </header>

      {connections.length === 0 ? (
        <div className="empty-state">
          <p>{t("connections.emptyState")}</p>
          <button onClick={() => setShowAdd(true)}>{t("connections.connectFirst")}</button>
        </div>
      ) : (
        <ul>
          {connections.map((c) => (
            <li key={c.id}>
              <ConnectionCard
                connection={c}
                threadCount={threadCountsByMailbox[c.id] ?? 0}
              />
            </li>
          ))}
        </ul>
      )}

      {showAdd && (
        <AddMailboxModal
          onClose={() => setShowAdd(false)}
          canConnect={entitlements.canConnectMailbox}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add i18n keys**

In both `fr.json` and `en.json`, add the `connections.*` keys used above.

- [ ] **Step 3: Add nav entry**

In whichever component renders the main app nav (search for `app.inbox` link), add a new entry pointing to `/app/connections`. Use vouvoiement-safe label: `Connexions` / `Connections`.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck 2>&1 | grep "app.connections.tsx"
```

- [ ] **Step 5: Commit**

```bash
git add app/routes/app.connections.tsx app/i18n/locales/ app/components/  # nav update if applicable
git commit -m "feat(connections): page route + loader + action + nav entry"
```

### Task 7.2: ConnectionCard component

**Files:**
- Create: `app/components/connections/ConnectionCard.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { Form } from "react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MailConnection } from "@prisma/client";
import DisconnectModal from "./DisconnectModal";

export default function ConnectionCard(props: {
  connection: MailConnection;
  threadCount: number;
}) {
  const { connection, threadCount } = props;
  const { t } = useTranslation();
  const [showDisconnect, setShowDisconnect] = useState(false);

  const status = computeStatus(connection);

  return (
    <div className="connection-card" data-status={status}>
      <header>
        <span className="provider-icon">{providerIcon(connection.provider)}</span>
        <span className="email">{connection.email}</span>
        <StatusPill status={status} />
      </header>
      <div className="meta">
        {connection.lastSyncAt && (
          <span>{t("connections.lastSyncAt", { date: connection.lastSyncAt })}</span>
        )}
        {connection.lastSyncError && (
          <span className="error">{connection.lastSyncError}</span>
        )}
        <span>{t("connections.threadCount", { count: threadCount })}</span>
      </div>
      <div className="actions">
        {connection.lastSyncError && (
          <Form method="post">
            <input type="hidden" name="intent" value="reauth" />
            <input type="hidden" name="mailConnectionId" value={connection.id} />
            <input type="hidden" name="provider" value={connection.provider} />
            <button type="submit">{t("connections.reauth")}</button>
          </Form>
        )}
        <Form method="post">
          <input type="hidden" name="intent" value="toggleAutoSync" />
          <input type="hidden" name="mailConnectionId" value={connection.id} />
          <input type="hidden" name="enable" value={connection.autoSyncEnabled ? "false" : "true"} />
          <button type="submit">
            {connection.autoSyncEnabled ? t("connections.pause") : t("connections.resume")}
          </button>
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="resync" />
          <input type="hidden" name="mailConnectionId" value={connection.id} />
          <button type="submit">{t("connections.resync")}</button>
        </Form>
        <button onClick={() => setShowDisconnect(true)} className="danger">
          {t("connections.disconnect")}
        </button>
      </div>
      {showDisconnect && (
        <DisconnectModal
          connection={connection}
          threadCount={threadCount}
          onClose={() => setShowDisconnect(false)}
        />
      )}
    </div>
  );
}

function computeStatus(c: MailConnection): "ok" | "paused" | "error" {
  if (c.lastSyncError) return "error";
  if (!c.autoSyncEnabled) return "paused";
  return "ok";
}

function providerIcon(provider: string): string {
  switch (provider) {
    case "gmail": return "G";
    case "outlook": return "O";
    case "zoho": return "Z";
    default: return "?";
  }
}

function StatusPill({ status }: { status: "ok" | "paused" | "error" }) {
  const { t } = useTranslation();
  const label =
    status === "ok" ? t("connections.statusOk") :
    status === "paused" ? t("connections.statusPaused") :
    t("connections.statusError");
  return <span className={`status-pill status-${status}`}>{label}</span>;
}
```

- [ ] **Step 2: Add CSS**

Create or update the relevant stylesheet for `.connection-card`, `.status-pill`, `.danger` (the project's CSS approach varies — match existing patterns).

- [ ] **Step 3: Commit**

```bash
git add app/components/connections/ConnectionCard.tsx
git commit -m "feat(connections): ConnectionCard component"
```

### Task 7.3: DisconnectModal with anti-misclick confirmation

**Files:**
- Create: `app/components/connections/DisconnectModal.tsx`

- [ ] **Step 1: Write the modal**

```tsx
import { Form } from "react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MailConnection } from "@prisma/client";

export default function DisconnectModal(props: {
  connection: MailConnection;
  threadCount: number;
  onClose: () => void;
}) {
  const { connection, threadCount, onClose } = props;
  const { t } = useTranslation();
  const [confirmText, setConfirmText] = useState("");
  const canSubmit = confirmText === connection.email;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t("connections.disconnectTitle")}</h2>
        <p className="warning">
          {t("connections.disconnectWarning", { threadCount })}
        </p>
        <p>{t("connections.typeEmailToConfirm", { email: connection.email })}</p>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={connection.email}
        />
        <Form method="post">
          <input type="hidden" name="intent" value="disconnect" />
          <input type="hidden" name="mailConnectionId" value={connection.id} />
          <input type="hidden" name="confirmEmail" value={confirmText} />
          <div className="actions">
            <button type="button" onClick={onClose}>{t("common.cancel")}</button>
            <button type="submit" disabled={!canSubmit} className="danger">
              {t("connections.disconnectConfirm")}
            </button>
          </div>
        </Form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/components/connections/DisconnectModal.tsx
git commit -m "feat(connections): DisconnectModal with anti-misclick confirmation"
```

### Task 7.4: AddMailboxModal with provider picker

**Files:**
- Create: `app/components/connections/AddMailboxModal.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useTranslation } from "react-i18next";

export default function AddMailboxModal(props: {
  onClose: () => void;
  canConnect: boolean;
}) {
  const { onClose, canConnect } = props;
  const { t } = useTranslation();

  if (!canConnect) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2>{t("connections.limitReachedTitle")}</h2>
          <p>{t("connections.limitReachedBody")}</p>
          <a href="/app/billing">{t("connections.upgradeCta")}</a>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t("connections.pickProvider")}</h2>
        <div className="provider-grid">
          <a href="/mail-auth/gmail/start" className="provider-tile">
            <span className="logo">G</span>
            <span>Gmail</span>
          </a>
          <a href="/mail-auth/outlook/start" className="provider-tile">
            <span className="logo">O</span>
            <span>Outlook</span>
          </a>
          <a href="/mail-auth/zoho/start" className="provider-tile">
            <span className="logo">Z</span>
            <span>Zoho</span>
          </a>
        </div>
        <button onClick={onClose}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/components/connections/AddMailboxModal.tsx
git commit -m "feat(connections): AddMailboxModal with provider picker"
```

### Task 7.5: SoftPauseBanner shown on `/app/connections` after a scheduled downgrade

**Files:**
- Create: `app/components/connections/SoftPauseBanner.tsx`
- Modify: `app/routes/app.connections.tsx` (render the banner conditionally)

- [ ] **Step 1: Write the banner**

```tsx
import { useTranslation } from "react-i18next";

export default function SoftPauseBanner(props: { pausedCount: number; limit: number }) {
  const { pausedCount, limit } = props;
  const { t } = useTranslation();
  return (
    <div className="soft-pause-banner">
      <span>⚠</span>
      <p>{t("connections.softPauseBanner", { pausedCount, limit })}</p>
    </div>
  );
}
```

- [ ] **Step 2: Conditionally render in connections page**

In the loader, compute `pausedCount = connections.filter((c) => !c.autoSyncEnabled).length`. If `pausedCount > entitlements.mailboxStatus.limit - 1`, the banner shows.

Actually the trigger is: all mailboxes were paused by `applySoftPauseIfOverflow`. Simpler heuristic: `pausedCount > 0 && pausedCount === connections.length`.

In the JSX:

```tsx
{pausedCount > 0 && pausedCount === connections.length && (
  <SoftPauseBanner pausedCount={pausedCount} limit={entitlements.mailboxStatus.limit} />
)}
```

- [ ] **Step 3: Commit**

```bash
git add app/components/connections/SoftPauseBanner.tsx app/routes/app.connections.tsx
git commit -m "feat(connections): SoftPauseBanner shown after scheduled-downgrade soft-pause"
```

---

## Phase 8 — Inbox UX (badge, filter, indicator, paused state)

### Task 8.1: `mailbox-color.ts` deterministic colour helper

**Files:**
- Create: `app/lib/mail/mailbox-color.ts`
- Create: `app/lib/mail/__tests__/mailbox-color.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mailboxColor } from "../mailbox-color";

describe("mailboxColor", () => {
  it("returns the same colour for the same email", () => {
    expect(mailboxColor("support@brand.com")).toBe(mailboxColor("support@brand.com"));
  });
  it("returns different colours for different emails (probabilistically)", () => {
    const a = mailboxColor("support@brand.com");
    const b = mailboxColor("returns@brand.com");
    const c = mailboxColor("shipping@brand.com");
    // Not strictly guaranteed but with our hash + palette they should differ
    expect(new Set([a.bg, b.bg, c.bg]).size).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- app/lib/mail/__tests__/mailbox-color.test.ts
```
Expected: FAIL — `mailboxColor` not defined.

- [ ] **Step 3: Implement**

```ts
export type MailboxColor = { bg: string; fg: string };

const PALETTE: MailboxColor[] = [
  { bg: "#dbeafe", fg: "#1e40af" },  // blue
  { bg: "#fef3c7", fg: "#92400e" },  // amber
  { bg: "#d1fae5", fg: "#065f46" },  // emerald
  { bg: "#fae8ff", fg: "#86198f" },  // fuchsia
  { bg: "#ffe4e6", fg: "#9f1239" },  // rose
  { bg: "#e0e7ff", fg: "#3730a3" },  // indigo
];

export function mailboxColor(email: string): MailboxColor {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 31 + email.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npm test -- app/lib/mail/__tests__/mailbox-color.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/mail/mailbox-color.ts app/lib/mail/__tests__/mailbox-color.test.ts
git commit -m "feat(mailbox-color): deterministic colour palette per mailbox email"
```

### Task 8.2: MailboxBadge component

**Files:**
- Create: `app/components/inbox/MailboxBadge.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { mailboxColor } from "../../lib/mail/mailbox-color";

export default function MailboxBadge(props: {
  email: string;
  provider: string;
  paused?: boolean;
  compact?: boolean;
}) {
  const { email, provider, paused, compact } = props;
  const c = mailboxColor(email);
  const providerLetter = provider === "gmail" ? "G" : provider === "outlook" ? "O" : "Z";
  const providerColor =
    provider === "gmail" ? "#ea4335" :
    provider === "outlook" ? "#0078d4" :
    "#dc2626";
  const localPart = email.split("@")[0];
  return (
    <span
      className="mailbox-badge"
      style={{ background: c.bg, color: c.fg }}
      title={email}
    >
      {!compact && (
        <span className="provider-mark" style={{ background: providerColor }}>
          {providerLetter}
        </span>
      )}
      {paused && <span className="paused-icon">⏸️</span>}
      <span className="email-label">{compact ? `${localPart}@` : email}</span>
    </span>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/components/inbox/MailboxBadge.tsx
git commit -m "feat(inbox): MailboxBadge component"
```

### Task 8.3: MailboxFilter dropdown

**Files:**
- Create: `app/components/inbox/MailboxFilter.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import type { MailConnection } from "@prisma/client";

export default function MailboxFilter(props: {
  connections: Pick<MailConnection, "id" | "email">[];
  countsByMailbox: Record<string, number>;
  totalCount: number;
}) {
  const { connections, countsByMailbox, totalCount } = props;
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();

  if (connections.length <= 1) return null;

  const current = searchParams.get("mailbox") || "";

  return (
    <select
      value={current}
      onChange={(e) => {
        const next = new URLSearchParams(searchParams);
        if (e.target.value) next.set("mailbox", e.target.value);
        else next.delete("mailbox");
        setSearchParams(next);
      }}
    >
      <option value="">{t("inbox.allMailboxes", { count: totalCount })}</option>
      {connections.map((c) => (
        <option key={c.id} value={c.id}>
          {c.email} ({countsByMailbox[c.id] ?? 0})
        </option>
      ))}
    </select>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/components/inbox/MailboxFilter.tsx
git commit -m "feat(inbox): MailboxFilter dropdown"
```

### Task 8.4: MailboxIndicator (header indicator)

**Files:**
- Create: `app/components/inbox/MailboxIndicator.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { MailConnection } from "@prisma/client";

export default function MailboxIndicator(props: {
  connections: Pick<MailConnection, "id" | "lastSyncError">[];
}) {
  const { connections } = props;
  const { t } = useTranslation();
  if (connections.length <= 1) return null;

  const errorCount = connections.filter((c) => c.lastSyncError).length;

  return (
    <Link to="/app/connections" className="mailbox-indicator">
      📥 {t("inbox.mailboxCount", { count: connections.length })}
      {errorCount > 0 && (
        <span className="error-count">· {t("inbox.errorCount", { count: errorCount })}</span>
      )}
      <span>→</span>
    </Link>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/components/inbox/MailboxIndicator.tsx
git commit -m "feat(inbox): MailboxIndicator header link to /app/connections"
```

### Task 8.5: Wire badge/filter/indicator into `app.inbox.tsx`

**Files:**
- Modify: `app/routes/app.inbox.tsx` (render layer)

- [ ] **Step 1: Import the three components**

At the top of the file:

```tsx
import MailboxBadge from "../components/inbox/MailboxBadge";
import MailboxFilter from "../components/inbox/MailboxFilter";
import MailboxIndicator from "../components/inbox/MailboxIndicator";
```

- [ ] **Step 2: Render MailboxIndicator in the inbox header**

Find the existing inbox header. Next to the title, add:

```tsx
<MailboxIndicator connections={loaderData.connections} />
```

- [ ] **Step 3: Render MailboxFilter in the filter row**

Next to the existing status filter and search:

```tsx
<MailboxFilter
  connections={loaderData.connections}
  countsByMailbox={loaderData.threadCountsByMailbox}
  totalCount={Object.values(loaderData.threadCountsByMailbox).reduce((a, b) => a + b, 0)}
/>
```

- [ ] **Step 4: Render MailboxBadge in each thread row**

In the thread list rendering (find the loop that renders each thread/email card), look up the connection by `email.mailConnectionId`:

```tsx
const connection = loaderData.connections.find((c) => c.id === email.mailConnectionId);
{connection && (
  <MailboxBadge
    email={connection.email}
    provider={connection.provider}
    paused={!connection.autoSyncEnabled}
  />
)}
```

- [ ] **Step 5: Add i18n keys**

In `fr.json` and `en.json`:

```json
"inbox": {
  "allMailboxes": "Toutes les boîtes ({{count}})",
  "mailboxCount_one": "{{count}} boîte",
  "mailboxCount_other": "{{count}} boîtes",
  "errorCount_one": "{{count}} erreur",
  "errorCount_other": "{{count}} erreurs"
}
```

(English equivalents.)

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.inbox.tsx app/i18n/locales/
git commit -m "feat(inbox): wire MailboxBadge/Filter/Indicator into inbox UI"
```

### Task 8.6: Mobile layout for badge

**Files:**
- Modify: `app/components/inbox/MailboxBadge.tsx` (or the CSS file)

- [ ] **Step 1: Add CSS media query**

Add CSS for `.mailbox-badge`:

```css
.mailbox-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}

@media (max-width: 640px) {
  .mailbox-badge .provider-mark {
    display: none;
  }
  .mailbox-badge .email-label::after {
    content: "";   /* truncate handled by CSS truncation or smaller font */
  }
}
```

- [ ] **Step 2: Test in browser at 375px viewport**

```bash
npm run dev
```
Open dev tools, set viewport to 375px. Verify badge shrinks correctly.

- [ ] **Step 3: Commit**

```bash
git add app/components/inbox/MailboxBadge.tsx  # or relevant CSS
git commit -m "feat(inbox): mobile-responsive mailbox badge"
```

---

## Phase 9 — Dashboard filter

### Task 9.1: Wire `mailbox` query param into the dashboard loader

**Files:**
- Modify: `app/routes/app.dashboard.tsx`

- [ ] **Step 1: Read the mailbox param in the loader**

Just after parsing `range`/`from`/`to`:

```ts
const mailConnectionId = url.searchParams.get("mailbox") || undefined;
```

- [ ] **Step 2: Propagate to every stats helper call**

Replace each helper invocation that takes `shop, start, end, ...` with the extended signature passing `mailConnectionId` as the last argument:

```ts
getDashboardKpis(shop, start, end, prevStart, prevEnd, mailConnectionId)
getResponseTimeDailyBreakdown(shop, start, end, mailConnectionId)
getDraftUsageDailyBreakdown(shop, start, end, mailConnectionId)
getCurrentThreadStates(shop, mailConnectionId)
getTopIntentsWithPerf(shop, start, end, 8, mailConnectionId)
getHeatmap(shop, start, end, mailConnectionId)
getReopenedThreads(shop, start, end, 10, mailConnectionId)
getAlerts(shop, range, start, end, topIntentsAll, mailConnectionId)
```

- [ ] **Step 3: Load `connections` for the filter dropdown**

```ts
const connections = await prisma.mailConnection.findMany({
  where: { shop },
  select: { id: true, email: true },
});
```

Return `connections` and `mailConnectionId` from the loader.

- [ ] **Step 4: Render the filter dropdown in the dashboard UI**

Near the period selector, add:

```tsx
import MailboxFilter from "../components/inbox/MailboxFilter";

<MailboxFilter
  connections={loaderData.connections}
  countsByMailbox={{}}  // no counts on dashboard — just selection
  totalCount={0}
/>
```

(Update `MailboxFilter` to handle the case where `countsByMailbox` is empty — show just the email name without count.)

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck 2>&1 | grep "app.dashboard.tsx"
```

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.dashboard.tsx app/components/inbox/MailboxFilter.tsx
git commit -m "feat(dashboard): mailbox filter dropdown"
```

---

## Phase 10 — Smoke test, cleanup, docs

### Task 10.1: Manual smoke test on the dev environment

**Files:** none

- [ ] **Step 1: Start dev server and connect first mailbox**

```bash
npm run dev
```
Open the test shop in browser, go through onboarding. Connect Gmail to whichever test mailbox you have.

- [ ] **Step 2: Wait for sync, verify inbox loads**

After first sync completes, open `/app/inbox`. Verify threads appear.

- [ ] **Step 3: Connect a second mailbox (Outlook)**

Navigate to `/app/connections`. Click "Connecter une boîte". Pick Outlook. Authenticate. Verify the new mailbox appears in the connections list.

- [ ] **Step 4: Verify the inbox shows both**

Go back to `/app/inbox`. Confirm:
- Indicator `📥 2 boîtes` appears in the header.
- Filter dropdown shows both mailboxes.
- Threads from both mailboxes are visible with badges.

- [ ] **Step 5: Test pause**

In `/app/connections`, pause the Outlook mailbox. Reload `/app/inbox`. Verify:
- The badge on Outlook threads shows ⏸️.
- No new sync runs on Outlook (watch logs).

- [ ] **Step 6: Test disconnect**

In `/app/connections`, disconnect Outlook. Confirm by typing the email. Verify:
- The connection disappears from the list.
- Outlook threads are gone from `/app/inbox`.
- Gmail threads remain.

- [ ] **Step 7: Test downgrade with overflow**

In DB, set `ShopFlag.currentPlanId` to "pro" for the test shop. Re-connect Outlook + a third Zoho mailbox so the shop is at 3 mailboxes. Navigate to `/app/billing`, click "Passer à Starter". Verify the select-mailbox screen appears. Pick Gmail to keep, submit, verify the other two get disconnected.

- [ ] **Step 8: Commit (verification only — no code changes)**

If you discovered bugs, file them as separate commits with `fix(...)` prefix.

### Task 10.2: Update `TECHNICAL_DEBT.md` — mark resolved items

**Files:**
- Modify: `TECHNICAL_DEBT.md`

- [ ] **Step 1: Mark ARCH-C2 resolved**

Find the `[ARCH-C2]` entry. Change `- [ ]` to `- [x]` and add a note:

```
- [x] **[ARCH-C2] `deleteConnection` and `handleResync` leave orphan `Thread` rows** (RESOLVED 2026-05-XX in multi-mailbox refactor)
```

- [ ] **Step 2: Mark DB-M5 resolved**

```
- [x] **[DB-M5] `enqueueDuePeriodicSyncs` loads all enabled shops every tick — no due-time filter in SQL** (RESOLVED 2026-05-XX in multi-mailbox refactor)
```

- [ ] **Step 3: Commit**

```bash
git add TECHNICAL_DEBT.md
git commit -m "docs(tech-debt): mark ARCH-C2 and DB-M5 resolved by multi-mailbox refactor"
```

### Task 10.3: Update `CLAUDE.md` with multi-mailbox notes

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the product overview to mention multi-mailbox**

In the "Product" section, after the existing description of auto-sync, add:

```markdown
- multiple mailboxes per shop (up to 3 on Pro/Trial, 1 on Starter), accessible from /app/connections
- the inbox aggregates threads from all connected mailboxes with a per-thread badge and a filter dropdown
```

- [ ] **Step 2: Update the schema section**

In "High-level architecture" / data model area, mention `MailConnection.id` is the PK and `mailConnectionId` is required on Thread / IncomingEmail.

- [ ] **Step 3: Update the multi-tenant rules section**

Add a bullet:

```markdown
- Every mailbox-scoped query MUST include both `shop` AND `mailConnectionId` in the WHERE clause to prevent cross-mailbox leaks within the same shop. Shop-wide aggregates (billing usage, GDPR webhooks, recompute jobs) intentionally do not filter by mailbox.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): document multi-mailbox feature and isolation rules"
```

### Task 10.4: Coverage sanity check

**Files:** none

- [ ] **Step 1: Run the full unit + integration suite**

```bash
npm test
npm run test:integration
```
Expected: all tests pass.

- [ ] **Step 2: Run typecheck globally**

```bash
npm run typecheck 2>&1 | grep -E "error TS" | wc -l
```
Confirm the count is at the baseline (pre-existing errors only).

- [ ] **Step 3: (Optional) Run E2E**

```bash
npm run test:e2e
```
If Playwright is wired and the dev server is up, run the multi-mailbox E2E tests if you've added them.

- [ ] **Step 4: Final review pass**

Skim the spec section "Tests to write" and confirm every category has at least one test in the suite.

### Task 10.5: Final commit and merge

- [ ] **Step 1: Squash review optional**

Since each task ends with a clean commit, the branch is already a clean history. No squash needed.

- [ ] **Step 2: Push to main**

```bash
git push origin main
```

- [ ] **Step 3: Verify Render deploy + migration**

Watch the Render dashboard. Confirm `prisma migrate deploy` runs at boot and exits 0. Smoke-test the public URL after deploy.

---

## Self-review notes (for the engineer executing this plan)

If any of these patterns appear in remaining work after Phase 4, flag them — they're easy to miss:

- A new query you add later that uses `where: { shop }` without thinking about whether it should be mailbox-scoped.
- A new background job you add that doesn't set `mailConnectionId`.
- A new UI component that displays mailbox data without rendering the badge.
- An error message in a banner that hardcodes "votre boîte" (singular) — should use a count-aware form.

When in doubt, look at how the inbox loader handles the same kind of read — it's the canonical example.
