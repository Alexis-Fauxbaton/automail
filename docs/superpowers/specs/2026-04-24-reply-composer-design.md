# Reply Composer — Design Spec
**Date:** 2026-04-24  
**Status:** Approved

## Context

The app currently generates a plain-text draft reply body and displays it in a `DraftBlock` component. There is no email metadata associated with that draft: no To/CC/BCC fields, no subject, no attachments, no reply mode. This feature prepares the infrastructure for future email sending by exposing those fields in the UI and persisting them — without adding a Send button yet.

---

## Scope

### In scope
- To (read-only, pre-filled from thread)
- Subject (pre-filled `Re: <original subject>`, editable)
- CC (free text)
- BCC (free text, hidden by default behind a "+ BCC" link)
- Attachments: upload from PC + select from thread attachments
- Reply mode: in-thread (default) or new thread (hidden advanced option)
- Auto-save of all fields
- Orphan file cleanup

### Out of scope
- Sending the email (no Send button)
- Attachment preview/viewer
- Attachment size limits enforcement (deferred)
- Multiple recipients in To field

---

## Data Model

### New model: `ReplyDraft`

Replaces the existing `draftReply` and `draftHistory` fields on `IncomingEmail`. Stores all compose state for the outgoing reply.

```prisma
model ReplyDraft {
  id          String   @id @default(cuid())
  shop        String
  emailId     String   @unique
  email       IncomingEmail @relation(fields: [emailId], references: [id], onDelete: Cascade)

  body        String?  // the draft reply text (moved from IncomingEmail.draftReply)
  bodyHistory Json?    // version history (moved from IncomingEmail.draftHistory)

  subject     String?  // pre-filled Re: <original>, editable
  cc          String?  // comma-separated
  bcc         String?  // comma-separated
  replyMode   String   @default("thread")  // "thread" | "new_thread"

  attachments DraftAttachment[]

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

`IncomingEmail.draftReply` and `IncomingEmail.draftHistory` are removed. All code that reads/writes those fields migrates to `ReplyDraft`.

### New model: `DraftAttachment`

```prisma
model DraftAttachment {
  id                  String      @id @default(cuid())
  shop                String
  replyDraftId        String
  replyDraft          ReplyDraft  @relation(fields: [replyDraftId], references: [id], onDelete: Cascade)

  fileName            String
  mimeType            String
  sizeBytes           Int
  source              String      // "upload" | "thread"
  storagePath         String?     // relative path for source="upload"
  threadAttachmentRef String?     // original ref for source="thread" (not re-stored)

  createdAt           DateTime    @default(now())
}
```

---

## File Storage (Approach A — Disk)

### Storage location
`uploads/<shop>/<emailId>/<cuid>-<originalFilename>`

Stored relative to project root. The `cuid` prefix prevents filename collisions.

### Storage interface
`app/lib/attachments/storage.ts` exposes:
```ts
save(shop: string, emailId: string, file: File): Promise<{ storagePath: string }>
getUrl(storagePath: string): string
remove(storagePath: string): Promise<void>
```

This interface is the only place that knows about disk vs cloud. Switching to Approach C only requires reimplementing this module.

### Cleanup rules
1. **On DraftAttachment delete**: `remove(storagePath)` called synchronously before DB delete.
2. **On upload failure**: if DB insert fails after file write, `remove(storagePath)` is called in the catch block.
3. **On boot orphan scan**: at app startup, scan `uploads/` directory, cross-reference all `storagePath` values in DB, delete files with no DB entry. Runs once, lightweight.
4. **After successful send**: delete the entire `ReplyDraft` and all its `DraftAttachment` records (+ files on disk). Compose state is transient; the sent email lives in the mail client.
5. **7-day retention**: a scheduled cleanup (boot scan or lightweight cron) deletes uploaded `DraftAttachment` files older than 7 days. The UI shows a small tooltip on the PJ section: "Les fichiers ajoutés sont conservés 7 jours." Thread attachment references (source `"thread"`) are never stored on disk and are unaffected by this rule.

### Future migration to cloud (Approach C — S3/R2)
Replace the body of `storage.ts` with an S3/R2 client implementation. The `storagePath` field becomes a bucket key. No changes required in DB schema, routes, or UI. Steps:
1. Add cloud credentials to env
2. Reimplement `storage.ts` (save → `client.putObject`, remove → `client.deleteObject`, getUrl → signed URL or CDN URL)
3. Migrate existing files with a one-time script
4. Remove the `uploads/` directory

---

## API Routes

> **Security note:** `shop` is never accepted from the request body. All routes extract it from the Shopify session (via `authenticate.admin`) and use it to scope DB queries. This prevents cross-shop data access.

### `POST /api/draft-attachment`
- Accepts `multipart/form-data` with `file`, `emailId`
- `shop` extracted from Shopify session
- Saves file via `storage.save()`
- Creates `DraftAttachment` record (upserts `ReplyDraft` if not yet created)
- Returns `{ id, fileName, mimeType, sizeBytes, source: "upload" }`

### `DELETE /api/draft-attachment/:id`
- `shop` extracted from Shopify session
- Looks up `DraftAttachment` by id **and** shop (prevents cross-shop deletion)
- Calls `storage.remove(storagePath)`
- Deletes DB record

### `POST /api/reply-draft`
- Accepts `{ emailId, subject?, cc?, bcc?, replyMode?, body? }`
- `shop` extracted from Shopify session
- Upserts `ReplyDraft` record scoped to shop + emailId
- Used by the auto-save debounce for all non-attachment fields

---

## UI

### DraftBlock extension

The existing `DraftBlock` component gains a header section above the draft body. All new fields are styled to match the current clean aesthetic (minimal borders, light labels, no heavy chrome).

```
┌─────────────────────────────────────────────────┐
│ À :     client@example.com         (read-only)  │
│ Objet : Re: Urgent attente réponse  [editable]  │
│ CC :    [champ libre]               [+ BCC]     │
│ BCC :   [caché par défaut]                      │
│                                                 │
│ PJ : [📎 upload.pdf ×]  [+ Ajouter]            │
│      Thread: [☐ facture.pdf]  [☑ retour.pdf]   │
│─────────────────────────────────────────────────│
│ [corps du brouillon — inchangé]                 │
│ ...                                             │
│ [Raffiner / Regénérer / Versions]               │
│                                                 │
│ ▸ Options avancées                              │
│   ○ Répondre dans ce thread  (défaut)           │
│   ○ Nouveau thread                              │
└─────────────────────────────────────────────────┘
```

**Fields:**
- **À** — read-only, pre-filled from the thread's sender email
- **Objet** — pre-filled `Re: <original subject>` on first load, editable
- **CC** — free text input, empty by default
- **BCC** — hidden; a small "+ BCC" link reveals the field
- **PJ (uploads)** — list of uploaded files with × to remove; "+ Ajouter" opens a file picker
- **PJ (thread)** — checkboxes for attachments already present in the thread
- **Options avancées** — collapsed disclosure; contains reply mode radio buttons

**Visual constraints:** Match existing inbox style. No heavy panels or borders. Labels in muted text. Advanced options tucked away.

### Auto-save behavior
- CC, BCC, Subject, reply mode, draft body: **800ms debounce** after last keystroke → calls `POST /api/reply-draft`
- File upload: **immediate** on file select → calls `POST /api/draft-attachment`
- File remove: **immediate** → calls `DELETE /api/draft-attachment/:id`
- No "Saving..." spinner (too noisy); only show error state if save fails

---

## Files to Create or Modify

| File | Action | Notes |
|------|--------|-------|
| `prisma/schema.prisma` | Modify | Add `ReplyDraft`, `DraftAttachment`; remove `draftReply`/`draftHistory` from `IncomingEmail` |
| `prisma/migrations/...` | Create | Migration for schema changes |
| `app/lib/attachments/storage.ts` | Create | Disk storage interface |
| `app/routes/api.draft-attachment.tsx` | Create | POST + DELETE for file uploads |
| `app/routes/api.reply-draft.tsx` | Create | POST for compose metadata upsert |
| `app/routes/app.inbox.tsx` | Modify | Extend `DraftBlock`; migrate draft read/write to `ReplyDraft` |
| `app/lib/support/llm-draft.ts` | Modify | Read/write `ReplyDraft.body` instead of `IncomingEmail.draftReply` |
| `app/lib/gmail/refine-draft.ts` | Modify | Same migration |
| `server.ts` or `entry.server.tsx` | Modify | Add boot orphan scan |

---

## Unit Tests

New modules follow the existing pattern in `app/lib/support/__tests__/`.

| Module | What to test |
|--------|-------------|
| `app/lib/attachments/storage.ts` | `save()` writes file at expected path; `remove()` deletes it; `remove()` on missing path doesn't throw |
| `app/lib/attachments/cleanup.ts` | Orphan detection returns correct file list given a mock dir vs mock DB entries; 7-day filter correctly identifies expired uploads |
| Subject pre-fill logic | `Re: <subject>` generated correctly; strips existing `Re: ` prefix to avoid `Re: Re:`; handles empty subject |
| `ReplyDraft` upsert | Creates draft when none exists; updates existing draft without overwriting unrelated fields |

Tests use mocked `fs` and a mocked Prisma client — no real disk or DB access.

---

## Verification

1. **Schema**: `npx prisma migrate dev` applies cleanly; no data loss on existing draft bodies
2. **Upload flow**: Upload a file → appears in PJ list → refresh page → still there → delete it → gone from disk and DB
3. **Thread attachments**: Open a thread with attachments in the original email → they appear as checkboxes → check one → save → reopen → still checked
4. **Field persistence**: Fill CC/BCC/Subject → close thread accordion → reopen → values still there
5. **Subject pre-fill**: New thread with no prior `ReplyDraft` → Subject pre-filled as `Re: <original>`
6. **Orphan scan**: Upload file → crash-simulate (manually delete DB record) → restart app → file gone from disk
7. **Reply mode**: Expand "Options avancées" → switch to "Nouveau thread" → save → reopen → still selected
8. **Existing tests**: Run `npm test` — no regressions in pipeline, draft generation, or intent tests
