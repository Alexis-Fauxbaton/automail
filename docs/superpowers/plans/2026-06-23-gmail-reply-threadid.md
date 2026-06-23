# Gmail reply co-threading via threadId — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make app-sent Gmail replies land in the same Gmail conversation as the message being replied to, by passing the original `threadId` to `messages.send`.

**Architecture:** Add an optional `providerThreadId` to `SendPayload`. `handleSendDraft` resolves the Gmail `threadId` from the replied-to message's canonical-thread provider mapping and attaches it. The Gmail `send` adapter passes it to `messages.send`, with a one-shot fallback to a no-`threadId` send if Gmail rejects it. Outlook/Zoho ignore the field.

**Tech Stack:** TypeScript, googleapis, Prisma (Postgres/Neon), Vitest.

## Global Constraints

- TypeScript only.
- Only Gmail consumes `providerThreadId`; Outlook (`createReply`) and Zoho are unchanged.
- Forward-looking fix: already-split canonical threads are not healed.
- A failed Gmail send creates no message, so retrying without `threadId` cannot double-send.
- Multi-tenant: the thread-id lookup is scoped by `shop`.
- Do NOT run `test:integration` against the prod-pointing DB without explicit user approval (resetTestDb only touches `integration-test.myshopify.com`).
- Unit tests + typecheck may be run freely. Commit on the current branch `fix/gmail-reply-threadid`; do not push unless asked.

---

### Task 1: Gmail `send` passes `threadId` (with fallback)

**Files:**
- Modify: `app/lib/mail/types.ts` (add `providerThreadId?` to `SendPayload`, after `inReplyToExternalMessageId`)
- Modify: `app/lib/gmail/mail-client.ts` (`send`, lines 49-74)
- Test: `app/lib/gmail/__tests__/mail-client-send.test.ts` (new)

**Interfaces:**
- Produces: `SendPayload.providerThreadId?: string` — the provider-native thread/conversation id to co-thread into (Gmail only).

- [ ] **Step 1: Write the failing test** — create `app/lib/gmail/__tests__/mail-client-send.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
const getMock = vi.fn();

vi.mock("googleapis", () => ({
  google: { gmail: () => ({ users: { messages: { send: sendMock, get: getMock } } }) },
}));
vi.mock("../auth", () => ({
  getAuthenticatedClientByConnection: vi.fn().mockResolvedValue({}),
}));

import { createGmailClient } from "../mail-client";
import type { MailConnection } from "@prisma/client";
import type { SendPayload } from "../../mail/types";

const CONN = { id: "c1" } as unknown as MailConnection;
const PAYLOAD: SendPayload = {
  rfcMessageId: "out@x.com",
  inReplyToRfcId: "orig@x.com",
  references: "<orig@x.com>",
  fromEmail: "s@b.com",
  toEmails: ["c@g.com"],
  subject: "Re: hi",
  bodyText: "<p>hi</p>",
};

describe("Gmail send — threadId", () => {
  beforeEach(() => {
    sendMock.mockReset();
    getMock.mockReset();
    getMock.mockResolvedValue({
      data: { payload: { headers: [{ name: "Message-ID", value: "<srv@x.com>" }] } },
    });
  });

  it("includes threadId when payload.providerThreadId is set", async () => {
    sendMock.mockResolvedValue({ data: { id: "m1" } });
    const client = await createGmailClient(CONN);
    await client.send({ ...PAYLOAD, providerThreadId: "T1" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].requestBody).toMatchObject({ threadId: "T1" });
    expect(sendMock.mock.calls[0][0].requestBody.raw).toBeTruthy();
  });

  it("omits threadId when not provided", async () => {
    sendMock.mockResolvedValue({ data: { id: "m1" } });
    const client = await createGmailClient(CONN);
    await client.send(PAYLOAD);
    expect(sendMock.mock.calls[0][0].requestBody.threadId).toBeUndefined();
  });

  it("retries once WITHOUT threadId when the threadId send fails", async () => {
    sendMock
      .mockRejectedValueOnce(new Error("Gmail 400 invalid threadId"))
      .mockResolvedValueOnce({ data: { id: "m2" } });
    const client = await createGmailClient(CONN);
    const res = await client.send({ ...PAYLOAD, providerThreadId: "BAD" });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][0].requestBody.threadId).toBe("BAD");
    expect(sendMock.mock.calls[1][0].requestBody.threadId).toBeUndefined();
    expect(res.externalMessageId).toBe("m2");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run app/lib/gmail/__tests__/mail-client-send.test.ts`
Expected: FAIL — `providerThreadId` not on `SendPayload` (type error) and/or threadId never included.

- [ ] **Step 3: Add the field** to `SendPayload` in `app/lib/mail/types.ts`, right after the `inReplyToExternalMessageId?: string;` line:

```ts
  /**
   * Provider-native thread/conversation id to co-thread the reply into.
   * Gmail passes this to messages.send so the reply lands in the same Gmail
   * thread (headers alone don't guarantee this). Outlook/Zoho ignore it.
   */
  providerThreadId?: string;
```

- [ ] **Step 4: Update the Gmail `send`** in `app/lib/gmail/mail-client.ts`. Replace:

```ts
    async send(payload: SendPayload): Promise<SendResult> {
      // Build RFC822 raw message in base64url (Gmail requirement).
      const raw = renderRfc822(payload);
      const base64url = Buffer.from(raw, "utf-8").toString("base64url");
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: base64url },
      });
```

With:

```ts
    async send(payload: SendPayload): Promise<SendResult> {
      // Build RFC822 raw message in base64url (Gmail requirement).
      const raw = renderRfc822(payload);
      const base64url = Buffer.from(raw, "utf-8").toString("base64url");
      // Pass the original conversation's threadId so the reply lands in the
      // same Gmail thread — headers (In-Reply-To/References) alone do NOT
      // guarantee this; without threadId Gmail starts a new conversation.
      // If Gmail rejects the threadId (e.g. subject mismatch / stale thread),
      // retry once without it so Send still succeeds. A failed send creates no
      // message, so the retry cannot double-send.
      let res;
      if (payload.providerThreadId) {
        try {
          res = await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw: base64url, threadId: payload.providerThreadId },
          });
        } catch (err) {
          console.warn(`[gmail] send with threadId failed, retrying without threadId:`, err);
          res = await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw: base64url },
          });
        }
      } else {
        res = await gmail.users.messages.send({
          userId: "me",
          requestBody: { raw: base64url },
        });
      }
```

(The rest of the method — the `gmail.users.messages.get` Message-ID read and the return — is unchanged.)

- [ ] **Step 5: Run the test, verify it passes**

Run: `npx vitest run app/lib/gmail/__tests__/mail-client-send.test.ts`
Expected: PASS (3/3).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.json` — no NEW errors in `app/lib/mail/types.ts` or `app/lib/gmail/mail-client.ts`.
```bash
git add app/lib/mail/types.ts app/lib/gmail/mail-client.ts app/lib/gmail/__tests__/mail-client-send.test.ts
git commit -m "fix(gmail): pass original threadId to messages.send so replies co-thread"
```

---

### Task 2: Resolve and attach the Gmail threadId in `handleSendDraft`

**Files:**
- Modify: `app/lib/support/inbox-actions.ts` (`handleSendDraft` — between loading `draft` and assembling `payload`, ~lines 990-1031)
- Test: `app/lib/__tests__/integration/send-draft.test.ts` (add one case)

**Interfaces:**
- Consumes: `SendPayload.providerThreadId?` (Task 1); `prisma.threadProviderId` rows `{ shop, provider, providerThreadId, canonicalThreadId }`.

- [ ] **Step 1: Write the failing test** — add this case inside the `describe("handleSendDraft — integration", …)` block in `app/lib/__tests__/integration/send-draft.test.ts`:

```ts
  it("passes the Gmail thread id to the mail client so the reply co-threads", async () => {
    const conn = await seedMailConnection({
      shop: TEST_SHOP,
      provider: "gmail",
      email: "thread@brand.com",
      grantedScopes: "https://www.googleapis.com/auth/gmail.send",
    });
    const thread = await seedThread({ shop: TEST_SHOP, mailConnectionId: conn.id });
    await prisma.threadProviderId.create({
      data: { shop: TEST_SHOP, provider: "gmail", providerThreadId: "GTHREAD123", canonicalThreadId: thread.id },
    });
    const incoming = await seedIncomingEmail({
      shop: TEST_SHOP,
      mailConnectionId: conn.id,
      canonicalThreadId: thread.id,
      rfcMessageId: "orig@gmail.com",
    });
    const draft = await prisma.replyDraft.create({ data: { shop: TEST_SHOP, emailId: incoming.id, body: "hi" } });

    let captured: any;
    (createMailClient as any).mockResolvedValue({
      send: vi.fn().mockImplementation(async (p: any) => {
        captured = p;
        return { externalMessageId: "x", rfcMessageId: "y@gmail.com" };
      }),
      findSentByRfcMessageId: vi.fn().mockResolvedValue(null),
    });

    const res = await handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id });
    expect(res).toMatchObject({ sent: true });
    expect(captured.providerThreadId).toBe("GTHREAD123");
  });
```

- [ ] **Step 2: Run the test, verify it fails** (only if integration run is approved — otherwise skip to Step 3 and rely on the post-implementation run)

Run (after user approval): `npx cross-env NODE_ENV=test vitest run --config vitest.integration.config.ts send-draft`
Expected: FAIL — `captured.providerThreadId` is `undefined`.

- [ ] **Step 3: Resolve + attach the threadId** in `app/lib/support/inbox-actions.ts`, inside `handleSendDraft`. Immediately AFTER the `const thread = draft.email.thread!;` line (just before the CAS reserve at step 3), insert:

```ts
  // Gmail: co-thread the reply into the original conversation by passing its
  // Gmail threadId to messages.send. Resolve it from the canonical thread's
  // provider mapping. Other providers ignore providerThreadId.
  let providerThreadId: string | undefined;
  if (conn.provider === "gmail" && draft.email.canonicalThreadId) {
    const mapping = await prisma.threadProviderId.findFirst({
      where: { shop, provider: "gmail", canonicalThreadId: draft.email.canonicalThreadId },
      select: { providerThreadId: true },
    });
    providerThreadId = mapping?.providerThreadId ?? undefined;
  }
```

Then, immediately AFTER the `const payload = assembleRfc822({ … });` block, add:

```ts
  if (providerThreadId) payload.providerThreadId = providerThreadId;
```

- [ ] **Step 4: Run unit suite + typecheck**

Run: `npx vitest run` — all PASS (no DB; confirms nothing else broke).
Run: `npx tsc --noEmit -p tsconfig.json` — no NEW errors in `app/lib/support/inbox-actions.ts`.

- [ ] **Step 5: Run the integration test (after user approval)**

ASK THE USER to approve running `test:integration` (writes test-shop rows to the prod-pointing DB). On approval:
Run: `npx cross-env NODE_ENV=test vitest run --config vitest.integration.config.ts send-draft`
Expected: PASS (the new case + the existing ones).

- [ ] **Step 6: Commit**

```bash
git add app/lib/support/inbox-actions.ts app/lib/__tests__/integration/send-draft.test.ts
git commit -m "fix(send): resolve Gmail thread id and pass it through on reply send"
```

---

## Self-review notes

- **Spec coverage:** data flow steps 1-3 → Task 2 (resolve) + Task 1 (consume); `SendPayload.providerThreadId` → Task 1; threadId-rejection fallback → Task 1 Step 4 + its third test; Outlook/Zoho ignore the field → no change (verified: field is optional, only Gmail reads it); testing → both tasks.
- **Type consistency:** `providerThreadId?: string` defined in Task 1 (types.ts) and consumed in Task 2 (`payload.providerThreadId = …`) and the Gmail adapter — same name/type throughout. `prisma.threadProviderId` fields (`shop`, `provider`, `providerThreadId`, `canonicalThreadId`) match the schema used by `thread-resolver.ts`.
- **Placeholder scan:** none — every step has full code or an exact command.
