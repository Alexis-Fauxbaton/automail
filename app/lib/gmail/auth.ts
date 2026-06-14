import { google } from "googleapis";
import prisma from "../../db.server";
import { encrypt, decrypt } from "./crypto";
import { signOAuthState } from "../mail/oauth-state";
import type { MailConnection } from "@prisma/client";

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  // Use a dedicated redirect URI (fixed ngrok domain) so it doesn't change
  // with the Shopify Cloudflare tunnel URL.
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    `${process.env.SHOPIFY_APP_URL || ""}/mail-auth`;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function getAuthUrl(shop: string): string {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    // HMAC-signed state binds the callback to this server: an attacker
    // cannot mint a state for an arbitrary shop.
    state: signOAuthState("gmail", shop),
  });
}

export async function exchangeCodeForTokens(code: string) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("Google OAuth did not return required tokens");
  }
  // Get the user's email address
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const { data } = await oauth2.userinfo.get();
  const email = data.email || "unknown";
  const aliases = await fetchGmailSendAsAliases(client, email).catch((err) => {
    console.warn("[gmail] sendAs alias fetch failed at OAuth:", err);
    return [] as string[];
  });

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600_000),
    email,
    aliases,
    displayName: (typeof data.name === "string" ? data.name.trim() : "") || null,
    scope: tokens.scope ?? null,
  };
}

/**
 * Returns every address the user can send mail from via this Gmail
 * account: the primary plus every verified entry in their sendAs settings
 * (custom aliases, group send-as). Used to populate the outgoing-detection
 * allow-list at OAuth time so customer replies aren't misclassified.
 */
async function fetchGmailSendAsAliases(
  oauthClient: ReturnType<typeof getOAuth2Client>,
  primaryEmail: string,
): Promise<string[]> {
  const gmail = google.gmail({ version: "v1", auth: oauthClient });
  const res = await gmail.users.settings.sendAs.list({ userId: "me" });
  const items = res.data.sendAs ?? [];
  const out = new Set<string>();
  const p = primaryEmail.trim().toLowerCase();
  if (p && p !== "unknown") out.add(p);
  for (const entry of items) {
    const addr = (entry.sendAsEmail ?? "").trim().toLowerCase();
    if (!addr) continue;
    // Only trust verified aliases — unverified ones can't actually send.
    if (entry.verificationStatus && entry.verificationStatus !== "accepted") continue;
    out.add(addr);
  }
  return Array.from(out);
}

export async function saveConnection(
  shop: string,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiry: Date;
    email: string;
    aliases?: string[];
    displayName?: string | null;
    grantedScopes?: string | null;
  },
): Promise<{ id: string }> {
  const outgoingAliases = JSON.stringify(tokens.aliases ?? []);
  const conn = await prisma.mailConnection.upsert({
    where: { shop_email: { shop, email: tokens.email } },
    create: {
      shop,
      provider: "gmail",
      email: tokens.email,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      outgoingAliases,
      displayName: tokens.displayName ?? null,
      grantedScopes: tokens.grantedScopes ?? null,
    },
    // Reconnect: wipe sync-state fields so the new connection starts clean.
    // Stale historyId / lastSyncError from a previous (possibly invalidated)
    // session would otherwise be replayed against the new tokens.
    // NOTE: onboardingBackfillDoneAt is intentionally NOT reset — preserves
    // backfill state across reconnects for the same (shop, email) pair.
    update: {
      provider: "gmail",
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      outgoingAliases,
      ...(tokens.displayName ? { displayName: tokens.displayName } : {}),
      grantedScopes: tokens.grantedScopes ?? null,
      lastSyncError: null,
      lastSyncAt: null,
      historyId: null,
      deltaToken: null,
      syncCancelledAt: null,
    },
    select: { id: true },
  });
  return conn;
}

/**
 * Lazy-populate aliases for a specific Gmail MailConnection.
 * Idempotent and best-effort.
 */
export async function backfillGmailAliasesIfMissing(connection: MailConnection): Promise<void> {
  if (connection.provider !== "gmail") return;
  if (connection.outgoingAliases && connection.outgoingAliases !== "[]") return;
  try {
    const client = getOAuth2Client();
    client.setCredentials({
      access_token: decrypt(connection.accessToken),
      refresh_token: decrypt(connection.refreshToken),
    });
    const aliases = await fetchGmailSendAsAliases(client, connection.email);
    await prisma.mailConnection.update({
      where: { id: connection.id },
      data: { outgoingAliases: JSON.stringify(aliases) },
    });
    console.log(`[gmail] backfilled ${aliases.length} outgoing aliases for connection=${connection.id}`);
  } catch (err) {
    console.warn(`[gmail] alias backfill failed for connection=${connection.id}:`, err);
  }
}

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

/**
 * Like `getAuthenticatedClient` but scoped to a specific MailConnection by
 * its PK (`id`). Decrypts tokens from the passed object, refreshes via
 * `id`-scoped DB updates (multi-mailbox safe — no ambiguous `shop` lookup).
 */
export async function getAuthenticatedClientByConnection(connection: MailConnection) {
  const client = getOAuth2Client();
  client.setCredentials({
    access_token: decrypt(connection.accessToken),
    refresh_token: decrypt(connection.refreshToken),
    expiry_date: connection.tokenExpiry.getTime(),
  });

  // Refresh if expired (120 s buffer to match Zoho/Outlook).
  if (connection.tokenExpiry.getTime() < Date.now() + 120_000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      await prisma.mailConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: encrypt(credentials.access_token!),
          tokenExpiry: new Date(credentials.expiry_date!),
          ...(credentials.refresh_token
            ? { refreshToken: encrypt(credentials.refresh_token) }
            : {}),
        },
      });
    } catch (err) {
      const code = extractOAuthErrorCode(err);
      if (code === "invalid_grant") {
        await prisma.mailConnection
          .update({
            where: { id: connection.id },
            data: { lastSyncError: "MAILBOX_REVOKED: please reconnect Gmail" },
          })
          .catch(() => undefined);
        throw new MailboxRevokedError("gmail", connection.shop);
      }
      throw err;
    }
  }

  return client;
}

/**
 * Thrown when the provider says the stored refresh token is invalid /
 * revoked. The auto-sync loop, inbox loader and onboarding flow all check
 * for this to display a "reconnect" CTA instead of retrying forever.
 */
export class MailboxRevokedError extends Error {
  readonly provider: string;
  readonly shop: string;
  constructor(provider: string, shop: string) {
    super(`Mailbox revoked for ${provider} on ${shop}`);
    this.provider = provider;
    this.shop = shop;
  }
}

function extractOAuthErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  // googleapis: GaxiosError.response.data.error
  const e = err as { response?: { data?: { error?: unknown } }; code?: unknown };
  const errorField = e.response?.data?.error;
  if (typeof errorField === "string") return errorField;
  // Some googleapis paths throw a plain Error with a code property.
  if (typeof e.code === "string") return e.code;
  return null;
}
