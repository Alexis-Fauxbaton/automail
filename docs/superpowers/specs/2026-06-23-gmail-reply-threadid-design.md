# Gmail reply co-threading via threadId — Design

> Date: 2026-06-23
> Status: approved (pending written-spec review)

## Context

When the app sends a reply from a Gmail mailbox, `gmail.users.messages.send`
is called with only the raw RFC822 (In-Reply-To / References / Subject) and
**no `threadId`**. Gmail does not reliably co-thread the sent message into the
original conversation from headers alone: it assigns the reply its own
`threadId` (a single-message conversation at the API level), even though the
Gmail web UI groups it visually with the original.

In normal operation this is masked: on send the app inserts a pre-emptive
outgoing `IncomingEmail` row force-attached to the original canonical thread.
But when a mailbox is **disconnected** (cascade-deletes its threads/emails) and
**reconnected**, the backfill re-ingests the real Sent-folder message and
reconciles it by its own (different) Gmail `threadId` → it lands in a **separate
canonical thread** from the incoming. The app then shows the reply detached
from the conversation.

Confirmed by DB inspection (shop `2ed20e`, "Remboursez moi" thread): the
incoming and the app-sent reply each carry a `providerThreadId` equal to their
own message id — two distinct Gmail threads.

Provider exposure:
- **Gmail** — confirmed exposed (this design).
- **Outlook** — immune on the normal path: `send` uses
  `/me/messages/{id}/createReply`, which creates the reply inside the
  original's `conversationId`. Only the rare 404 fallback (standalone draft)
  would split.
- **Zoho** — likely not exposed for replies: Zoho groups by subject and a reply
  keeps the subject. To be confirmed by a real send; out of scope here.

## Goal

Make Gmail place the app-sent reply in the **same Gmail conversation** as the
message being replied to, so the reply shares the original `threadId` and the
canonical-thread resolver reconciles it (step 1: provider-thread-id match)
regardless of ingestion order.

## Non-goals

- Healing canonical threads that are **already** split (forward-looking fix
  only).
- Zoho / Outlook changes (Outlook immune; Zoho verified separately).
- A provider-agnostic backward RFC reconciliation net (considered and
  deferred — the threadId fix addresses the confirmed case at the source
  without the risk of merging two existing canonical threads).

## Design

### Data flow
1. `handleSendDraft` already loads `draft.email` (the message being replied to)
   and its `canonicalThreadId`. For a Gmail connection, resolve the Gmail
   `threadId` from the canonical thread's provider mapping:
   ```ts
   const mapping = await prisma.threadProviderId.findFirst({
     where: { shop, provider: "gmail", canonicalThreadId: draft.email.canonicalThreadId },
     select: { providerThreadId: true },
   });
   ```
   Attach the result to the assembled payload as `providerThreadId`.
2. `SendPayload` (`app/lib/mail/types.ts`) gains an optional
   `providerThreadId?: string`. Provider-agnostic field; only Gmail consumes it.
3. Gmail `send` (`app/lib/gmail/mail-client.ts`): when `payload.providerThreadId`
   is set, include it in the Gmail request body:
   `requestBody: { raw, threadId: payload.providerThreadId }`.
4. Outlook and Zoho `send` ignore the field — no change.

### threadId-rejection fallback
Gmail requires the message `Subject` to match the target thread's subject (it
does: `Re: <original subject>` + bracketed `References`). As defense, if the
`send` with `threadId` fails, retry **once without** `threadId`. A failed send
creates no message, so the retry cannot double-send. This keeps Send resilient
if Gmail ever rejects the threadId (e.g. a stale/foreign thread).

### Why this is sufficient
With the reply carrying the original `threadId`, the re-ingested Sent message
maps to the same `providerThreadId` → `resolveCanonicalThread` step 1 returns
the existing canonical thread for both messages, in any ingestion order. No
thread-merge logic is needed.

### Interaction with the pre-emptive row
The pre-emptive outgoing row is still inserted on the original canonical thread,
and the synced real Sent message still dedups against it by `externalMessageId`.
With the threadId fix, that synced message's `providerThreadId` now also points
at the same canonical thread — consistent on every path.

## Testing (no mail sent)
- Unit (`app/lib/gmail/__tests__/...`): Gmail `send` includes
  `requestBody.threadId` when `payload.providerThreadId` is set; omits it when
  absent; on a thrown error from the first attempt, retries once without
  `threadId` and succeeds.
- Integration (`handleSendDraft`): with a Gmail connection and a thread that has
  a `threadProviderId` mapping, the resolved `providerThreadId` is passed to the
  mail client's `send` (assert via a mocked client capturing the payload).

## Files touched
- `app/lib/mail/types.ts` — add `providerThreadId?` to `SendPayload`.
- `app/lib/support/inbox-actions.ts` — resolve + attach the Gmail threadId in
  `handleSendDraft`.
- `app/lib/gmail/mail-client.ts` — pass `threadId`; add the single fallback.
- Tests as above.
