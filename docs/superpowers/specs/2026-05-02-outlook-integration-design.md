# Outlook Integration Design

**Date:** 2026-05-02  
**Status:** Approved

## Overview

Add Microsoft Outlook as a third mail provider to the automail app, reaching full feature parity with the existing Gmail integration. Uses Microsoft Graph API (OAuth2), supporting both personal accounts (outlook.com, hotmail.com, live.com) and professional accounts (Microsoft 365 / Exchange Online).

## Scope

- OAuth2 connection flow via Microsoft Identity Platform
- Incremental sync via Microsoft Graph delta query
- 60-day historical backfill
- Full ingestion pipeline: prefilter → classify → analyze → draft
- Settings UI extension (connect/disconnect Outlook account)
- No changes to Gmail or Zoho behavior

Out of scope: sending replies directly from the app (remains copy-paste draft only, per MVP rules).

## Architecture

### New module: `app/lib/outlook/`

Mirrors the `app/lib/gmail/` structure:

```
app/lib/outlook/
├── auth.ts          # OAuth2 flow: getAuthUrl, exchangeCodeForTokens, refreshTokens, getAuthenticatedClient
├── client.ts        # Raw Microsoft Graph API calls: fetchDeltaMessages, fetchHistoricalMessages, getMessage
├── mail-client.ts   # Adapter implementing the MailClient interface
└── pipeline.ts      # Ingestion pipeline: prefilter → thread-resolve → classify → analyze → persist
```

### Reused without modification

- `app/lib/mail/oauth-state.ts` — HMAC-signed OAuth state (extend provider type to include `"outlook"`)
- `app/lib/mail/thread-resolver.ts` — canonical thread consolidation via RFC 5322 headers
- `app/lib/mail/job-queue.ts` + `auto-sync.ts` — job scheduling and execution (already provider-agnostic)
- `app/lib/gmail/crypto.ts` — AES-256 token encryption at rest
- `app/lib/support/orchestrator.ts` — Shopify analysis + draft generation
- `app/routes/mail-auth.tsx` — OAuth callback route (extended to handle `provider=outlook`)

### Schema changes

One new field on `MailConnection`, one migration:

```prisma
model MailConnection {
  // ...existing fields...
  deltaToken   String?   // Microsoft Graph delta sync cursor (equivalent to historyId for Gmail)
}
```

The `provider` field is a plain `String` in Prisma (not an enum) — no schema change needed for it. Only the `deltaToken` field requires a migration.

## OAuth Flow

### Azure AD app registration (one-time setup)

- Account types: "Accounts in any organizational directory and personal Microsoft accounts" (multi-tenant)
- Redirect URI: `https://<domain>/mail-auth`
- Required scopes: `Mail.Read`, `offline_access`
- New environment variables: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`

### Authorization flow

```
1. User clicks "Connect Outlook" in settings
2. auth.ts:getAuthUrl(shop) builds Microsoft Identity Platform URL
   - endpoint: https://login.microsoftonline.com/common/oauth2/v2.0/authorize
   - scopes: Mail.Read offline_access
   - state: HMAC-signed { provider: "outlook", shop, t: timestamp, n: nonce }
3. Microsoft redirects to /mail-auth?code=...&state=<signed>
4. mail-auth.tsx verifies HMAC signature + 10-min TTL (existing logic, unchanged)
5. auth.ts:exchangeCodeForTokens(code) → access_token + refresh_token + expiry
6. Tokens stored in MailConnection: AES-256 encrypted, tokenExpiry set
7. getAuthenticatedClient() auto-refreshes when tokenExpiry < now + 60s
```

### Microsoft vs Gmail differences

| Point | Gmail | Outlook |
|-------|-------|---------|
| Auth endpoint | `accounts.google.com` | `login.microsoftonline.com/common/oauth2/v2.0` |
| Refresh mechanism | `access_type=offline` param | `offline_access` in scopes |
| Sync cursor | `historyId` (string) | `deltaToken` (opaque string) |
| Cursor expiry | Does not expire | Expires after ~30 days of inactivity |

## Sync Pipeline

### Incremental sync — delta query

```
GET /me/mailFolders/inbox/messages/delta?$deltaToken=<token>
→ returns new/modified messages since last delta call
→ response includes new deltaToken for next call
```

On first sync (no `deltaToken`): fetch messages from the last 7 days, then store the returned `deltaToken`.

The `deltaToken` is stored in `MailConnection.deltaToken` after every successful sync.

**Delta token expiry:** If Microsoft returns `410 Gone`, reset `deltaToken = null` and trigger a partial backfill (last 7 days). This is handled in `client.ts` and surfaced to the job runner.

### Ingestion pipeline (`pipeline.ts`)

```
1. client.ts:fetchDeltaMessages(deltaToken?) → new Graph messages
2. Prefilter → reject promotions, newsletters, system emails
   - Uses Outlook categories: "Promotions", "Newsletters", "Social updates"
   - Uses inferenceClassification: "focused" / "other"
   - Rejects system senders (no-reply@*, noreply@*, etc.) — same logic as Gmail prefilter
3. Thread resolver → attach to canonical Thread via In-Reply-To / References headers
4. Tier2 classifier (LLM) → support intent detection
5. Orchestrator → Shopify lookup + draft generation
6. Persist IncomingEmail, update Thread
7. Store new deltaToken in MailConnection
```

### Historical backfill

Uses existing `"backfill"` job kind, extended for Outlook:

- Fetch messages from last 60 days via:  
  `GET /me/mailFolders/inbox/messages?$filter=receivedDateTime ge <iso-date>`
- Paginate via `@odata.nextLink` (equivalent to Gmail's `pageToken`)
- Same `oldestSyncedMessageAt` marker on `Thread` to track progress

## Error Handling

| Case | Behavior |
|------|----------|
| Token expired, refresh fails | Set `lastSyncError` on `MailConnection`, suspend sync, show warning in settings |
| `401 Unauthorized` | Attempt token refresh; if still 401 → mark connection as disconnected, prompt re-auth |
| `429 Too Many Requests` | Honor `Retry-After` header; exponential backoff via existing job-queue |
| `AADSTS65001` (admin consent required) | Detect at OAuth callback, show clear message: "Your Microsoft 365 admin must approve this app" |
| `410 Gone` (delta token expired) | Reset `deltaToken = null`, trigger partial backfill (last 7 days) |

## UI Changes

### Settings page

Extend the existing settings page (which already shows Gmail and Zoho sections):

- New **"Outlook / Microsoft"** section with "Connect" button
- Connected state: shows connected email address + last sync timestamp + "Disconnect" button
- If Microsoft 365 admin consent is required: show an explanatory message with a link to re-authorize with the correct permissions
- No new pages or routes required

### Inbox / thread badges

Outlook threads and emails appear in the existing inbox with a `provider: "outlook"` badge. The `Thread.provider` and `IncomingEmail` fields already store provider — no schema change needed for display.

## Testing

- Unit tests for `auth.ts`: token exchange, refresh, expiry detection, `AADSTS65001` error handling
- Unit tests for `prefilter`: Outlook-specific category rejection, system sender detection
- Unit tests for `client.ts`: delta token handling, `410 Gone` reset behavior
- Integration test for OAuth callback: verify HMAC state validation works with `provider=outlook`
- Manual smoke test: connect a personal Outlook account, receive a test support email, verify it appears in inbox with correct intent and draft
