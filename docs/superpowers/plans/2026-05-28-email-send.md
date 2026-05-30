# Email Send v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre au merchant d'envoyer ses brouillons générés par l'app directement via le bouton « Envoyer » (un clic + délai 10s annulable), en utilisant les tokens OAuth déjà collectés (avec scope élargi sur Gmail/Outlook). Pas d'auto-send.

**Architecture:** Une méthode `MailClient.send()` ajoutée à l'interface, implémentée par les 3 adapters (Gmail/Outlook/Zoho). L'action server `handleSendDraft` gère idempotency (CAS atomique sur `ReplyDraft.sendingStartedAt`), assemblage RFC822 (`In-Reply-To`/`References` chain), insert pré-emptif d'`IncomingEmail` outgoing (sourceMarker="sent_from_app") pour réconciliation avant la prochaine sync, transition Thread→waiting_customer. Re-consent JIT via une page explicative si scope insuffisant. Safety env var `SEND_DISABLED_FOR_INTERNAL` pour tester sans envoyer pour de vrai.

**Tech Stack:** TypeScript, Prisma 6 (Postgres Neon), React Router 7, vitest (unit + integration vs Postgres réel), Gmail API REST, Microsoft Graph REST, Zoho Mail API REST.

**Spec:** [docs/superpowers/specs/2026-05-28-email-send-design.md](../specs/2026-05-28-email-send-design.md)

**Branch base:** `feat/classify-stale-cron` (stackée sur PR #22 stackée sur PR #21). Implémentable indépendamment ou après merge de #21/#22 ; les conflits potentiels sont uniquement sur `auto-sync.ts` (ajout d'un step de cleanup) et `schema.prisma` (ajout de colonnes — pas de conflit avec la migration du cron).

---

## Conventions

- Each task ends with a commit. Prefixes used in this repo: `feat()`, `refactor()`, `fix()`, `test()`, `chore(migration)`, `docs()`.
- Unit tests: `npm test`. Integration tests: `npm run test:integration`. Typecheck: `npm run typecheck`. E2E déféré (voir spec).
- Integration tests use the real Postgres test DB via `app/lib/__tests__/integration/helpers/db.ts`. Reuse `TEST_SHOP = "integration-test.myshopify.com"`.
- Après chaque refactor, run `npm run typecheck 2>&1 | grep <file>` pour confirmer absence de nouvelle erreur sur les fichiers touchés. Erreurs préexistantes (app.inbox.tsx etc.) listées dans `TECHNICAL_DEBT.md`, OK à ignorer.
- UI copy française : vouvoiement uniquement. i18n keys dans `app/i18n/locales/fr.json` ET `en.json`.
- Phases sont séquentielles. Phase 1 (schema) bloque tout le reste. Phases 2-6 (backend) bloquent les phases 7-8 (UI). Phase 9 (safety+docs) en dernier.

---

## File map

### New files

```
prisma/migrations/<auto-date>_email_send_v1/migration.sql
app/lib/mail/assemble-rfc822.ts                            # RFC822 assembler helper
app/lib/mail/__tests__/assemble-rfc822.test.ts             # unit
app/lib/support/__tests__/integration/send-draft.test.ts   # integration
app/lib/mail/__tests__/integration/send-cleanup.test.ts    # integration
app/components/inbox/SendButton.tsx                        # 4-state button + 10s toast
app/components/inbox/SendButton.module.css                 # (only if matching existing CSS pattern; otherwise inline styles)
app/routes/app.mail-auth.reauth.tsx                        # JIT re-consent explainer
```

### Modified files

```
prisma/schema.prisma
app/lib/mail/types.ts                          # add MailClient.send + payload/result types
app/lib/gmail/mail-client.ts                   # implement send
app/lib/gmail/auth.ts                          # scope expansion + grantedScopes persistence
app/lib/outlook/mail-client.ts                 # implement send (create-draft + send pattern)
app/lib/outlook/auth.ts                        # scope expansion + grantedScopes persistence
app/lib/zoho/client.ts                         # implement send
app/lib/zoho/auth.ts                           # grantedScopes persistence (no scope expansion needed)
app/lib/support/inbox-actions.ts               # handleSendDraft
app/lib/mail/auto-sync.ts                      # releaseStaleSendingDrafts cleanup in tick()
app/routes/mail-auth.tsx                       # callback writes grantedScopes
app/routes/app.inbox.tsx                       # intent="send" branch in action; SendButton in JSX
app/i18n/locales/fr.json / en.json             # new keys: inbox.send.*, mail-auth.reauth.*
CLAUDE.md                                      # remove "Automatic email sending OUT OF SCOPE", add send section
```

---

## Phase 1 — Schema migration

### Task 1.1: Add columns to `ReplyDraft`, `IncomingEmail`, `MailConnection`

**Files:**
- Create: `prisma/migrations/<auto-date>_email_send_v1/migration.sql`
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Write the migration SQL**

Create `prisma/migrations/20260529100000_email_send_v1/migration.sql` (adjust date if necessary):

```sql
-- ReplyDraft : track send lifecycle
ALTER TABLE "ReplyDraft" ADD COLUMN "sendingStartedAt" TIMESTAMP(3);
ALTER TABLE "ReplyDraft" ADD COLUMN "sentAt" TIMESTAMP(3);
ALTER TABLE "ReplyDraft" ADD COLUMN "sentRfcMessageId" TEXT;
ALTER TABLE "ReplyDraft" ADD COLUMN "sendError" TEXT;
ALTER TABLE "ReplyDraft" ADD COLUMN "linkedOutgoingEmailId" TEXT;

-- Indices for cron cleanup + UI queries
CREATE INDEX "ReplyDraft_sendingStartedAt_idx" ON "ReplyDraft"("sendingStartedAt") WHERE "sendingStartedAt" IS NOT NULL;
CREATE INDEX "ReplyDraft_sentAt_idx" ON "ReplyDraft"("sentAt") WHERE "sentAt" IS NOT NULL;

-- IncomingEmail : mark messages created by our send action vs synced from provider
ALTER TABLE "IncomingEmail" ADD COLUMN "sourceMarker" TEXT;
CREATE INDEX "IncomingEmail_sourceMarker_idx" ON "IncomingEmail"("sourceMarker") WHERE "sourceMarker" IS NOT NULL;

-- MailConnection : persist OAuth scopes granted at callback (CSV, lowercase)
ALTER TABLE "MailConnection" ADD COLUMN "grantedScopes" TEXT;

-- ThreadStateHistory : record WHY a transition happened (e.g. draft_sent)
ALTER TABLE "ThreadStateHistory" ADD COLUMN "reason" TEXT;
```

The partial indices (`WHERE ... IS NOT NULL`) keep the index small — only a tiny fraction of rows ever have these set.

- [ ] **Step 2: Update `prisma/schema.prisma` to match**

In the `ReplyDraft` model, add after the existing `heuristicComputedAt DateTime?` line:

```prisma
  // --- Email send v1 ---
  sendingStartedAt     DateTime?
  sentAt               DateTime?
  sentRfcMessageId     String?
  sendError            String?
  linkedOutgoingEmailId String?

  @@index([sendingStartedAt])
  @@index([sentAt])
```

In the `IncomingEmail` model, add after `processingStatus String @default("pending")`:

```prisma
  // null = ingested by sync; "sent_from_app" = pre-emptive row created by handleSendDraft.
  sourceMarker String?

  @@index([sourceMarker])
```

In the `MailConnection` model, add after the existing `outgoingAliases` field (or anywhere near token fields):

```prisma
  // CSV of OAuth scopes granted at the latest callback (lowercase, comma-separated).
  // Authoritative source is the provider; this is a cached snapshot for fast canSend checks.
  grantedScopes String?
```

In the `ThreadStateHistory` model, add after `changedAt`:

```prisma
  reason String?  // e.g. "draft_sent", "auto_recompute", "manual_resolve"
```

- [ ] **Step 3: Generate Prisma client**

```bash
npx prisma generate
```

Expected: regenerates `node_modules/.prisma/client/`. If the dev server holds a lock on the DLL (Windows), stop it briefly, regenerate, restart.

- [ ] **Step 4: Apply migration to dev DB**

If `DATABASE_URL` points at the dev Neon branch:
```bash
npx prisma migrate deploy
```
Expected: `Applying migration 'email_send_v1'` ... `All migrations have been successfully applied.`

If `DATABASE_URL` points at prod (e.g. dev tunnel scenario), **do NOT run `migrate deploy` here** — let it auto-apply at Render boot.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck 2>&1 | grep -E "ReplyDraft|IncomingEmail|MailConnection"
```
Expected: no new errors (existing errors on `app.inbox.tsx` are pre-existing).

- [ ] **Step 6: Commit**

```bash
git add prisma/migrations/20260529100000_email_send_v1/migration.sql prisma/schema.prisma
git commit -m "chore(migration): schema columns for email send v1"
```

---

## Phase 2 — OAuth scope persistence

We track what scopes each connection has granted, BEFORE expanding the requested scopes. This separates "I know what's authorized" from "I'm asking for more" — easier to reason about.

### Task 2.1: Persist `grantedScopes` in mail-auth callback

**Files:**
- Modify: `app/routes/mail-auth.tsx` (callback handler)

- [ ] **Step 1: Locate the callback's `saveConnection` call**

```bash
grep -n "saveConnection\|tokens" app/routes/mail-auth.tsx | head -10
```

The callback receives an OAuth token exchange response that includes a `scope` field (Google + Microsoft return it; Zoho returns `scope` too in v2 tokens).

- [ ] **Step 2: Add `grantedScopes` to the saveConnection payload for each provider**

In `app/routes/mail-auth.tsx`, where each provider's token exchange happens, capture the scope string returned by the provider and pass it to `saveConnection`. The exact integration site depends on the file's current shape — read the callback flow first, then add `grantedScopes: tokenResponse.scope ?? null` (or equivalent depending on provider) to the saveConnection tokens param.

You'll need to extend each `saveConnection` signature in Phase 2.2 first. Do Step 2 only AFTER Task 2.2.

For now (Step 2), just READ the callback and note the variable name holding the scope. Likely candidates:
- Gmail (googleapis lib): `tokens.scope`
- Outlook (microsoftgraph token response): `tokenResponse.scope`
- Zoho (custom fetch): the JSON body field `scope`

- [ ] **Step 3: Skip Commit (deferred to Task 2.2)**

This step is read-only; no changes yet. Move to Task 2.2.

### Task 2.2: Add `grantedScopes` parameter to each provider's `saveConnection`

**Files:**
- Modify: `app/lib/gmail/auth.ts`
- Modify: `app/lib/outlook/auth.ts`
- Modify: `app/lib/zoho/auth.ts`

- [ ] **Step 1: Extend Gmail `saveConnection` signature**

In `app/lib/gmail/auth.ts`, add `grantedScopes` to the tokens type and pass it through to both the `create` and `update` branches of the upsert:

```ts
export async function saveConnection(
  shop: string,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiry: Date;
    email: string;
    aliases?: string[];
    grantedScopes?: string | null;
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
      grantedScopes: tokens.grantedScopes ?? null,
    },
    update: {
      provider: "gmail",
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      outgoingAliases,
      grantedScopes: tokens.grantedScopes ?? null,
      lastSyncError: null,
      lastSyncAt: null,
      historyId: null,
      deltaToken: null,
      syncCancelledAt: null,
    },
  });
}
```

- [ ] **Step 2: Apply identical shape to Outlook and Zoho**

In `app/lib/outlook/auth.ts` and `app/lib/zoho/auth.ts`, add `grantedScopes?: string | null` to the tokens type and pass it through both `create` and `update` (preserve provider-specific fields like `zohoAccountId`).

- [ ] **Step 3: Update `app/routes/mail-auth.tsx` to pass the scope**

Now wire the callback. For each provider in the callback handler, capture the scope from the token response and add it to the `saveConnection(shop, { ..., grantedScopes: <scope> })` call:

- Gmail (googleapis): `tokens.scope` (space-separated string)
- Outlook (MSAL or fetch): `tokenResponse.scope` (space-separated)
- Zoho: the JSON body's `scope` field (comma-separated)

Normalize all to **lowercase, comma-separated** before storing for uniform downstream parsing:

```ts
function normalizeScopes(raw?: string | null): string | null {
  if (!raw) return null;
  return raw
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)
    .join(",");
}
```

Put `normalizeScopes` in `app/lib/mail/oauth-state.ts` (existing file for OAuth utilities) or a new `app/lib/mail/scopes.ts` if it grows. For v1 keep inline in mail-auth.tsx if simpler.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck 2>&1 | grep -E "auth\.ts|mail-auth"
```
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add app/lib/gmail/auth.ts app/lib/outlook/auth.ts app/lib/zoho/auth.ts app/routes/mail-auth.tsx
git commit -m "feat(oauth): persist grantedScopes per MailConnection at callback"
```

### Task 2.3: Add `canSend(connection)` helper

**Files:**
- Create: `app/lib/mail/scopes.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/mail/__tests__/scopes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canSend } from "../scopes";

describe("canSend", () => {
  it("Gmail with gmail.send scope can send", () => {
    expect(canSend({ provider: "gmail", grantedScopes: "https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly" })).toBe(true);
  });
  it("Gmail without gmail.send cannot send", () => {
    expect(canSend({ provider: "gmail", grantedScopes: "https://www.googleapis.com/auth/gmail.readonly" })).toBe(false);
  });
  it("Outlook with Mail.Send can send (case-insensitive)", () => {
    expect(canSend({ provider: "outlook", grantedScopes: "mail.send,mail.read,user.read,offline_access" })).toBe(true);
  });
  it("Outlook without Mail.Send cannot send", () => {
    expect(canSend({ provider: "outlook", grantedScopes: "mail.read,user.read,offline_access" })).toBe(false);
  });
  it("Zoho with messages.all can send", () => {
    expect(canSend({ provider: "zoho", grantedScopes: "zohomail.messages.all,zohomail.accounts.read" })).toBe(true);
  });
  it("Zoho with only messages.read cannot send", () => {
    expect(canSend({ provider: "zoho", grantedScopes: "zohomail.messages.read,zohomail.accounts.read" })).toBe(false);
  });
  it("null grantedScopes is treated as cannot send", () => {
    expect(canSend({ provider: "gmail", grantedScopes: null })).toBe(false);
  });
  it("unknown provider returns false", () => {
    expect(canSend({ provider: "yahoo", grantedScopes: "anything" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- app/lib/mail/__tests__/scopes.test.ts
```
Expected: FAIL — `canSend` not defined.

- [ ] **Step 3: Implement**

Create `app/lib/mail/scopes.ts`:

```ts
const SEND_SCOPES: Record<string, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.send"],
  outlook: ["mail.send"],
  zoho: ["zohomail.messages.all"],
};

export function canSend(conn: { provider: string; grantedScopes: string | null }): boolean {
  if (!conn.grantedScopes) return false;
  const required = SEND_SCOPES[conn.provider];
  if (!required) return false;
  const granted = new Set(conn.grantedScopes.toLowerCase().split(",").filter(Boolean));
  return required.some((s) => granted.has(s.toLowerCase()));
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- app/lib/mail/__tests__/scopes.test.ts
```
Expected: 8/8 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/mail/scopes.ts app/lib/mail/__tests__/scopes.test.ts
git commit -m "feat(mail): canSend(connection) scope-check helper"
```

### Task 2.4: Expand the requested scopes for Gmail & Outlook

**Files:**
- Modify: `app/lib/gmail/auth.ts` (SCOPES constant)
- Modify: `app/lib/outlook/auth.ts` (SCOPES constant)

- [ ] **Step 1: Add gmail.send to Gmail SCOPES**

In `app/lib/gmail/auth.ts`, find the `SCOPES` array (around line 21) and add the send scope:

```ts
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
];
```

- [ ] **Step 2: Add Mail.Send to Outlook SCOPES**

In `app/lib/outlook/auth.ts`, find `SCOPES` (around line 15) and add:

```ts
const SCOPES = "Mail.Read Mail.Send User.Read offline_access";
```

- [ ] **Step 3: Zoho unchanged**

Zoho's `ZohoMail.messages.ALL` already covers send. No change.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck 2>&1 | grep -E "gmail/auth|outlook/auth"
```
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add app/lib/gmail/auth.ts app/lib/outlook/auth.ts
git commit -m "feat(oauth): request gmail.send + Mail.Send scopes for new connections"
```

**Note:** Existing connections still have the old (read-only) scope until they re-consent. The `canSend` helper will return false for them, triggering the JIT re-consent flow in Phase 7.

---

## Phase 3 — MailClient.send interface + implementations

### Task 3.1: Extend the `MailClient` interface

**Files:**
- Modify: `app/lib/mail/types.ts`

- [ ] **Step 1: Add `SendPayload`, `SendResult` types, and `send()` method**

Open `app/lib/mail/types.ts`. After the existing `MailMessage` type, add:

```ts
/**
 * Input to MailClient.send — fully-assembled RFC822 message ready to ship.
 * The assembler ensures From, headers, threading, and quote are correct.
 */
export interface SendPayload {
  rfcMessageId: string;       // we generate and set this; provider may rewrite
  inReplyToRfcId: string;     // for threading
  references: string;         // space-separated chain
  fromEmail: string;
  fromName?: string;
  toEmails: string[];
  ccEmails?: string[];
  subject: string;
  bodyText: string;           // plain text; provider adapter handles transport encoding
}

export interface SendResult {
  externalMessageId: string;  // provider-internal id (Gmail message.id, Outlook id, Zoho messageId)
  rfcMessageId: string;       // may differ from input if provider rewrote
}
```

In the `MailClient` interface, add the new method:

```ts
export interface MailClient {
  // ... existing methods

  /**
   * Send an outbound message via the provider's API.
   * @throws on auth/scope error (caller catches and triggers re-consent flow).
   * @throws on transient errors (caller may retry).
   */
  send(payload: SendPayload): Promise<SendResult>;

  /**
   * Look up a previously-sent message by its RFC822 Message-ID in the Sent
   * folder. Used by retry logic to detect "first attempt actually succeeded
   * but we didn't get the response" cases.
   * @returns null if not found.
   */
  findSentByRfcMessageId(rfcMessageId: string): Promise<SendResult | null>;
}
```

- [ ] **Step 2: Typecheck (expect cascade errors on adapters)**

```bash
npm run typecheck 2>&1 | grep -E "MailClient|mail-client" | head -10
```
Expected: errors on `gmail/mail-client.ts`, `outlook/mail-client.ts`, `zoho/client.ts` — they don't implement `send` yet. Fixed in Task 3.2-3.4.

- [ ] **Step 3: Commit**

```bash
git add app/lib/mail/types.ts
git commit -m "feat(mail): add send() + findSentByRfcMessageId() to MailClient interface"
```

### Task 3.2: Implement Gmail send

**Files:**
- Modify: `app/lib/gmail/mail-client.ts`

- [ ] **Step 1: Read existing structure**

```bash
sed -n '1,60p' app/lib/gmail/mail-client.ts
```

Understand how the existing methods (listRecentMessages, getMessage, etc.) authenticate. The `createGmailClient(connection)` factory returns a closure with the OAuth2 client. Use the same pattern for `send`.

- [ ] **Step 2: Add `send` implementation**

Inside the `createGmailClient` factory, add:

```ts
async function send(payload: SendPayload): Promise<SendResult> {
  // Build raw RFC822 in base64url encoding (Gmail requirement).
  const raw = buildRawRfc822(payload);                // helper imported from assemble-rfc822
  const base64url = Buffer.from(raw, "utf-8").toString("base64url");
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: base64url },
  });
  // Gmail returns { id, threadId, labelIds } — id is the internal message ID.
  // To get the actual Message-ID header (may be rewritten), fetch the sent
  // message metadata. One extra call but ensures correct rfcMessageId.
  const sent = await gmail.users.messages.get({
    userId: "me",
    id: res.data.id!,
    format: "metadata",
    metadataHeaders: ["Message-ID"],
  });
  const messageIdHeader = sent.data.payload?.headers?.find((h) => h.name === "Message-ID")?.value ?? payload.rfcMessageId;
  return {
    externalMessageId: res.data.id!,
    rfcMessageId: messageIdHeader.replace(/^<|>$/g, ""), // strip angle brackets
  };
}

async function findSentByRfcMessageId(rfcMessageId: string): Promise<SendResult | null> {
  // Gmail search: rfc822msgid:<id>
  const res = await gmail.users.messages.list({
    userId: "me",
    q: `rfc822msgid:${rfcMessageId} label:sent`,
    maxResults: 1,
  });
  const msg = res.data.messages?.[0];
  if (!msg?.id) return null;
  return { externalMessageId: msg.id, rfcMessageId };
}
```

Then add `send` and `findSentByRfcMessageId` to the returned object:

```ts
return {
  listRecentMessages,
  getMessage,
  listNewMessages,
  getSyncCursor,
  getThreadMessages,
  send,
  findSentByRfcMessageId,
};
```

The `buildRawRfc822` helper comes from `app/lib/mail/assemble-rfc822.ts` (created in Phase 4). For now, add a temporary stub:

```ts
function buildRawRfc822(p: SendPayload): string {
  return [
    `From: ${p.fromName ? `"${p.fromName}" ` : ""}<${p.fromEmail}>`,
    `To: ${p.toEmails.join(", ")}`,
    p.ccEmails?.length ? `Cc: ${p.ccEmails.join(", ")}` : null,
    `Subject: ${p.subject}`,
    `Message-ID: <${p.rfcMessageId}>`,
    p.inReplyToRfcId ? `In-Reply-To: <${p.inReplyToRfcId}>` : null,
    p.references ? `References: ${p.references}` : null,
    `Date: ${new Date().toUTCString()}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    p.bodyText,
  ].filter(Boolean).join("\r\n");
}
```

Replace this stub with the proper helper import in Phase 4.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | grep "gmail/mail-client.ts"
```
Expected: 0 errors on this file.

- [ ] **Step 4: Commit**

```bash
git add app/lib/gmail/mail-client.ts
git commit -m "feat(gmail): implement MailClient.send via gmail.users.messages.send"
```

### Task 3.3: Implement Outlook send (create-draft + send pattern)

**Files:**
- Modify: `app/lib/outlook/mail-client.ts`

- [ ] **Step 1: Read existing structure**

```bash
sed -n '1,60p' app/lib/outlook/mail-client.ts
```

Outlook adapter likely uses `fetch` against `https://graph.microsoft.com/v1.0/me/...` with the bearer token.

- [ ] **Step 2: Implement `send` via create-draft + send-draft**

`/me/sendMail` returns 202 no body — useless for capturing the id. Use `POST /me/messages` (creates a draft, returns id) then `POST /me/messages/{id}/send` (sends it).

Add inside the `createOutlookClient` factory:

```ts
async function send(payload: SendPayload): Promise<SendResult> {
  // Step 1: create the draft. Outlook structures the message as JSON.
  const draftBody = {
    subject: payload.subject,
    body: { contentType: "text", content: payload.bodyText },
    toRecipients: payload.toEmails.map((e) => ({ emailAddress: { address: e } })),
    ccRecipients: (payload.ccEmails ?? []).map((e) => ({ emailAddress: { address: e } })),
    from: { emailAddress: { address: payload.fromEmail, name: payload.fromName } },
    internetMessageId: `<${payload.rfcMessageId}>`,
    internetMessageHeaders: [
      payload.inReplyToRfcId ? { name: "In-Reply-To", value: `<${payload.inReplyToRfcId}>` } : null,
      payload.references ? { name: "References", value: payload.references } : null,
    ].filter(Boolean),
  };
  const createRes = await fetch("https://graph.microsoft.com/v1.0/me/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(draftBody),
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Outlook create draft failed: ${createRes.status} ${text}`);
  }
  const created = await createRes.json();
  const internalId = created.id as string;

  // Step 2: send the draft. 202 Accepted, no body.
  const sendRes = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${internalId}/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!sendRes.ok) {
    const text = await sendRes.text();
    throw new Error(`Outlook send draft failed: ${sendRes.status} ${text}`);
  }

  // Step 3: read back the sent message to get the rewritten Message-ID (if any).
  // Outlook may rewrite or keep our internetMessageId.
  // After send, the message moves to Sent Items; the id stays the same.
  const readRes = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${internalId}?$select=internetMessageId`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (readRes.ok) {
    const data = await readRes.json();
    const rfcId = (data.internetMessageId as string ?? `<${payload.rfcMessageId}>`).replace(/^<|>$/g, "");
    return { externalMessageId: internalId, rfcMessageId: rfcId };
  }
  // Fallback if read fails
  return { externalMessageId: internalId, rfcMessageId: payload.rfcMessageId };
}

async function findSentByRfcMessageId(rfcMessageId: string): Promise<SendResult | null> {
  // Outlook Graph: filter on internetMessageId
  const url = `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$filter=${encodeURIComponent(`internetMessageId eq '<${rfcMessageId}>'`)}&$select=id,internetMessageId&$top=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const data = await res.json();
  const msg = data.value?.[0];
  if (!msg?.id) return null;
  return { externalMessageId: msg.id, rfcMessageId };
}
```

`accessToken` is the same one already used by the other methods in this client (closure variable from `createOutlookClient`).

Add both to the returned object.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | grep "outlook/mail-client.ts"
```
Expected: 0 errors on this file.

- [ ] **Step 4: Commit**

```bash
git add app/lib/outlook/mail-client.ts
git commit -m "feat(outlook): implement MailClient.send via create-draft + send-draft pattern"
```

### Task 3.4: Implement Zoho send

**Files:**
- Modify: `app/lib/zoho/client.ts`

- [ ] **Step 1: Read existing structure**

```bash
sed -n '120,160p' app/lib/zoho/client.ts
```

- [ ] **Step 2: Implement `send` via Zoho API**

Zoho Mail API endpoint: `POST https://mail.zoho.<region>/api/accounts/{accountId}/messages`. Body is JSON with `fromAddress`, `toAddress`, `subject`, `content`, `mailFormat`, plus optional `inReplyTo` header support via `mailFormat: "plaintext"` and headers in the body if applicable.

Add inside `createZohoClient` (or wherever methods are defined):

```ts
async function send(payload: SendPayload): Promise<SendResult> {
  const body = {
    fromAddress: payload.fromName ? `${payload.fromName} <${payload.fromEmail}>` : payload.fromEmail,
    toAddress: payload.toEmails.join(","),
    ccAddress: (payload.ccEmails ?? []).join(","),
    subject: payload.subject,
    content: payload.bodyText,
    mailFormat: "plaintext",
    // Zoho doesn't support setting arbitrary RFC822 headers in v3 API.
    // In-Reply-To is set via the "inReplyTo" parameter on the send endpoint.
    inReplyTo: payload.inReplyToRfcId ? `<${payload.inReplyToRfcId}>` : undefined,
  };
  const res = await fetch(
    `https://${ZOHO_API_DOMAIN}/api/accounts/${zohoAccountId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zoho send failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  // Zoho returns { status: { code, description }, data: { messageId, ... } }
  const internalId = String(data?.data?.messageId ?? "");
  if (!internalId) {
    throw new Error(`Zoho send: response missing messageId`);
  }
  // Zoho generates its own Message-ID; we'd need an extra GET to retrieve it.
  // For v1, fall back to our pre-generated rfcMessageId — if Zoho rewrites,
  // the sync will overwrite it via the dedup-overwrite logic at sync time.
  return { externalMessageId: internalId, rfcMessageId: payload.rfcMessageId };
}

async function findSentByRfcMessageId(rfcMessageId: string): Promise<SendResult | null> {
  // Zoho search: /api/accounts/{accountId}/messages/search
  const url = `https://${ZOHO_API_DOMAIN}/api/accounts/${zohoAccountId}/messages/search?searchKey=${encodeURIComponent(`messageId:${rfcMessageId}`)}&limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const msg = data?.data?.[0];
  if (!msg?.messageId) return null;
  return { externalMessageId: String(msg.messageId), rfcMessageId };
}
```

`ZOHO_API_DOMAIN`, `zohoAccountId`, and `accessToken` are the same variables already used by the existing client closure.

Add both to the returned object.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | grep "zoho/client.ts"
```
Expected: 0 errors on this file.

- [ ] **Step 4: Commit**

```bash
git add app/lib/zoho/client.ts
git commit -m "feat(zoho): implement MailClient.send via /accounts/{id}/messages"
```

---

## Phase 4 — RFC822 assembler

### Task 4.1: `assembleRfc822` helper + tests

**Files:**
- Create: `app/lib/mail/assemble-rfc822.ts`
- Create: `app/lib/mail/__tests__/assemble-rfc822.test.ts`

- [ ] **Step 1: Write the failing tests (TDD)**

Create `app/lib/mail/__tests__/assemble-rfc822.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assembleRfc822, buildSubjectWithRePrefix, quoteOriginal, generateMessageId } from "../assemble-rfc822";

describe("buildSubjectWithRePrefix", () => {
  it("adds Re: prefix if missing", () => {
    expect(buildSubjectWithRePrefix("Question commande")).toBe("Re: Question commande");
  });
  it("does not double-prefix Re:", () => {
    expect(buildSubjectWithRePrefix("Re: Question commande")).toBe("Re: Question commande");
  });
  it("handles RE: (uppercase)", () => {
    expect(buildSubjectWithRePrefix("RE: Question")).toBe("RE: Question");
  });
  it("handles French Ré: variant", () => {
    expect(buildSubjectWithRePrefix("Ré: Bonjour")).toBe("Re: Ré: Bonjour"); // we only check exact 'Re:'/'RE:'; French is treated as new
  });
});

describe("quoteOriginal", () => {
  it("prefixes each line with '> '", () => {
    expect(quoteOriginal("ligne 1\nligne 2")).toBe("> ligne 1\n> ligne 2");
  });
  it("handles empty body", () => {
    expect(quoteOriginal("")).toBe("");
  });
  it("preserves CRLF as LF for output uniformity", () => {
    expect(quoteOriginal("a\r\nb")).toBe("> a\n> b");
  });
});

describe("generateMessageId", () => {
  it("returns a stable RFC-shaped Message-ID using the shop domain", () => {
    const id = generateMessageId("integration-test.myshopify.com");
    expect(id).toMatch(/^[a-z0-9-]+@integration-test\.myshopify\.com$/);
  });
  it("produces distinct ids on consecutive calls", () => {
    const a = generateMessageId("x.myshopify.com");
    const b = generateMessageId("x.myshopify.com");
    expect(a).not.toBe(b);
  });
});

describe("assembleRfc822", () => {
  it("builds a complete payload from draft + thread + customer", () => {
    const payload = assembleRfc822({
      shop: "integration-test.myshopify.com",
      mailbox: { email: "support@brand.com", fromName: "AMBIENT HOME" },
      customer: { email: "client@gmail.com", name: "Jean Dupont" },
      originalIncoming: {
        rfcMessageId: "orig-msg-1@gmail.com",
        receivedAt: new Date("2026-05-28T10:30:00Z"),
        subject: "Ma commande",
        bodyText: "Bonjour, où est ma commande #1234 ?",
      },
      thread: {
        references: "orig-prev@gmail.com orig-msg-1@gmail.com",
      },
      draftBody: "Bonjour Jean, votre commande est en transit. Suivi attendu sous 2 jours.",
    });
    expect(payload.fromEmail).toBe("support@brand.com");
    expect(payload.fromName).toBe("AMBIENT HOME");
    expect(payload.toEmails).toEqual(["client@gmail.com"]);
    expect(payload.subject).toBe("Re: Ma commande");
    expect(payload.inReplyToRfcId).toBe("orig-msg-1@gmail.com");
    expect(payload.references).toBe("orig-prev@gmail.com orig-msg-1@gmail.com");
    expect(payload.rfcMessageId).toMatch(/@integration-test\.myshopify\.com$/);
    expect(payload.bodyText).toContain("Bonjour Jean, votre commande est en transit.");
    expect(payload.bodyText).toContain("Le 28/05/2026, Jean Dupont <client@gmail.com> a écrit :");
    expect(payload.bodyText).toContain("> Bonjour, où est ma commande #1234 ?");
  });

  it("falls back to customer email if no name", () => {
    const payload = assembleRfc822({
      shop: "x.myshopify.com",
      mailbox: { email: "s@b.com", fromName: "" },
      customer: { email: "c@g.com", name: "" },
      originalIncoming: {
        rfcMessageId: "m1@g.com", receivedAt: new Date("2026-05-28T10:00:00Z"),
        subject: "Q", bodyText: "body",
      },
      thread: { references: "" },
      draftBody: "answer",
    });
    expect(payload.bodyText).toContain("Le 28/05/2026, c@g.com a écrit :");
  });

  it("appends the new Message-ID to references", () => {
    const payload = assembleRfc822({
      shop: "x.myshopify.com",
      mailbox: { email: "s@b.com" },
      customer: { email: "c@g.com" },
      originalIncoming: {
        rfcMessageId: "m1@g.com", receivedAt: new Date(),
        subject: "Q", bodyText: "body",
      },
      thread: { references: "prev@g.com m1@g.com" },
      draftBody: "answer",
    });
    expect(payload.references).toBe("prev@g.com m1@g.com");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- app/lib/mail/__tests__/assemble-rfc822.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `app/lib/mail/assemble-rfc822.ts`:

```ts
import type { SendPayload } from "./types";

export function buildSubjectWithRePrefix(subject: string): string {
  if (/^re:\s/i.test(subject)) return subject;
  return `Re: ${subject}`;
}

export function quoteOriginal(body: string): string {
  if (!body) return "";
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function generateMessageId(shop: string): string {
  // RFC 5322 Message-ID format: <unique@domain>
  // We use shop as domain (e.g. mystore.myshopify.com) since it's
  // guaranteed unique per merchant.
  const rand = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${rand}@${shop}`;
}

interface AssembleInput {
  shop: string;
  mailbox: { email: string; fromName?: string };
  customer: { email: string; name?: string };
  originalIncoming: {
    rfcMessageId: string;
    receivedAt: Date;
    subject: string;
    bodyText: string;
  };
  thread: { references: string };
  draftBody: string;
}

export function assembleRfc822(input: AssembleInput): SendPayload {
  const { shop, mailbox, customer, originalIncoming, thread, draftBody } = input;
  const dateStr = originalIncoming.receivedAt.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Paris",
  });
  const customerLabel = customer.name
    ? `${customer.name} <${customer.email}>`
    : customer.email;
  const quoteHeader = `Le ${dateStr}, ${customerLabel} a écrit :`;
  const quoted = quoteOriginal(originalIncoming.bodyText);
  const bodyText = `${draftBody}\n\n${quoteHeader}\n${quoted}`;
  return {
    rfcMessageId: generateMessageId(shop),
    inReplyToRfcId: originalIncoming.rfcMessageId,
    references: thread.references,
    fromEmail: mailbox.email,
    fromName: mailbox.fromName,
    toEmails: [customer.email],
    subject: buildSubjectWithRePrefix(originalIncoming.subject),
    bodyText,
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- app/lib/mail/__tests__/assemble-rfc822.test.ts
```
Expected: all tests PASS.

- [ ] **Step 5: Update Gmail mail-client to use the real helper**

In `app/lib/gmail/mail-client.ts`, remove the temporary `buildRawRfc822` stub function. Import and use the new helper:

```ts
import { assembleRfc822 } from "../mail/assemble-rfc822";
```

For Gmail's RFC822 transport, we need the FULL raw message including headers. Add a small helper INSIDE `assemble-rfc822.ts` that takes a `SendPayload` and produces the full RFC822 string for transport-encoding into base64url:

```ts
export function renderRfc822(payload: SendPayload): string {
  const lines: string[] = [
    `From: ${payload.fromName ? `"${payload.fromName}" ` : ""}<${payload.fromEmail}>`,
    `To: ${payload.toEmails.join(", ")}`,
  ];
  if (payload.ccEmails?.length) lines.push(`Cc: ${payload.ccEmails.join(", ")}`);
  lines.push(`Subject: ${payload.subject}`);
  lines.push(`Message-ID: <${payload.rfcMessageId}>`);
  if (payload.inReplyToRfcId) lines.push(`In-Reply-To: <${payload.inReplyToRfcId}>`);
  if (payload.references) lines.push(`References: ${payload.references}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Content-Type: text/plain; charset=utf-8`);
  lines.push(`Content-Transfer-Encoding: 8bit`);
  lines.push("");
  lines.push(payload.bodyText);
  return lines.join("\r\n");
}
```

Update Gmail's `send` to use it:

```ts
const raw = renderRfc822(payload);
const base64url = Buffer.from(raw, "utf-8").toString("base64url");
```

- [ ] **Step 6: Run all tests**

```bash
npm test -- app/lib/mail/__tests__/assemble-rfc822.test.ts
```
Expected: still PASS.

- [ ] **Step 7: Commit**

```bash
git add app/lib/mail/assemble-rfc822.ts app/lib/mail/__tests__/assemble-rfc822.test.ts app/lib/gmail/mail-client.ts
git commit -m "feat(mail): assembleRfc822 helper + Gmail uses it for transport encoding"
```

---

## Phase 5 — `handleSendDraft` action

### Task 5.1: Write integration test scaffolding (TDD)

**Files:**
- Create: `app/lib/__tests__/integration/send-draft.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/lib/__tests__/integration/send-draft.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import prisma from "../../../db.server";
import { resetTestDb, TEST_SHOP } from "./helpers/db";
import { handleSendDraft } from "../../support/inbox-actions";
import { seedMailConnection, seedThread, seedIncomingEmail } from "./helpers/seed";  // existing helpers

// Mock the MailClient factory layer so we don't actually hit a provider.
vi.mock("../../mail/client-factory", () => ({
  createMailClient: vi.fn(),
}));

import { createMailClient } from "../../mail/client-factory";

describe("handleSendDraft — integration", () => {
  beforeEach(async () => {
    await resetTestDb();
    vi.clearAllMocks();
  });

  it("success path: marks draft sent + creates outgoing IncomingEmail + transitions Thread to waiting_customer", async () => {
    const conn = await seedMailConnection(TEST_SHOP, { provider: "gmail", email: "support@brand.com", grantedScopes: "https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly" });
    const thread = await seedThread(TEST_SHOP, conn.id);
    const incoming = await seedIncomingEmail(TEST_SHOP, conn.id, thread.id, {
      fromAddress: "client@gmail.com",
      subject: "Question",
      rfcMessageId: "orig-1@gmail.com",
      bodyText: "Bonjour",
    });
    const draft = await prisma.replyDraft.create({
      data: {
        shop: TEST_SHOP,
        emailId: incoming.id,
        body: "Bonjour Jean, voici votre suivi.",
      },
    });

    (createMailClient as any).mockResolvedValue({
      send: vi.fn().mockResolvedValue({ externalMessageId: "gmail-internal-123", rfcMessageId: "sent-1@gmail.com" }),
      findSentByRfcMessageId: vi.fn().mockResolvedValue(null),
    });

    const result = await handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id });

    expect(result).toMatchObject({ sent: true });
    expect(result.sentAt).toBeInstanceOf(Date);

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sentAt).not.toBeNull();
    expect(refreshed?.sentRfcMessageId).toBeTruthy();
    expect(refreshed?.linkedOutgoingEmailId).toBeTruthy();

    const outgoing = await prisma.incomingEmail.findUnique({ where: { id: refreshed!.linkedOutgoingEmailId! } });
    expect(outgoing?.sourceMarker).toBe("sent_from_app");
    expect(outgoing?.processingStatus).toBe("outgoing");
    expect(outgoing?.canonicalThreadId).toBe(thread.id);
    expect(outgoing?.inReplyTo).toBe("orig-1@gmail.com");
    expect(outgoing?.externalMessageId).toBe("gmail-internal-123");

    const updatedThread = await prisma.thread.findUnique({ where: { id: thread.id } });
    expect(updatedThread?.operationalState).toBe("waiting_customer");

    const history = await prisma.threadStateHistory.findFirst({
      where: { threadId: thread.id, toState: "waiting_customer" },
    });
    expect(history?.reason).toBe("draft_sent");
  });

  it("double-click: second call returns already_sent_or_sending without DB effect", async () => {
    const conn = await seedMailConnection(TEST_SHOP, { provider: "gmail", email: "s@b.com", grantedScopes: "https://www.googleapis.com/auth/gmail.send" });
    const thread = await seedThread(TEST_SHOP, conn.id);
    const incoming = await seedIncomingEmail(TEST_SHOP, conn.id, thread.id, { rfcMessageId: "o@g.com" });
    const draft = await prisma.replyDraft.create({ data: { shop: TEST_SHOP, emailId: incoming.id, body: "hi" } });

    let sendCallCount = 0;
    (createMailClient as any).mockResolvedValue({
      send: vi.fn().mockImplementation(async () => {
        sendCallCount++;
        await new Promise((r) => setTimeout(r, 100)); // simulate slow API
        return { externalMessageId: "id1", rfcMessageId: "sent@g.com" };
      }),
      findSentByRfcMessageId: vi.fn().mockResolvedValue(null),
    });

    const [r1, r2] = await Promise.all([
      handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id }),
      handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id }),
    ]);
    const successes = [r1, r2].filter((r) => "sent" in r && r.sent).length;
    const blocked = [r1, r2].filter((r) => "error" in r && r.error === "already_sent_or_sending").length;
    expect(successes).toBe(1);
    expect(blocked).toBe(1);
    expect(sendCallCount).toBe(1);
  });

  it("scope insufficient: returns needsReauth", async () => {
    const conn = await seedMailConnection(TEST_SHOP, { provider: "gmail", email: "s@b.com", grantedScopes: "https://www.googleapis.com/auth/gmail.readonly" });
    const thread = await seedThread(TEST_SHOP, conn.id);
    const incoming = await seedIncomingEmail(TEST_SHOP, conn.id, thread.id);
    const draft = await prisma.replyDraft.create({ data: { shop: TEST_SHOP, emailId: incoming.id, body: "hi" } });

    const result = await handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id });
    expect(result).toMatchObject({ needsReauth: true });
    expect((result as any).reauthUrl).toContain("/app/mail-auth/reauth");

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sendingStartedAt).toBeNull();
    expect(refreshed?.sentAt).toBeNull();
  });

  it("provider throw: releases sendingStartedAt + sets sendError", async () => {
    const conn = await seedMailConnection(TEST_SHOP, { provider: "gmail", email: "s@b.com", grantedScopes: "https://www.googleapis.com/auth/gmail.send" });
    const thread = await seedThread(TEST_SHOP, conn.id);
    const incoming = await seedIncomingEmail(TEST_SHOP, conn.id, thread.id);
    const draft = await prisma.replyDraft.create({ data: { shop: TEST_SHOP, emailId: incoming.id, body: "hi" } });

    (createMailClient as any).mockResolvedValue({
      send: vi.fn().mockRejectedValue(new Error("Gmail 500 Internal Server Error")),
      findSentByRfcMessageId: vi.fn().mockResolvedValue(null),
    });

    const result = await handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id });
    expect(result).toMatchObject({ error: expect.stringContaining("send_failed") });

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sendingStartedAt).toBeNull();
    expect(refreshed?.sentAt).toBeNull();
    expect(refreshed?.sendError).toContain("Gmail 500");

    const outgoingCount = await prisma.incomingEmail.count({ where: { sourceMarker: "sent_from_app" } });
    expect(outgoingCount).toBe(0);
  });

  it("retry after timeout: findSentByRfcMessageId hit, marks sent without double-send", async () => {
    const conn = await seedMailConnection(TEST_SHOP, { provider: "gmail", email: "s@b.com", grantedScopes: "https://www.googleapis.com/auth/gmail.send" });
    const thread = await seedThread(TEST_SHOP, conn.id);
    const incoming = await seedIncomingEmail(TEST_SHOP, conn.id, thread.id);
    const draft = await prisma.replyDraft.create({
      data: {
        shop: TEST_SHOP, emailId: incoming.id, body: "hi",
        sendError: "send_timeout_released",
      },
    });

    const sendSpy = vi.fn().mockResolvedValue({ externalMessageId: "should-not-be-called", rfcMessageId: "x" });
    (createMailClient as any).mockResolvedValue({
      send: sendSpy,
      findSentByRfcMessageId: vi.fn().mockResolvedValue({ externalMessageId: "gmail-id-from-previous-attempt", rfcMessageId: "previously-sent@g.com" }),
    });

    const result = await handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id });
    expect(result).toMatchObject({ sent: true });
    expect(sendSpy).not.toHaveBeenCalled();

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sentRfcMessageId).toBe("previously-sent@g.com");
  });
});
```

- [ ] **Step 2: Run to verify all fail**

```bash
npm run test:integration -- app/lib/__tests__/integration/send-draft.test.ts
```
Expected: all 5 tests FAIL — `handleSendDraft` not defined, `createMailClient` factory not defined.

- [ ] **Step 3: Skip commit (tests committed with implementation)**

### Task 5.2: Create the `client-factory.ts` indirection

**Files:**
- Create: `app/lib/mail/client-factory.ts`

- [ ] **Step 1: Write the factory**

Create `app/lib/mail/client-factory.ts`:

```ts
import type { MailConnection } from "@prisma/client";
import type { MailClient } from "./types";
import { createGmailClient } from "../gmail/mail-client";
import { createOutlookClient } from "../outlook/mail-client";
import { createZohoClient } from "../zoho/client";

export async function createMailClient(connection: MailConnection): Promise<MailClient> {
  switch (connection.provider) {
    case "gmail":   return createGmailClient(connection);
    case "outlook": return createOutlookClient(connection);
    case "zoho":    return createZohoClient(connection);
    default:        throw new Error(`Unknown provider: ${connection.provider}`);
  }
}
```

This indirection lets tests mock the factory cleanly. If `createMailClient` already exists somewhere in the codebase, prefer extending that — search first:

```bash
grep -rn "createGmailClient\|createOutlookClient\|createZohoClient" app/lib/ | head -10
```

If a factory exists (likely in `auto-sync.ts` or `pipeline.ts`), refactor to use the new central one in this task.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck 2>&1 | grep "client-factory"
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/lib/mail/client-factory.ts
git commit -m "feat(mail): central createMailClient factory for provider dispatch"
```

### Task 5.3: Implement `handleSendDraft`

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`

- [ ] **Step 1: Add the function**

Add to `app/lib/support/inbox-actions.ts` (near the other `handle*` exports):

```ts
import { canSend } from "../mail/scopes";
import { createMailClient } from "../mail/client-factory";
import { assembleRfc822 } from "../mail/assemble-rfc822";

export type SendDraftResult =
  | { sent: true; sentAt: Date; rfcMessageId: string }
  | { error: string }
  | { needsReauth: true; reauthUrl: string };

export async function handleSendDraft(params: {
  shop: string;
  mailConnectionId: string;
  draftId: string;
}): Promise<SendDraftResult> {
  const { shop, mailConnectionId, draftId } = params;

  // 1. Load connection + check scope
  const conn = await prisma.mailConnection.findUnique({
    where: { id: mailConnectionId, shop },
  });
  if (!conn) return { error: "connection_not_found" };
  if (!canSend(conn)) {
    return {
      needsReauth: true,
      reauthUrl: `/app/mail-auth/reauth?mailConnectionId=${mailConnectionId}`,
    };
  }

  // 2. Safety bypass for internal shops (testing)
  const internalBypass = process.env.SEND_DISABLED_FOR_INTERNAL === "true";
  if (internalBypass) {
    const flag = await prisma.shopFlag.findUnique({ where: { shop } });
    if (flag?.isInternal) {
      return runFakeSendForInternalShop({ shop, conn, draftId });
    }
  }

  // 3. Load draft + thread + original incoming
  const draft = await prisma.replyDraft.findUnique({
    where: { id: draftId, shop },
    include: { email: { include: { thread: true } } },
  });
  if (!draft) return { error: "draft_not_found" };
  if (draft.sentAt) return { error: "already_sent" };
  if (!draft.email.canonicalThreadId) return { error: "thread_unresolved" };

  // 4. Atomic CAS: reserve the draft for sending
  const reserved = await prisma.replyDraft.updateMany({
    where: { id: draftId, sentAt: null, sendingStartedAt: null },
    data: { sendingStartedAt: new Date(), sendError: null },
  });
  if (reserved.count === 0) {
    return { error: "already_sent_or_sending" };
  }

  // 5. Assemble RFC822 payload
  const payload = assembleRfc822({
    shop,
    // fromName left empty for v1 — From header will be just <email>. A future task
    // can wire this from ShopSetting.senderName when that field exists.
    mailbox: { email: conn.email, fromName: "" },
    customer: { email: draft.email.fromAddress, name: draft.email.fromName ?? "" },
    originalIncoming: {
      rfcMessageId: draft.email.rfcMessageId,
      receivedAt: draft.email.receivedAt,
      subject: draft.email.subject,
      bodyText: draft.email.bodyText,
    },
    thread: {
      references: buildReferencesChain(draft.email.rfcReferences, draft.email.rfcMessageId),
    },
    draftBody: draft.body ?? "",
  });

  // 6. Retry-after-timeout: check Sent folder first if last attempt timed out
  let sendResult: { externalMessageId: string; rfcMessageId: string };
  try {
    const client = await createMailClient(conn);
    if (draft.sendError === "send_timeout_released") {
      const existing = await client.findSentByRfcMessageId(payload.rfcMessageId);
      if (existing) {
        sendResult = existing;
      } else {
        sendResult = await client.send(payload);
      }
    } else {
      sendResult = await client.send(payload);
    }
  } catch (err: any) {
    // Release the CAS, store error, return failure
    await prisma.replyDraft.update({
      where: { id: draftId },
      data: { sendingStartedAt: null, sendError: String(err?.message ?? err).slice(0, 500) },
    });
    return { error: `send_failed: ${err?.message ?? err}` };
  }

  // 7. Insert pré-emptif outgoing IncomingEmail + finalize draft + transition thread
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const outgoing = await tx.incomingEmail.create({
      data: {
        shop,
        mailConnectionId,
        externalMessageId: sendResult.externalMessageId,
        rfcMessageId: sendResult.rfcMessageId,
        inReplyTo: draft.email.rfcMessageId,
        rfcReferences: payload.references,
        fromAddress: conn.email,
        // Note: IncomingEmail has no toAddresses field. The recipient is implied
        // by the thread's canonicalThreadId (customer = thread.lastIncomingFromAddress).
        // For the outgoing row, we store fromAddress=conn.email; "to" lives in body headers.
        subject: payload.subject,
        bodyText: payload.bodyText,
        receivedAt: now,
        canonicalThreadId: draft.email.canonicalThreadId!,
        processingStatus: "outgoing",
        tier1Result: "outgoing",
        sourceMarker: "sent_from_app",
      },
    });
    const updatedDraft = await tx.replyDraft.update({
      where: { id: draftId },
      data: {
        sentAt: now,
        sentRfcMessageId: sendResult.rfcMessageId,
        sendingStartedAt: null,
        sendError: null,
        linkedOutgoingEmailId: outgoing.id,
      },
    });
    const updatedThread = await tx.thread.update({
      where: { id: draft.email.canonicalThreadId! },
      data: { operationalState: "waiting_customer", lastStateChangeAt: now },
    });
    await tx.threadStateHistory.create({
      data: {
        shop,
        threadId: updatedThread.id,
        fromState: draft.email.thread!.operationalState,
        toState: "waiting_customer",
        reason: "draft_sent",
      },
    });
    return updatedDraft;
  });

  return {
    sent: true,
    sentAt: result.sentAt!,
    rfcMessageId: result.sentRfcMessageId!,
  };
}

function buildReferencesChain(existingRefs: string, latestRfcId: string): string {
  // RFC 5322: References is a chain of Message-IDs. Append the original
  // message we're replying to if not already present.
  const refs = existingRefs.trim();
  if (!refs) return latestRfcId;
  if (refs.includes(latestRfcId)) return refs;
  return `${refs} ${latestRfcId}`;
}

async function runFakeSendForInternalShop(params: { shop: string; conn: MailConnection; draftId: string }): Promise<SendDraftResult> {
  // For SEND_DISABLED_FOR_INTERNAL=true on internal shops, run the entire
  // flow with a fake provider response so we can test the UX and DB writes
  // without actually emitting a customer email.
  // Reservation, transaction, etc. — same as the real path but skip the API call.
  // ... [implement the same atomic + DB writes as above, with fake send result]
  // For brevity in the plan: copy the success path's transaction logic,
  // replacing the `client.send()` call with `{ externalMessageId: "fake-internal-id", rfcMessageId: payload.rfcMessageId }`.
  // The merchant sees the same UX, but no real mail leaves.
  throw new Error("TODO: implement in Phase 9");
}
```

Note: `runFakeSendForInternalShop` is a stub here; full implementation in Phase 9 Task 9.1. For Phase 5 the tests skip this code path (test shop has no `isInternal` flag).

Note: `ThreadStateHistory` doesn't have `triggeredBy` — the `reason` column added in Task 1.1 covers this. The model also requires `shop` (we set it). Verify by reading the model.

- [ ] **Step 2: Run integration tests**

```bash
npm run test:integration -- app/lib/__tests__/integration/send-draft.test.ts
```
Expected: 5/5 PASS.

If a test fails, debug — likely culprits:
- Schema mismatch reminders: `IncomingEmail` has no `toAddresses` (don't include it in the outgoing insert); `ThreadStateHistory` requires `shop` + uses the new `reason` column from Task 1.1 (no `triggeredBy`)
- Missing `seedMailConnection` parameter for `grantedScopes` — extend the helper if needed
- `canonicalThreadId` not set on seeded incoming — extend `seedIncomingEmail` helper

- [ ] **Step 3: Commit**

```bash
git add app/lib/support/inbox-actions.ts app/lib/__tests__/integration/send-draft.test.ts
git commit -m "feat(inbox): handleSendDraft with idempotency + pre-emptive outgoing insert"
```

---

## Phase 6 — Cleanup cron for stale `sendingStartedAt`

### Task 6.1: Write the integration test

**Files:**
- Create: `app/lib/mail/__tests__/integration/send-cleanup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/mail/__tests__/integration/send-cleanup.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../../db.server";
import { resetTestDb, TEST_SHOP } from "../../../__tests__/integration/helpers/db";
import { seedMailConnection, seedThread, seedIncomingEmail } from "../../../__tests__/integration/helpers/seed";
import { releaseStaleSendingDrafts } from "../../auto-sync";

describe("releaseStaleSendingDrafts", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("releases drafts stuck in sendingStartedAt > 5 min ago", async () => {
    const conn = await seedMailConnection(TEST_SHOP, { provider: "gmail", email: "s@b.com" });
    const thread = await seedThread(TEST_SHOP, conn.id);
    const incoming = await seedIncomingEmail(TEST_SHOP, conn.id, thread.id);
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000);
    const draft = await prisma.replyDraft.create({
      data: {
        shop: TEST_SHOP,
        emailId: incoming.id,
        body: "stuck",
        sendingStartedAt: sixMinAgo,
      },
    });

    const released = await releaseStaleSendingDrafts();
    expect(released).toBe(1);

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sendingStartedAt).toBeNull();
    expect(refreshed?.sendError).toBe("send_timeout_released");
    expect(refreshed?.sentAt).toBeNull();
  });

  it("does not release drafts < 5 min old", async () => {
    const conn = await seedMailConnection(TEST_SHOP, { provider: "gmail", email: "s@b.com" });
    const thread = await seedThread(TEST_SHOP, conn.id);
    const incoming = await seedIncomingEmail(TEST_SHOP, conn.id, thread.id);
    const oneMinAgo = new Date(Date.now() - 60 * 1000);
    const draft = await prisma.replyDraft.create({
      data: {
        shop: TEST_SHOP,
        emailId: incoming.id,
        body: "fresh",
        sendingStartedAt: oneMinAgo,
      },
    });

    const released = await releaseStaleSendingDrafts();
    expect(released).toBe(0);

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sendingStartedAt).toEqual(oneMinAgo);
  });

  it("does not release drafts already sent", async () => {
    const conn = await seedMailConnection(TEST_SHOP, { provider: "gmail", email: "s@b.com" });
    const thread = await seedThread(TEST_SHOP, conn.id);
    const incoming = await seedIncomingEmail(TEST_SHOP, conn.id, thread.id);
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000);
    const draft = await prisma.replyDraft.create({
      data: {
        shop: TEST_SHOP,
        emailId: incoming.id,
        body: "sent",
        sendingStartedAt: sixMinAgo,
        sentAt: sixMinAgo,  // already sent
      },
    });

    const released = await releaseStaleSendingDrafts();
    expect(released).toBe(0);

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sendingStartedAt).toEqual(sixMinAgo); // unchanged
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:integration -- app/lib/mail/__tests__/integration/send-cleanup.test.ts
```
Expected: FAIL — `releaseStaleSendingDrafts` not defined.

- [ ] **Step 3: Skip commit (with implementation)**

### Task 6.2: Implement `releaseStaleSendingDrafts` + wire into tick

**Files:**
- Modify: `app/lib/mail/auto-sync.ts`

- [ ] **Step 1: Add the function**

Add to `app/lib/mail/auto-sync.ts` (near `enqueueClassifyStaleUnknown`):

```ts
const SEND_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Release drafts stuck in `sendingStartedAt` for more than 5 min.
 * Sets sendingStartedAt = NULL and sendError = "send_timeout_released" so
 * the next user click on Send can retry (and the retry path checks the
 * Sent folder via findSentByRfcMessageId to avoid double-send).
 *
 * Called once per auto-sync tick. Cheap: indexed partial lookup, narrow update.
 */
export async function releaseStaleSendingDrafts(): Promise<number> {
  const cutoff = new Date(Date.now() - SEND_STALE_THRESHOLD_MS);
  const released = await prisma.replyDraft.updateMany({
    where: {
      sendingStartedAt: { lt: cutoff, not: null },
      sentAt: null,
    },
    data: {
      sendingStartedAt: null,
      sendError: "send_timeout_released",
    },
  });
  if (released.count > 0) {
    console.log(`[send-cleanup] released ${released.count} stuck draft(s)`);
  }
  return released.count;
}
```

- [ ] **Step 2: Wire into `tick()`**

In `app/lib/mail/auto-sync.ts`, find `tick()` and add after the `enqueueClassifyStaleUnknown` call (around line 205):

```ts
  // 2c. Release drafts stuck in sendingStartedAt > 5 min (send timeout cleanup).
  await releaseStaleSendingDrafts().catch((err) =>
    console.error("[auto-sync] releaseStaleSendingDrafts failed:", err),
  );
```

- [ ] **Step 3: Run integration tests**

```bash
npm run test:integration -- app/lib/mail/__tests__/integration/send-cleanup.test.ts
```
Expected: 3/3 PASS.

- [ ] **Step 4: Commit**

```bash
git add app/lib/mail/auto-sync.ts app/lib/mail/__tests__/integration/send-cleanup.test.ts
git commit -m "feat(auto-sync): releaseStaleSendingDrafts cleanup in tick (5 min threshold)"
```

---

## Phase 7 — Re-consent JIT route

### Task 7.1: `/app/mail-auth/reauth` explainer route

**Files:**
- Create: `app/routes/app.mail-auth.reauth.tsx`

- [ ] **Step 1: Write the route**

Create `app/routes/app.mail-auth.reauth.tsx`:

```tsx
import { json, redirect, type LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useTranslation } from "react-i18next";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const mailConnectionId = url.searchParams.get("mailConnectionId");
  const returnTo = url.searchParams.get("returnTo") ?? "/app/inbox";
  if (!mailConnectionId) return redirect("/app/connections");

  const conn = await prisma.mailConnection.findUnique({
    where: { id: mailConnectionId, shop: session.shop },
    select: { id: true, email: true, provider: true },
  });
  if (!conn) return redirect("/app/connections");

  // Construct the OAuth start URL for the provider. The existing
  // /mail-auth/<provider>/start logic generates the consent URL.
  // For now we use the existing entry points:
  // - Gmail:   /mail-auth/gmail/start
  // - Outlook: /mail-auth/outlook/start
  // - Zoho:    /mail-auth/zoho/start
  // Add ?reconnect=1&mailConnectionId=<id>&returnTo=<encoded> so the callback
  // routes the user back to where they came from.
  const reauthStart = `/mail-auth/${conn.provider}/start?reconnect=1&mailConnectionId=${mailConnectionId}&returnTo=${encodeURIComponent(returnTo)}`;

  return json({ connection: conn, reauthStart, returnTo });
}

export default function ReauthExplainer() {
  const { connection, reauthStart, returnTo } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const providerName = connection.provider === "gmail" ? "Google" : connection.provider === "outlook" ? "Microsoft" : "Zoho";

  return (
    <div style={{ maxWidth: 560, margin: "60px auto", padding: 24, fontFamily: "system-ui" }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
      <h1 style={{ fontSize: 22, marginBottom: 12 }}>
        {t("mail-auth.reauth.title", { email: connection.email, provider: providerName })}
      </h1>
      <p style={{ marginBottom: 16, color: "#444", lineHeight: 1.5 }}>
        {t("mail-auth.reauth.intro", { provider: providerName })}
      </p>
      <ul style={{ marginBottom: 24, color: "#444", paddingLeft: 20, lineHeight: 1.7 }}>
        <li>{t("mail-auth.reauth.bullet_no_auto")}</li>
        <li>{t("mail-auth.reauth.bullet_each_click")}</li>
        <li>{t("mail-auth.reauth.bullet_no_extra_read")}</li>
      </ul>
      <div style={{ display: "flex", gap: 12 }}>
        <a
          href={reauthStart}
          style={{ background: "#1a1a1a", color: "white", padding: "10px 20px", borderRadius: 6, textDecoration: "none", fontWeight: 500 }}
        >
          {t("mail-auth.reauth.continue", { provider: providerName })}
        </a>
        <a
          href={returnTo}
          style={{ padding: "10px 20px", color: "#1a1a1a", textDecoration: "none", border: "1px solid #ccc", borderRadius: 6 }}
        >
          {t("common.cancel")}
        </a>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add i18n keys**

In `app/i18n/locales/fr.json`:

```json
"mail-auth": {
  "reauth": {
    "title": "Activer l'envoi pour {{email}} ({{provider}})",
    "intro": "Pour pouvoir envoyer des emails depuis Automail, nous avons besoin d'une permission supplémentaire de {{provider}}.",
    "bullet_no_auto": "Aucun envoi automatique — vous gardez le contrôle total.",
    "bullet_each_click": "Chaque envoi nécessite votre clic explicite.",
    "bullet_no_extra_read": "Nous n'accédons à aucun mail au-delà de ce que vous voyez déjà.",
    "continue": "Continuer vers {{provider}}"
  }
}
```

In `app/i18n/locales/en.json` (EN equivalents).

- [ ] **Step 3: Update `mail-auth.tsx` to honor `reconnect=1` query**

In `app/routes/mail-auth.tsx`, the existing start handler builds the OAuth URL. Extend it to:
- Accept `?reconnect=1&mailConnectionId=<id>&returnTo=<url>` parameters
- Stash these in the OAuth `state` payload (already HMAC-signed)
- On callback success, redirect to `returnTo` instead of the default destination

This requires reading the current `oauth-state.ts` shape and adding two fields. Keep the existing state encoding backward-compatible.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck 2>&1 | grep "mail-auth"
```
Expected: 0 new errors.

- [ ] **Step 5: Commit**

```bash
git add app/routes/app.mail-auth.reauth.tsx app/routes/mail-auth.tsx app/i18n/locales/fr.json app/i18n/locales/en.json
git commit -m "feat(mail-auth): JIT re-consent explainer route with returnTo support"
```

---

## Phase 8 — SendButton UI integration

### Task 8.1: `<SendButton>` component

**Files:**
- Create: `app/components/inbox/SendButton.tsx`

- [ ] **Step 1: Write the component**

Create `app/components/inbox/SendButton.tsx`:

```tsx
import { useState, useEffect } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";

type SendState = "idle" | "pending" | "sent" | "error" | "needs-reauth";

const COUNTDOWN_MS = 10_000;

export default function SendButton(props: {
  shop: string;
  mailConnectionId: string;
  draftId: string;
  customerEmail: string;
  canSend: boolean;
  reauthUrl?: string;
  initialSentAt?: string | null;
  disabled?: boolean;        // true if no draft yet
}) {
  const { canSend, draftId, mailConnectionId, customerEmail, reauthUrl, initialSentAt, disabled } = props;
  const { t } = useTranslation();
  const fetcher = useFetcher();

  const [state, setState] = useState<SendState>(
    initialSentAt ? "sent" : (canSend ? "idle" : "needs-reauth")
  );
  const [countdown, setCountdown] = useState(10);
  const [errorMsg, setErrorMsg] = useState("");

  // Tick the countdown when in pending state
  useEffect(() => {
    if (state !== "pending") return;
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, COUNTDOWN_MS - elapsed);
      setCountdown(Math.ceil(remaining / 1000));
      if (remaining <= 0) {
        clearInterval(interval);
        actuallySend();
      }
    }, 100);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // React to fetcher response
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const data = fetcher.data as any;
    if (data.sent) {
      setState("sent");
    } else if (data.needsReauth) {
      setState("needs-reauth");
    } else if (data.error) {
      setState("error");
      setErrorMsg(data.error);
    }
  }, [fetcher.state, fetcher.data]);

  const startCountdown = () => {
    setState("pending");
    setCountdown(10);
  };
  const cancelCountdown = () => {
    setState("idle");
  };
  const actuallySend = () => {
    const fd = new FormData();
    fd.append("intent", "send");
    fd.append("mailConnectionId", mailConnectionId);
    fd.append("draftId", draftId);
    fetcher.submit(fd, { method: "post" });
  };

  if (disabled) {
    return (
      <button disabled style={btnStyle({ disabled: true })} title={t("inbox.send.disabled_no_draft")}>
        {t("inbox.send.cta")}
      </button>
    );
  }

  if (state === "needs-reauth") {
    return (
      <a href={reauthUrl ?? `/app/mail-auth/reauth?mailConnectionId=${mailConnectionId}`} style={btnStyle({ variant: "reauth" })}>
        🔒 {t("inbox.send.activate")}
      </a>
    );
  }

  if (state === "sent") {
    return (
      <span style={{ color: "#22863a", fontWeight: 500 }}>
        ✓ {t("inbox.send.sent")}
      </span>
    );
  }

  if (state === "pending") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "#eef6ff", border: "1px solid #b8d4f5", borderRadius: 6 }}>
        <span>✓ {t("inbox.send.pending", { customer: customerEmail, seconds: countdown })}</span>
        <button onClick={cancelCountdown} style={{ background: "transparent", border: "1px solid #1a73e8", color: "#1a73e8", padding: "4px 10px", borderRadius: 4, cursor: "pointer" }}>
          {t("inbox.send.cancel")}
        </button>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ color: "#cb2431" }}>⚠ {errorMsg}</span>
        <button onClick={startCountdown} style={btnStyle({})}>
          {t("inbox.send.retry")}
        </button>
      </div>
    );
  }

  // idle
  return (
    <button onClick={startCountdown} style={btnStyle({ variant: "primary" })}>
      {t("inbox.send.cta")}
    </button>
  );
}

function btnStyle(opts: { variant?: "primary" | "reauth"; disabled?: boolean }) {
  return {
    background: opts.disabled ? "#e0e0e0" : (opts.variant === "reauth" ? "#f5f5f5" : "#1a1a1a"),
    color: opts.disabled ? "#999" : (opts.variant === "reauth" ? "#1a1a1a" : "white"),
    border: opts.variant === "reauth" ? "1px solid #ccc" : "none",
    padding: "10px 20px",
    borderRadius: 6,
    fontWeight: 500,
    cursor: opts.disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    textDecoration: "none",
    display: "inline-block",
  } as const;
}
```

- [ ] **Step 2: Add i18n keys**

In `app/i18n/locales/fr.json` add `inbox.send.*`:

```json
"inbox": {
  "send": {
    "cta": "Envoyer",
    "disabled_no_draft": "Générez d'abord un brouillon",
    "activate": "Activer l'envoi pour cette boîte",
    "pending": "Envoi à {{customer}} dans {{seconds}}s",
    "cancel": "Annuler",
    "sent": "Envoyé",
    "retry": "Réessayer"
  }
}
```

EN equivalents in `en.json`.

- [ ] **Step 3: Commit**

```bash
git add app/components/inbox/SendButton.tsx app/i18n/locales/fr.json app/i18n/locales/en.json
git commit -m "feat(inbox): SendButton 4-state component with 10s cancellable countdown"
```

### Task 8.2: Wire `<SendButton>` into the inbox preview pane

**Files:**
- Modify: `app/routes/app.inbox.tsx`

- [ ] **Step 1: Import the component**

```tsx
import SendButton from "../components/inbox/SendButton";
```

- [ ] **Step 2: Expose `canSend` per connection in the loader**

In `app.inbox.tsx`'s loader, find where `connections` are loaded and add the `canSend` field:

```ts
import { canSend } from "../lib/mail/scopes";
// ...
const connections = await prisma.mailConnection.findMany({
  where: { shop },
  select: { id: true, email: true, provider: true, grantedScopes: true, autoSyncEnabled: true, lastSyncError: true, lastSyncAt: true },
});
const connectionsWithCanSend = connections.map((c) => ({
  ...c,
  canSend: canSend(c),
}));
return json({
  // ... existing fields
  connections: connectionsWithCanSend,
});
```

- [ ] **Step 3: Render `<SendButton>` in the preview pane**

Find the preview pane JSX (search for "Marquer comme résolu" button). Add `<SendButton>` next to it:

```tsx
{(() => {
  const connection = loaderData.connections.find((c) => c.id === selectedThread.latest.mailConnectionId);
  const draft = selectedDraft; // or whatever variable holds the current draft
  if (!connection) return null;
  return (
    <SendButton
      shop={loaderData.shop}
      mailConnectionId={connection.id}
      draftId={draft?.id ?? ""}
      customerEmail={selectedThread.latest.fromAddress}
      canSend={connection.canSend}
      reauthUrl={`/app/mail-auth/reauth?mailConnectionId=${connection.id}&returnTo=/app/inbox?thread=${selectedThread.id}`}
      initialSentAt={draft?.sentAt ?? null}
      disabled={!draft}
    />
  );
})()}
```

- [ ] **Step 4: Add the `intent === "send"` branch in the action**

In `app.inbox.tsx`'s action handler, add:

```ts
if (intent === "send") {
  const mailConnectionId = String(formData.get("mailConnectionId") ?? "");
  const draftId = String(formData.get("draftId") ?? "");
  if (!mailConnectionId || !draftId) return json({ error: "missing_params" }, { status: 400 });
  const { handleSendDraft } = await import("../lib/support/inbox-actions");
  const result = await handleSendDraft({ shop, mailConnectionId, draftId });
  return json(result);
}
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck 2>&1 | grep "app.inbox.tsx" | head -5
```
Expected: no NEW errors related to send (pre-existing inbox.tsx errors are OK).

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat(inbox): wire SendButton + intent=send action into inbox preview"
```

---

## Phase 9 — Safety env var + final integration tests + docs

### Task 9.1: Implement `runFakeSendForInternalShop` (SEND_DISABLED_FOR_INTERNAL)

**Files:**
- Modify: `app/lib/support/inbox-actions.ts`

- [ ] **Step 1: Replace the stub from Task 5.3**

In `handleSendDraft`, replace the `runFakeSendForInternalShop` stub with the full implementation. It must run the SAME flow (atomic CAS, assemble, insert outgoing, transition thread, etc.) but skip the actual `client.send()` call and use a fake `SendResult`:

```ts
async function runFakeSendForInternalShop(params: {
  shop: string;
  conn: MailConnection;
  draftId: string;
}): Promise<SendDraftResult> {
  const { shop, conn, draftId } = params;
  // CAS reserve
  const reserved = await prisma.replyDraft.updateMany({
    where: { id: draftId, sentAt: null, sendingStartedAt: null },
    data: { sendingStartedAt: new Date(), sendError: null },
  });
  if (reserved.count === 0) return { error: "already_sent_or_sending" };

  // Load draft + thread + incoming
  const draft = await prisma.replyDraft.findUnique({
    where: { id: draftId },
    include: { email: { include: { thread: true } } },
  });
  if (!draft || !draft.email.canonicalThreadId) {
    await prisma.replyDraft.update({
      where: { id: draftId },
      data: { sendingStartedAt: null, sendError: "fake_send_missing_thread" },
    });
    return { error: "draft_not_found_or_thread_unresolved" };
  }

  const payload = assembleRfc822({
    shop,
    mailbox: { email: conn.email },
    customer: { email: draft.email.fromAddress, name: draft.email.fromName ?? "" },
    originalIncoming: {
      rfcMessageId: draft.email.rfcMessageId,
      receivedAt: draft.email.receivedAt,
      subject: draft.email.subject,
      bodyText: draft.email.bodyText,
    },
    thread: { references: buildReferencesChain(draft.email.rfcReferences, draft.email.rfcMessageId) },
    draftBody: draft.body ?? "",
  });

  const fakeResult = {
    externalMessageId: `fake-internal-${Date.now()}`,
    rfcMessageId: payload.rfcMessageId,
  };

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const outgoing = await tx.incomingEmail.create({
      data: {
        shop, mailConnectionId: conn.id,
        externalMessageId: fakeResult.externalMessageId,
        rfcMessageId: fakeResult.rfcMessageId,
        inReplyTo: draft.email.rfcMessageId,
        rfcReferences: payload.references,
        fromAddress: conn.email,
        toAddresses: draft.email.fromAddress,
        subject: payload.subject,
        bodyText: payload.bodyText,
        receivedAt: now,
        canonicalThreadId: draft.email.canonicalThreadId!,
        processingStatus: "outgoing",
        tier1Result: "outgoing",
        sourceMarker: "sent_from_app",  // same marker as real send
      },
    });
    const updatedDraft = await tx.replyDraft.update({
      where: { id: draftId },
      data: {
        sentAt: now,
        sentRfcMessageId: fakeResult.rfcMessageId,
        sendingStartedAt: null,
        sendError: null,
        linkedOutgoingEmailId: outgoing.id,
      },
    });
    await tx.thread.update({
      where: { id: draft.email.canonicalThreadId! },
      data: { operationalState: "waiting_customer", lastStateChangeAt: now },
    });
    await tx.threadStateHistory.create({
      data: {
        shop,
        threadId: draft.email.canonicalThreadId!,
        fromState: draft.email.thread!.operationalState,
        toState: "waiting_customer",
        reason: "draft_sent_fake_internal",
      },
    });
    return updatedDraft;
  });

  console.log(`[send] FAKE SEND for internal shop ${shop} draftId=${draftId} (SEND_DISABLED_FOR_INTERNAL=true)`);
  return { sent: true, sentAt: result.sentAt!, rfcMessageId: result.sentRfcMessageId! };
}
```

- [ ] **Step 2: Add integration test for the safety bypass**

Add to `app/lib/__tests__/integration/send-draft.test.ts`:

```ts
it("SEND_DISABLED_FOR_INTERNAL=true + isInternal shop: fake send runs without provider call", async () => {
  process.env.SEND_DISABLED_FOR_INTERNAL = "true";
  try {
    await prisma.shopFlag.upsert({
      where: { shop: TEST_SHOP },
      create: { shop: TEST_SHOP, isInternal: true, firstInstallDate: new Date(), onboardingCompletedAt: new Date() },
      update: { isInternal: true },
    });
    const conn = await seedMailConnection(TEST_SHOP, { provider: "gmail", email: "s@b.com", grantedScopes: "https://www.googleapis.com/auth/gmail.readonly" });  // missing send scope on purpose!
    const thread = await seedThread(TEST_SHOP, conn.id);
    const incoming = await seedIncomingEmail(TEST_SHOP, conn.id, thread.id);
    const draft = await prisma.replyDraft.create({ data: { shop: TEST_SHOP, emailId: incoming.id, body: "hi" } });

    const sendSpy = vi.fn();
    (createMailClient as any).mockResolvedValue({ send: sendSpy, findSentByRfcMessageId: vi.fn() });

    const result = await handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id });
    expect(result).toMatchObject({ sent: true });
    expect(sendSpy).not.toHaveBeenCalled();  // bypass: no provider call

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sentRfcMessageId).toMatch(/@/);

    const outgoing = await prisma.incomingEmail.findFirst({ where: { sourceMarker: "sent_from_app" } });
    expect(outgoing?.externalMessageId).toContain("fake-internal-");
  } finally {
    delete process.env.SEND_DISABLED_FOR_INTERNAL;
  }
});
```

Note the test bypasses the `canSend` check too — that's intentional, the internal bypass should work even without proper scopes (so we can test the UX before doing the OAuth re-consent dance).

Adjust `handleSendDraft` if needed so the internal-bypass branch runs BEFORE the `canSend` check.

- [ ] **Step 3: Run all integration tests**

```bash
npm run test:integration -- app/lib/__tests__/integration/send-draft.test.ts
```
Expected: 6/6 PASS (5 original + 1 new).

- [ ] **Step 4: Add the UI banner**

In `app/routes/app.inbox.tsx`, surface the safety flag via the loader:

```ts
const sendDisabled = process.env.SEND_DISABLED_FOR_INTERNAL === "true" && shopFlag?.isInternal === true;
// add `sendDisabled` to the loader return
```

In the JSX, render a permanent banner at the top of the inbox when `sendDisabled === true`:

```tsx
{loaderData.sendDisabled && (
  <div style={{ padding: "10px 16px", background: "#fff3cd", border: "1px solid #ffeeba", borderRadius: 6, marginBottom: 16, color: "#856404" }}>
    🧪 {t("inbox.send.internal_banner")}
  </div>
)}
```

Add i18n key:
```json
"inbox.send.internal_banner": "Envois désactivés (boutique interne) — cliquez quand même pour tester le flow"
```

- [ ] **Step 5: Typecheck + Commit**

```bash
npm run typecheck 2>&1 | grep -E "inbox-actions|app.inbox"
git add app/lib/support/inbox-actions.ts app/lib/__tests__/integration/send-draft.test.ts app/routes/app.inbox.tsx app/i18n/locales/fr.json app/i18n/locales/en.json
git commit -m "feat(inbox): SEND_DISABLED_FOR_INTERNAL safety bypass + UI banner"
```

### Task 9.2: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Remove the "Out of scope" line about email sending**

Find the "Out of scope" section in CLAUDE.md. Remove the line:
```
- Automatic email sending (the merchant always reviews + sends manually)
```

Replace it with:
```
- **Auto-send** (sending without user click). User-triggered send IS supported via the "Envoyer" button (v1 shipped 2026-05-XX) — see the Email Send section below for details. Auto-send remains out of scope.
```

- [ ] **Step 2: Add an "Email Send v1" section**

Add a new section to CLAUDE.md:

```markdown
## Email Send v1

The merchant can send a draft directly from the inbox via the « Envoyer » button. Implementation specifics:

- **User-triggered only.** Click → 10s cancellable countdown toast → actual API send. No auto-send.
- **Providers.** Gmail (gmail.send), Outlook (Mail.Send + create-draft/send pattern), Zoho (messages.ALL).
- **Re-consent JIT.** Existing connections (read-only) trigger a redirect to `/app/mail-auth/reauth` on first Send click — explainer page + provider OAuth → adds the send scope.
- **Idempotency.** Atomic CAS on `ReplyDraft.sendingStartedAt` blocks double-click. Cleanup cron in auto-sync tick releases stuck drafts after 5 min and sets `sendError = "send_timeout_released"`. Retry path checks the Sent folder via `findSentByRfcMessageId` before re-sending to avoid double-send.
- **Pre-emptive outgoing insert.** On send success, we INSERT an `IncomingEmail` row immediately with `sourceMarker = "sent_from_app"` and `processingStatus = "outgoing"`. Customer replies arriving before the next sync still reconcile correctly to the same thread. The next sync ingests the real Sent-folder message and dedups via `externalMessageId`.
- **Post-send state.** Thread `operationalState` → `waiting_customer` immediately, with a `ThreadStateHistory` entry (`reason = "draft_sent"`).
- **Safety.** Env var `SEND_DISABLED_FOR_INTERNAL=true` + `ShopFlag.isInternal = true` short-circuits the actual provider call but runs the entire DB flow with a fake `SendResult`. UI shows a permanent yellow banner. Production sets this env var to false (or unset).
- **What's NOT included v1.** HTML body (plain text only), attachments, CC/BCC, scheduled send beyond the 10s client-side delay, "send & resolve" toggle (always waiting_customer), bounce auto-handling, undo-after-send, newer-message-warning.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): document Email Send v1 + remove out-of-scope line"
```

### Task 9.3: Final sanity check

**Files:** none

- [ ] **Step 1: Full unit + integration suite**

```bash
npm test
npm run test:integration
```
Expected: all PASS. Pre-existing flakiness (Neon serverless connection drops) is OK — re-run failing files individually to confirm they pass in isolation.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck 2>&1 | grep -c "error TS"
```
Compare to baseline (currently ~69 pre-existing). Should be at or below.

- [ ] **Step 3: Verify the migration is in place**

```bash
ls prisma/migrations/ | grep email_send_v1
```
Expected: the migration directory exists. On Render boot, `prisma migrate deploy` will pick it up automatically.

- [ ] **Step 4: No commit (verification only)**

---

## Out of scope (deferred to v2+)

These items were considered but excluded from v1 per the design discussion:

- Auto-send on confidence threshold
- Modal confirmation per click (delayed 10s replaces it)
- HTML body / multipart MIME / inline images
- Attachments (`DraftAttachment` exists but not wired to send)
- CC / BCC
- Scheduled send beyond the 10s delay
- "Send & resolve" checkbox (always `waiting_customer` after send)
- Bounce auto-handling (merchant sees bounces in their normal inbox)
- Undo after the 10s window
- Newer-message warning ("Un nouveau message client est arrivé pendant que vous rédigiez...")
- E2E Playwright tests (deferred per user request)

---

## Self-review notes (for the engineer executing this plan)

Watch for these patterns that are easy to break:

- **The 10s countdown is client-side only.** Closing the tab cancels the send. This is documented in the spec as a fail-safe.
- **Phase 5 mocks the entire `client-factory.ts`.** If the existing codebase has the factory under a different path, update the mock target in the tests.
- **Phase 9's safety bypass MUST run BEFORE `canSend`.** Otherwise internal shops with read-only scope hit `needsReauth` instead of the fake-send flow, defeating the testing purpose.
- **The provider `send()` calls may take 1-3s.** Don't wrap the action in a tight timeout — `handleSendDraft` should have at least 30s to complete the API round-trip + DB transaction.
- **`fromName` is not yet pulled from settings.** Phase 5 leaves it empty; a future task can read from `ShopSetting.senderName` or similar.
- **`ThreadStateHistory` doesn't have `triggeredBy`.** Task 1.1 adds the `reason` column instead. The model also requires `shop`. The plan reflects this — if you encounter `triggeredBy` references during execution, that's a leftover, drop it.
- **`IncomingEmail` has no `toAddresses` column.** The pre-emptive outgoing row stores `fromAddress = conn.email` only; the recipient is implied by the thread's customer-side participant. v2 may add a dedicated column if needed.
