# Outlook Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Microsoft Outlook as a third mail provider with full feature parity to Gmail (OAuth2, incremental delta sync, backfill, prefilter → classify → analyze → draft pipeline).

**Architecture:** New `app/lib/outlook/` module mirroring `app/lib/gmail/` structure — `auth.ts`, `client.ts`, `mail-client.ts`, `pipeline.ts`. Uses Microsoft Graph API via plain `fetch` (no SDK). Wires into the existing job queue and pipeline without touching Gmail/Zoho code.

**Tech Stack:** Microsoft Graph API v1.0, Microsoft Identity Platform OAuth2 (no extra npm package), Vitest for tests, Prisma migration for `deltaToken` field.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `app/lib/outlook/auth.ts` | OAuth2 flow, token storage, auto-refresh |
| Create | `app/lib/outlook/client.ts` | Raw Graph API calls (delta, list, get message, get thread) |
| Create | `app/lib/outlook/mail-client.ts` | Adapter implementing `MailClient` interface |
| Create | `app/lib/outlook/pipeline.ts` | Thin pipeline wrapper (delegates to shared processNewEmails) |
| Create | `app/lib/outlook/__tests__/auth.test.ts` | Unit tests for auth flow |
| Create | `app/lib/outlook/__tests__/client.test.ts` | Unit tests for Graph API parsing |
| Modify | `prisma/schema.prisma` | Add `deltaToken String?` to `MailConnection` |
| Modify | `app/lib/mail/oauth-state.ts` | Add `"outlook"` to `MailOAuthProvider` union type |
| Modify | `app/lib/mail/types.ts` | Add `"outlook"` to `MailProvider` union type |
| Modify | `app/routes/mail-auth.tsx` | Handle `provider === "outlook"` in the OAuth callback |
| Modify | `app/lib/gmail/pipeline.ts` | Add `"outlook"` branch in `getMailClient()` |

---

## Task 1: Prisma schema migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add `deltaToken` field**

In `prisma/schema.prisma`, find the `MailConnection` model and add after the `historyId` line:

```prisma
  historyId      String?  // Gmail only — incremental sync cursor
  deltaToken     String?  // Outlook only — Microsoft Graph delta link (full URL)
```

- [ ] **Step 2: Generate and apply the migration**

```bash
npx prisma migrate dev --name add_mailconnection_delta_token
```

Expected: a new migration file appears in `prisma/migrations/`, Prisma client regenerates. If using `DATABASE_URL` pointing to production, use `migrate deploy` instead.

- [ ] **Step 3: Verify the generated migration SQL**

Open `prisma/migrations/<timestamp>_add_mailconnection_delta_token/migration.sql`. It should contain:

```sql
ALTER TABLE "MailConnection" ADD COLUMN "deltaToken" TEXT;
```

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add deltaToken field to MailConnection for Outlook sync"
```

---

## Task 2: Extend provider type unions

**Files:**
- Modify: `app/lib/mail/oauth-state.ts:25`
- Modify: `app/lib/mail/types.ts:40`

- [ ] **Step 1: Write the failing test**

Create `app/lib/mail/__tests__/oauth-state.test.ts` — but this file already exists. Open it and add one test to the existing describe block:

```typescript
it("signs and verifies an outlook state", () => {
  const state = signOAuthState("outlook", "test-shop.myshopify.com");
  const result = verifyOAuthState(state);
  expect(result).not.toBeNull();
  expect(result!.provider).toBe("outlook");
  expect(result!.shop).toBe("test-shop.myshopify.com");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run app/lib/mail/__tests__/oauth-state.test.ts
```

Expected: FAIL — TypeScript error `Argument of type '"outlook"' is not assignable to parameter of type 'MailOAuthProvider'`.

- [ ] **Step 3: Add "outlook" to MailOAuthProvider**

In `app/lib/mail/oauth-state.ts`, change line 25:

```typescript
// Before
export type MailOAuthProvider = "gmail" | "zoho";
```

```typescript
// After
export type MailOAuthProvider = "gmail" | "zoho" | "outlook";
```

Also update the runtime guard at line 85 of `oauth-state.ts`:

```typescript
// Before
if (!payload || (payload.p !== "gmail" && payload.p !== "zoho")) return null;
```

```typescript
// After
if (!payload || (payload.p !== "gmail" && payload.p !== "zoho" && payload.p !== "outlook")) return null;
```

- [ ] **Step 4: Add "outlook" to MailProvider in types.ts**

In `app/lib/mail/types.ts`, change line 40:

```typescript
// Before
export type MailProvider = "gmail" | "zoho";
```

```typescript
// After
export type MailProvider = "gmail" | "zoho" | "outlook";
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run app/lib/mail/__tests__/oauth-state.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/lib/mail/oauth-state.ts app/lib/mail/types.ts app/lib/mail/__tests__/oauth-state.test.ts
git commit -m "feat(types): add outlook to MailOAuthProvider and MailProvider unions"
```

---

## Task 3: outlook/auth.ts

**Files:**
- Create: `app/lib/outlook/__tests__/auth.test.ts`
- Create: `app/lib/outlook/auth.ts`

The Microsoft token endpoint returns `expires_in` (seconds from now), not an absolute `expiry_date`. The user email is fetched from `https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName` after token exchange.

- [ ] **Step 1: Write failing tests**

Create `app/lib/outlook/__tests__/auth.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../db.server", () => ({
  default: {
    mailConnection: {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    incomingEmail: { deleteMany: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      mailConnection: { delete: vi.fn().mockResolvedValue({}) },
      incomingEmail: { deleteMany: vi.fn().mockResolvedValue({}) },
    })),
  },
}));

vi.mock("../../gmail/crypto", () => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace(/^enc:/, "")),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { getAuthUrl, exchangeCodeForTokens, saveConnection, getAuthenticatedClient } from "../auth";
import prisma from "../../../db.server";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MICROSOFT_CLIENT_ID = "test-client-id";
  process.env.MICROSOFT_CLIENT_SECRET = "test-client-secret";
  process.env.SHOPIFY_APP_URL = "https://example.com";
  process.env.SHOPIFY_API_SECRET = "test-secret-32-chars-padded-here";
});

describe("getAuthUrl", () => {
  it("returns a Microsoft Identity Platform URL with correct params", () => {
    const url = new URL(getAuthUrl("test-shop.myshopify.com"));
    expect(url.hostname).toBe("login.microsoftonline.com");
    expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toContain("Mail.Read");
    expect(scope).toContain("offline_access");
    expect(url.searchParams.get("state")).toBeTruthy();
  });
});

describe("exchangeCodeForTokens", () => {
  it("exchanges code and fetches user email", async () => {
    // First fetch: token endpoint
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "access-abc",
          refresh_token: "refresh-xyz",
          expires_in: 3600,
        }),
      })
      // Second fetch: /me email
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ mail: "user@outlook.com", userPrincipalName: "user@outlook.com" }),
      });

    const tokens = await exchangeCodeForTokens("auth-code-123");

    expect(tokens.accessToken).toBe("access-abc");
    expect(tokens.refreshToken).toBe("refresh-xyz");
    expect(tokens.email).toBe("user@outlook.com");
    expect(tokens.expiry.getTime()).toBeGreaterThan(Date.now() + 3500_000);
  });

  it("throws when token endpoint returns error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant", error_description: "Code expired" }),
    });

    await expect(exchangeCodeForTokens("bad-code")).rejects.toThrow("Microsoft token exchange failed");
  });

  it("falls back to userPrincipalName when mail field is empty", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "tok", refresh_token: "ref", expires_in: 3600 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ mail: null, userPrincipalName: "user@tenant.onmicrosoft.com" }),
      });

    const tokens = await exchangeCodeForTokens("code");
    expect(tokens.email).toBe("user@tenant.onmicrosoft.com");
  });
});

describe("getAuthenticatedClient", () => {
  it("returns tokens directly when not expired", async () => {
    const futureExpiry = new Date(Date.now() + 2 * 3600_000);
    (prisma.mailConnection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      accessToken: "enc:access-tok",
      refreshToken: "enc:refresh-tok",
      tokenExpiry: futureExpiry,
    });

    const client = await getAuthenticatedClient("test-shop.myshopify.com");
    expect(client.accessToken).toBe("access-tok");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refreshes token when near expiry", async () => {
    const nearExpiry = new Date(Date.now() + 30_000); // 30s — within 60s threshold
    (prisma.mailConnection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      accessToken: "enc:old-access",
      refreshToken: "enc:refresh-tok",
      tokenExpiry: nearExpiry,
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    });

    const client = await getAuthenticatedClient("test-shop.myshopify.com");
    expect(client.accessToken).toBe("new-access");
    expect(prisma.mailConnection.update).toHaveBeenCalled();
  });

  it("throws when no connection exists", async () => {
    (prisma.mailConnection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(getAuthenticatedClient("test-shop.myshopify.com")).rejects.toThrow(
      "No Outlook connection for this shop",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run app/lib/outlook/__tests__/auth.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create app/lib/outlook/auth.ts**

```typescript
import prisma from "../../db.server";
import { encrypt, decrypt } from "../gmail/crypto";
import { signOAuthState } from "../mail/oauth-state";

const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const AUTH_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName";
const SCOPES = "Mail.Read offline_access";

function getClientConfig() {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri =
    process.env.MICROSOFT_REDIRECT_URI ||
    `${process.env.SHOPIFY_APP_URL || ""}/mail-auth`;
  if (!clientId || !clientSecret) {
    throw new Error("MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET are required");
  }
  return { clientId, clientSecret, redirectUri };
}

export function getAuthUrl(shop: string): string {
  const { clientId, redirectUri } = getClientConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    response_mode: "query",
    state: signOAuthState("outlook", shop),
    prompt: "select_account",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string) {
  const { clientId, clientSecret, redirectUri } = getClientConfig();

  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      scope: SCOPES,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => ({}));
    throw new Error(
      `Microsoft token exchange failed (${tokenRes.status}): ${(err as { error_description?: string }).error_description ?? JSON.stringify(err)}`,
    );
  }

  const tokenData = await tokenRes.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const meRes = await fetch(GRAPH_ME, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const meData = await meRes.json() as { mail?: string; userPrincipalName?: string };
  const email = meData.mail || meData.userPrincipalName || "unknown";

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiry: new Date(Date.now() + tokenData.expires_in * 1000),
    email,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiry: Date;
}> {
  const { clientId, clientSecret } = getClientConfig();

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      scope: SCOPES,
    }).toString(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      `Microsoft token refresh failed (${res.status}): ${(err as { error_description?: string }).error_description ?? JSON.stringify(err)}`,
    );
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiry: new Date(Date.now() + data.expires_in * 1000),
  };
}

export async function saveConnection(
  shop: string,
  tokens: { accessToken: string; refreshToken: string; expiry: Date; email: string },
) {
  await prisma.mailConnection.upsert({
    where: { shop },
    create: {
      shop,
      provider: "outlook",
      email: tokens.email,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
    },
    update: {
      provider: "outlook",
      email: tokens.email,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
    },
  });
}

export async function deleteConnection(shop: string) {
  await prisma.$transaction(async (tx) => {
    try {
      await tx.mailConnection.delete({ where: { shop } });
    } catch {
      // Ignore "record not found"
    }
    await tx.incomingEmail.deleteMany({ where: { shop } });
  });
}

export async function getConnection(shop: string) {
  return prisma.mailConnection.findUnique({ where: { shop } });
}

export interface OutlookTokens {
  accessToken: string;
}

export async function getAuthenticatedClient(shop: string): Promise<OutlookTokens> {
  const conn = await prisma.mailConnection.findUnique({ where: { shop } });
  if (!conn) throw new Error("No Outlook connection for this shop");

  if (conn.tokenExpiry.getTime() > Date.now() + 60_000) {
    return { accessToken: decrypt(conn.accessToken) };
  }

  const refreshed = await refreshAccessToken(decrypt(conn.refreshToken));
  await prisma.mailConnection.update({
    where: { shop },
    data: {
      accessToken: encrypt(refreshed.accessToken),
      refreshToken: encrypt(refreshed.refreshToken),
      tokenExpiry: refreshed.expiry,
    },
  });

  return { accessToken: refreshed.accessToken };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run app/lib/outlook/__tests__/auth.test.ts
```

Expected: PASS (all tests green)

- [ ] **Step 5: Commit**

```bash
git add app/lib/outlook/auth.ts app/lib/outlook/__tests__/auth.test.ts
git commit -m "feat(outlook): add OAuth2 auth module with token exchange and auto-refresh"
```

---

## Task 4: outlook/client.ts

**Files:**
- Create: `app/lib/outlook/__tests__/client.test.ts`
- Create: `app/lib/outlook/client.ts`

Microsoft Graph delta query: the first call has no `deltaToken` and returns a `@odata.deltaLink` (a full URL). Store the full URL as `deltaToken`. On next sync, fetch that URL directly. If the response is `410 Gone`, the deltaToken is stale — return `{ messages: [], staleDeltaToken: true }` so the caller can reset and re-backfill.

Graph message fields needed:
- `id`, `conversationId`, `subject`, `receivedDateTime`
- `from.emailAddress.name`, `from.emailAddress.address`
- `body.content`, `body.contentType`
- `internetMessageHeaders` (array of `{name, value}`)
- `internetMessageId`
- `categories`, `inferenceClassification`
- `hasAttachments`

`$select` param used in all calls:
```
id,conversationId,subject,receivedDateTime,from,body,internetMessageHeaders,internetMessageId,categories,inferenceClassification,hasAttachments
```

- [ ] **Step 1: Write failing tests**

Create `app/lib/outlook/__tests__/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../auth", () => ({
  getAuthenticatedClient: vi.fn().mockResolvedValue({ accessToken: "test-token" }),
}));

import {
  fetchDeltaMessages,
  fetchHistoricalMessages,
  getMessageById,
  getThreadMessages,
  parseGraphMessage,
} from "../client";

const SAMPLE_GRAPH_MSG = {
  id: "msg-001",
  conversationId: "conv-abc",
  subject: "Order #1234 issue",
  receivedDateTime: "2026-05-01T10:00:00Z",
  from: { emailAddress: { name: "Jane Doe", address: "jane@example.com" } },
  body: { contentType: "text", content: "Hello, where is my order?" },
  internetMessageHeaders: [
    { name: "Message-ID", value: "<abc@mail.example.com>" },
    { name: "In-Reply-To", value: "<prev@mail.example.com>" },
  ],
  internetMessageId: "<abc@mail.example.com>",
  categories: [],
  inferenceClassification: "focused",
  hasAttachments: false,
};

describe("parseGraphMessage", () => {
  it("maps Graph message fields to MailMessage shape", () => {
    const msg = parseGraphMessage(SAMPLE_GRAPH_MSG);
    expect(msg.id).toBe("msg-001");
    expect(msg.threadId).toBe("conv-abc");
    expect(msg.from).toBe("jane@example.com");
    expect(msg.fromName).toBe("Jane Doe");
    expect(msg.subject).toBe("Order #1234 issue");
    expect(msg.bodyText).toBe("Hello, where is my order?");
    expect(msg.receivedAt).toEqual(new Date("2026-05-01T10:00:00Z"));
    expect(msg.labelIds).toEqual([]);
    expect(msg.headers["message-id"]).toBe("<abc@mail.example.com>");
    expect(msg.headers["in-reply-to"]).toBe("<prev@mail.example.com>");
    expect(msg.attachments).toEqual([]);
  });

  it("strips HTML tags and sets bodyText from html body", () => {
    const htmlMsg = {
      ...SAMPLE_GRAPH_MSG,
      body: { contentType: "html", content: "<p>Hello <b>world</b></p>" },
    };
    const msg = parseGraphMessage(htmlMsg);
    expect(msg.bodyText).toContain("Hello world");
    expect(msg.bodyHtml).toBe("<p>Hello <b>world</b></p>");
  });

  it("maps inferenceClassification=other to labelIds=[OUTLOOK_OTHER]", () => {
    const otherMsg = { ...SAMPLE_GRAPH_MSG, inferenceClassification: "other" };
    const msg = parseGraphMessage(otherMsg);
    expect(msg.labelIds).toContain("OUTLOOK_OTHER");
  });

  it("maps categories to labelIds", () => {
    const promoMsg = { ...SAMPLE_GRAPH_MSG, categories: ["Promotions"] };
    const msg = parseGraphMessage(promoMsg);
    expect(msg.labelIds).toContain("OUTLOOK_CATEGORY_Promotions");
  });
});

describe("fetchDeltaMessages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns messages and deltaLink on first call (no token)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        value: [SAMPLE_GRAPH_MSG],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=ABC123",
      }),
    });

    const result = await fetchDeltaMessages("test-shop.myshopify.com", null);
    expect(result.staleDeltaToken).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("msg-001");
    expect(result.nextDeltaLink).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=ABC123",
    );
  });

  it("paginates via @odata.nextLink until @odata.deltaLink appears", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [SAMPLE_GRAPH_MSG],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=page2",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=FINAL",
        }),
      });

    const result = await fetchDeltaMessages("test-shop.myshopify.com", null);
    expect(result.messages).toHaveLength(1);
    expect(result.nextDeltaLink).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=FINAL",
    );
  });

  it("returns staleDeltaToken=true on 410 Gone", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 410, json: async () => ({}) });

    const result = await fetchDeltaMessages("test-shop.myshopify.com", "https://graph.microsoft.com/stale");
    expect(result.staleDeltaToken).toBe(true);
    expect(result.messages).toEqual([]);
  });
});

describe("fetchHistoricalMessages", () => {
  it("fetches messages after a given date with pagination", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [SAMPLE_GRAPH_MSG],
          "@odata.nextLink": "https://graph.microsoft.com/next",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

    const afterDate = new Date("2026-04-01T00:00:00Z");
    const messages = await fetchHistoricalMessages("test-shop.myshopify.com", afterDate);
    expect(messages).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run app/lib/outlook/__tests__/client.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create app/lib/outlook/client.ts**

```typescript
import { getAuthenticatedClient } from "./auth";
import { cleanHtml } from "../gmail/client";
import type { MailMessage, MailAttachment } from "../mail/types";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const MSG_SELECT =
  "id,conversationId,subject,receivedDateTime,from,body,internetMessageHeaders,internetMessageId,categories,inferenceClassification,hasAttachments";
const INLINE_EMBED_LIMIT = 200 * 1024; // 200 KB

interface GraphEmailAddress {
  name: string;
  address: string;
}

interface GraphMessage {
  id: string;
  conversationId: string;
  subject: string;
  receivedDateTime: string;
  from: { emailAddress: GraphEmailAddress };
  body: { contentType: "html" | "text"; content: string };
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  internetMessageId?: string;
  categories: string[];
  inferenceClassification: "focused" | "other";
  hasAttachments: boolean;
}

interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  contentId?: string;
  isInline: boolean;
  contentBytes?: string;
}

export interface DeltaResult {
  messages: MailMessage[];
  nextDeltaLink: string | null;
  staleDeltaToken: boolean;
}

export function parseGraphMessage(raw: GraphMessage): MailMessage {
  const headers: Record<string, string> = {};
  for (const h of raw.internetMessageHeaders ?? []) {
    headers[h.name.toLowerCase()] = h.value;
  }

  const isHtml = raw.body.contentType === "html";
  const bodyHtml = isHtml ? raw.body.content : undefined;
  const bodyText = isHtml ? cleanHtml(raw.body.content) : raw.body.content;

  // Map Outlook-specific signals to labelIds so the prefilter can inspect them
  const labelIds: string[] = [];
  if (raw.inferenceClassification === "other") labelIds.push("OUTLOOK_OTHER");
  for (const cat of raw.categories) {
    labelIds.push(`OUTLOOK_CATEGORY_${cat}`);
  }

  return {
    id: raw.id,
    threadId: raw.conversationId,
    from: raw.from.emailAddress.address.toLowerCase(),
    fromName: raw.from.emailAddress.name,
    subject: raw.subject ?? "(no subject)",
    bodyText,
    bodyHtml,
    snippet: bodyText.slice(0, 200),
    receivedAt: new Date(raw.receivedDateTime),
    labelIds,
    headers,
    attachments: [],
  };
}

async function graphFetch<T>(
  accessToken: string,
  url: string,
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: data as T };
}

export async function fetchDeltaMessages(
  shop: string,
  deltaLink: string | null,
): Promise<DeltaResult> {
  const { accessToken } = await getAuthenticatedClient(shop);

  // If we have a stored deltaLink, use it directly; otherwise start a fresh delta
  let url =
    deltaLink ??
    `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$select=${MSG_SELECT}&$top=50`;

  const messages: MailMessage[] = [];
  let nextDeltaLink: string | null = null;

  while (url) {
    const res = await graphFetch<{
      value?: GraphMessage[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    }>(accessToken, url);

    if (!res.ok) {
      if (res.status === 410) {
        return { messages: [], nextDeltaLink: null, staleDeltaToken: true };
      }
      throw new Error(`Graph delta fetch failed (${res.status}): ${JSON.stringify(res.data)}`);
    }

    for (const msg of res.data.value ?? []) {
      messages.push(parseGraphMessage(msg));
    }

    if (res.data["@odata.deltaLink"]) {
      nextDeltaLink = res.data["@odata.deltaLink"];
      break;
    }
    url = res.data["@odata.nextLink"] ?? "";
  }

  return { messages, nextDeltaLink, staleDeltaToken: false };
}

export async function fetchHistoricalMessages(
  shop: string,
  afterDate: Date,
): Promise<MailMessage[]> {
  const { accessToken } = await getAuthenticatedClient(shop);
  const isoDate = afterDate.toISOString();
  let url =
    `${GRAPH_BASE}/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${isoDate}` +
    `&$select=${MSG_SELECT}&$top=50&$orderby=receivedDateTime asc`;

  const messages: MailMessage[] = [];

  while (url) {
    const res = await graphFetch<{
      value?: GraphMessage[];
      "@odata.nextLink"?: string;
    }>(accessToken, url);

    if (!res.ok) {
      throw new Error(`Graph historical fetch failed (${res.status}): ${JSON.stringify(res.data)}`);
    }

    for (const msg of res.data.value ?? []) {
      messages.push(parseGraphMessage(msg));
    }

    url = res.data["@odata.nextLink"] ?? "";
  }

  return messages;
}

export async function getMessageById(shop: string, messageId: string): Promise<MailMessage> {
  const { accessToken } = await getAuthenticatedClient(shop);
  const url = `${GRAPH_BASE}/me/messages/${messageId}?$select=${MSG_SELECT}`;
  const res = await graphFetch<GraphMessage>(accessToken, url);

  if (!res.ok) {
    throw new Error(`Graph getMessage failed (${res.status}): ${JSON.stringify(res.data)}`);
  }

  const msg = parseGraphMessage(res.data);

  if (res.data.hasAttachments) {
    msg.attachments = await fetchAttachments(accessToken, messageId);
  }

  return msg;
}

async function fetchAttachments(
  accessToken: string,
  messageId: string,
): Promise<MailAttachment[]> {
  const url = `${GRAPH_BASE}/me/messages/${messageId}/attachments?$select=id,name,contentType,size,contentId,isInline,contentBytes`;
  const res = await graphFetch<{ value?: GraphAttachment[] }>(accessToken, url);

  if (!res.ok) return [];

  return (res.data.value ?? []).map((att) => ({
    fileName: att.name,
    mimeType: att.contentType,
    sizeBytes: att.size,
    contentId: att.contentId ?? undefined,
    disposition: att.isInline ? "inline" : "attachment",
    inlineData:
      att.contentBytes && att.size <= INLINE_EMBED_LIMIT
        ? att.contentBytes
        : undefined,
    providerAttachId: att.id,
  }));
}

export async function getThreadMessages(
  shop: string,
  conversationId: string,
): Promise<MailMessage[]> {
  const { accessToken } = await getAuthenticatedClient(shop);
  const url =
    `${GRAPH_BASE}/me/messages?$filter=conversationId eq '${encodeURIComponent(conversationId)}'` +
    `&$select=${MSG_SELECT}&$orderby=receivedDateTime asc&$top=50`;

  const res = await graphFetch<{ value?: GraphMessage[] }>(accessToken, url);

  if (!res.ok) {
    throw new Error(`Graph getThreadMessages failed (${res.status}): ${JSON.stringify(res.data)}`);
  }

  return (res.data.value ?? []).map(parseGraphMessage);
}

export async function getCurrentDeltaLink(shop: string): Promise<string | null> {
  const result = await fetchDeltaMessages(shop, null);
  if (result.staleDeltaToken) return null;
  // Discard messages from this initial probe — we only want the cursor
  return result.nextDeltaLink;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run app/lib/outlook/__tests__/client.test.ts
```

Expected: PASS (all tests green)

- [ ] **Step 5: Commit**

```bash
git add app/lib/outlook/client.ts app/lib/outlook/__tests__/client.test.ts
git commit -m "feat(outlook): add Microsoft Graph API client with delta sync and message parsing"
```

---

## Task 5: outlook/mail-client.ts

**Files:**
- Create: `app/lib/outlook/mail-client.ts`

This is a thin adapter — no separate tests needed (covered by client.ts tests and integration). The `listNewMessages` method must handle the stale delta token case by returning an empty list and a `null` cursor so the job runner resets `deltaToken` and triggers a backfill.

- [ ] **Step 1: Create app/lib/outlook/mail-client.ts**

```typescript
import type { MailClient } from "../mail/types";
import {
  fetchDeltaMessages,
  fetchHistoricalMessages,
  getMessageById,
  getThreadMessages,
  getCurrentDeltaLink,
} from "./client";
import prisma from "../../db.server";

export async function createOutlookClient(shop: string): Promise<MailClient> {
  return {
    async listRecentMessages(opts) {
      const afterDate = opts.afterDate ?? new Date(Date.now() - 7 * 24 * 3600_000);
      const messages = await fetchHistoricalMessages(shop, afterDate);
      const limit = opts.maxResults ?? 100;
      return messages.slice(0, limit).map((m) => m.id);
    },

    async getMessage(messageId) {
      return getMessageById(shop, messageId);
    },

    async listNewMessages(cursor) {
      const result = await fetchDeltaMessages(shop, cursor);

      if (result.staleDeltaToken) {
        // Reset the stored delta link so the next sync starts fresh
        await prisma.mailConnection.update({
          where: { shop },
          data: { deltaToken: null },
        });
        return { messageIds: [], latestCursor: null };
      }

      if (result.nextDeltaLink) {
        await prisma.mailConnection.update({
          where: { shop },
          data: { deltaToken: result.nextDeltaLink },
        });
      }

      return {
        messageIds: result.messages.map((m) => m.id),
        latestCursor: result.nextDeltaLink,
      };
    },

    async getSyncCursor() {
      const conn = await prisma.mailConnection.findUnique({ where: { shop } });
      if (conn?.deltaToken) return conn.deltaToken;
      // Probe Graph to get an initial delta link (no messages returned)
      return getCurrentDeltaLink(shop);
    },

    async getThreadMessages(conversationId) {
      return getThreadMessages(shop, conversationId);
    },
  };
}
```

- [ ] **Step 2: Run full test suite to check no regressions**

```bash
npx vitest run app/lib/outlook/
```

Expected: all outlook tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/lib/outlook/mail-client.ts
git commit -m "feat(outlook): add MailClient adapter wrapping Graph API client"
```

---

## Task 6: Wire Outlook into mail-auth callback and pipeline

**Files:**
- Modify: `app/routes/mail-auth.tsx:76-88`
- Modify: `app/lib/gmail/pipeline.ts:41-44`

- [ ] **Step 1: Handle Microsoft admin consent error in the OAuth callback**

Microsoft redirects to `/mail-auth?error=access_denied&error_description=...AADSTS65001...` when admin consent is required. Add a check at the top of the `mail-auth.tsx` loader, before the `code` check:

```typescript
// Add after the rawState and code extraction (around line 44):
const oauthError = url.searchParams.get("error");
if (oauthError) {
  const errorDesc = url.searchParams.get("error_description") ?? "";
  console.warn(`[mail-auth] OAuth provider error: ${oauthError} — ${errorDesc}`);
  if (errorDesc.includes("AADSTS65001") || oauthError === "consent_required") {
    return errorPage(
      "Microsoft admin consent required",
      "Your Microsoft 365 administrator must approve this app before you can connect it.\n\n" +
      "Ask your IT admin to visit the Microsoft Azure portal and grant consent for the 'Mail.Read' permission.\n\n" +
      "After admin approval, retry connecting from the Shopify admin.",
    );
  }
  return errorPage(`OAuth error: ${oauthError}`, errorDesc);
}
```

- [ ] **Step 3: Add "outlook" branch to the provider switch in the try block**

In `app/routes/mail-auth.tsx`, the `try` block starting at line 75 currently checks for `"zoho"` then falls through to Gmail. Add an `"outlook"` branch **before** the Gmail fallback:

```typescript
// Before (lines 76-88):
    if (provider === "zoho") {
      const { exchangeZohoCode, saveZohoConnection } = await import(
        "../lib/zoho/auth"
      );
      const tokens = await exchangeZohoCode(code);
      await saveZohoConnection(shop, tokens);
    } else {
      const { exchangeCodeForTokens, saveConnection } = await import(
        "../lib/gmail/auth"
      );
      const tokens = await exchangeCodeForTokens(code);
      await saveConnection(shop, tokens);
    }
```

```typescript
// After:
    if (provider === "zoho") {
      const { exchangeZohoCode, saveZohoConnection } = await import(
        "../lib/zoho/auth"
      );
      const tokens = await exchangeZohoCode(code);
      await saveZohoConnection(shop, tokens);
    } else if (provider === "outlook") {
      const { exchangeCodeForTokens, saveConnection } = await import(
        "../lib/outlook/auth"
      );
      const tokens = await exchangeCodeForTokens(code);
      await saveConnection(shop, tokens);
    } else {
      const { exchangeCodeForTokens, saveConnection } = await import(
        "../lib/gmail/auth"
      );
      const tokens = await exchangeCodeForTokens(code);
      await saveConnection(shop, tokens);
    }
```

- [ ] **Step 4: Extend getMailClient in pipeline.ts**

In `app/lib/gmail/pipeline.ts`, find `getMailClient` (lines 41–44):

```typescript
// Before:
export async function getMailClient(shop: string, provider: string): Promise<MailClient> {
  if (provider === "zoho") return createZohoClient(shop);
  return createGmailClient(shop);
}
```

```typescript
// After:
export async function getMailClient(shop: string, provider: string): Promise<MailClient> {
  if (provider === "zoho") return createZohoClient(shop);
  if (provider === "outlook") {
    const { createOutlookClient } = await import("../outlook/mail-client");
    return createOutlookClient(shop);
  }
  return createGmailClient(shop);
}
```

- [ ] **Step 5: Run full test suite to check no regressions**

```bash
npx vitest run
```

Expected: all pre-existing tests pass, no new failures.

- [ ] **Step 6: Commit**

```bash
git add app/routes/mail-auth.tsx app/lib/gmail/pipeline.ts
git commit -m "feat(outlook): wire Outlook into OAuth callback and mail client factory"
```

---

## Task 7: Outlook prefilter extension

**Files:**
- Modify: `app/lib/gmail/prefilter.ts`

The prefilter already rejects messages with `CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL`, etc. from Gmail labels. Outlook uses `OUTLOOK_CATEGORY_*` and `OUTLOOK_OTHER` labels in `labelIds` (set by `client.ts:parseGraphMessage`). The existing prefilter checks `EXCLUDED_LABELS` — add the Outlook equivalents.

- [ ] **Step 1: Write failing test**

In `app/lib/gmail/__tests__/prefilter.test.ts` (add to existing test file):

```typescript
import { prefilterEmail } from "../prefilter";
import type { MailMessage } from "../../mail/types";

function makeMsg(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "1", threadId: "t1", from: "customer@example.com", fromName: "Customer",
    subject: "Test", bodyText: "Hello", snippet: "", receivedAt: new Date(),
    labelIds: [], headers: {}, attachments: [], ...overrides,
  };
}

describe("Outlook prefilter", () => {
  it("rejects OUTLOOK_CATEGORY_Promotions", () => {
    const msg = makeMsg({ labelIds: ["OUTLOOK_CATEGORY_Promotions"] });
    const result = prefilterEmail(msg);
    expect(result.passed).toBe(false);
  });

  it("rejects OUTLOOK_OTHER (focused=other emails)", () => {
    const msg = makeMsg({ labelIds: ["OUTLOOK_OTHER"] });
    const result = prefilterEmail(msg);
    expect(result.passed).toBe(false);
  });

  it("passes focused Outlook support emails", () => {
    const msg = makeMsg({ labelIds: [] });
    const result = prefilterEmail(msg);
    expect(result.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run app/lib/gmail/__tests__/prefilter.test.ts
```

Expected: `OUTLOOK_CATEGORY_Promotions` and `OUTLOOK_OTHER` tests FAIL (not excluded yet).

- [ ] **Step 3: Add Outlook labels to EXCLUDED_LABELS**

In `app/lib/gmail/prefilter.ts`, extend the `EXCLUDED_LABELS` set:

```typescript
// Before:
const EXCLUDED_LABELS = new Set([
  "SPAM",
  "TRASH",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);
```

```typescript
// After:
const EXCLUDED_LABELS = new Set([
  "SPAM",
  "TRASH",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
  // Outlook-specific: inferenceClassification=other and promotional categories
  "OUTLOOK_OTHER",
  "OUTLOOK_CATEGORY_Promotions",
  "OUTLOOK_CATEGORY_Newsletters",
  "OUTLOOK_CATEGORY_Social updates",
]);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run app/lib/gmail/__tests__/prefilter.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/lib/gmail/prefilter.ts app/lib/gmail/__tests__/prefilter.test.ts
git commit -m "feat(outlook): extend prefilter to reject Outlook promotional and other-folder labels"
```

---

## Task 8: Inbox UI — Outlook connect/disconnect

The mail connection UI lives in `app/routes/app.inbox.tsx` (not the settings page). The loader builds `gmailAuthUrl` and `zohoAuthUrl` around lines 248–254. The action handles `"disconnect"` at line 321.

**Files:**
- Modify: `app/routes/app.inbox.tsx`

- [ ] **Step 1: Add Outlook import and build outlookAuthUrl in the loader**

At the top of `app/routes/app.inbox.tsx`, add alongside the existing auth imports:

```typescript
import { getAuthUrl as getOutlookAuthUrl } from "../lib/outlook/auth";
```

In the loader, extend the block at lines 248–254:

```typescript
  // Before:
  let gmailAuthUrl: string | null = null;
  let zohoAuthUrl: string | null = null;
  if (!connection) {
    try { gmailAuthUrl = getGmailAuthUrl(shop); } catch { /* credentials not configured */ }
    try { zohoAuthUrl = getZohoAuthUrl(shop); } catch { /* credentials not configured */ }
  }
```

```typescript
  // After:
  let gmailAuthUrl: string | null = null;
  let zohoAuthUrl: string | null = null;
  let outlookAuthUrl: string | null = null;
  if (!connection) {
    try { gmailAuthUrl = getGmailAuthUrl(shop); } catch { /* credentials not configured */ }
    try { zohoAuthUrl = getZohoAuthUrl(shop); } catch { /* credentials not configured */ }
    try { outlookAuthUrl = getOutlookAuthUrl(shop); } catch { /* credentials not configured */ }
  }
```

Add `outlookAuthUrl` to the return object alongside `gmailAuthUrl` and `zohoAuthUrl`:

```typescript
    gmailAuthUrl,
    zohoAuthUrl,
    outlookAuthUrl,   // add this line
```

- [ ] **Step 2: Add Outlook section to the connect UI**

In the component, find where the Gmail and Zoho connect buttons are rendered (search for `gmailAuthUrl` in JSX). After the Zoho section, add:

```tsx
{!connected && outlookAuthUrl && (
  <Button url={outlookAuthUrl} external={false}>
    Connect Outlook / Microsoft 365
  </Button>
)}
{connected && provider === "outlook" && (
  <Text as="p" tone="subdued">
    Connected Outlook mailbox: {connectedEmail}
  </Text>
)}
```

- [ ] **Step 3: Verify disconnect already works**

The existing disconnect action at line 321–323 calls `deleteConnection(session.shop)` which is imported from `../lib/gmail/auth`. That function deletes the `MailConnection` row by `shop` regardless of provider — it already works for Outlook with no changes needed.

- [ ] **Step 4: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat(outlook): add Outlook connect button to inbox UI"
```

---

## Task 9: Final smoke test and run all tests

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass, no regressions.

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Set required environment variables**

Add to your `.env` file (do not commit):
```
MICROSOFT_CLIENT_ID=<from Azure portal app registration>
MICROSOFT_CLIENT_SECRET=<from Azure portal app registration>
```

Azure AD app registration steps (one-time, manual):
1. Go to https://portal.azure.com → Azure Active Directory → App registrations → New registration
2. Name: "Automail" (or your app name)
3. Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
4. Redirect URI: Web → `https://<your-domain>/mail-auth`
5. After creation: Certificates & secrets → New client secret → copy the value immediately
6. API permissions → Add permission → Microsoft Graph → Delegated → `Mail.Read`, `offline_access`

- [ ] **Step 4: Final commit**

```bash
git add .env.example  # if you have one, add the new vars without values
git commit -m "feat(outlook): complete Outlook integration — OAuth2, delta sync, pipeline wiring"
```
