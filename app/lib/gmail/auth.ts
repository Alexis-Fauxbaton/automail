import { google } from "googleapis";
import prisma from "../../db.server";
import { encrypt, decrypt } from "./crypto";
import { signOAuthState } from "../mail/oauth-state";

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
      lastSyncError: null,
      lastSyncAt: null,
      historyId: null,
      deltaToken: null,
      syncCancelledAt: null,
    },
  });
}

/**
 * Lazy-populate aliases for shops connected before this feature shipped.
 * Idempotent and best-effort.
 */
export async function backfillGmailAliasesIfMissing(shop: string): Promise<void> {
  const conn = await prisma.mailConnection.findUnique({
    where: { shop },
    select: { provider: true, email: true, outgoingAliases: true },
  });
  if (!conn || conn.provider !== "gmail") return;
  if (conn.outgoingAliases && conn.outgoingAliases !== "[]") return;
  try {
    const client = getOAuth2Client();
    const fullConn = await prisma.mailConnection.findUnique({ where: { shop } });
    if (!fullConn) return;
    client.setCredentials({
      access_token: decrypt(fullConn.accessToken),
      refresh_token: decrypt(fullConn.refreshToken),
    });
    const aliases = await fetchGmailSendAsAliases(client, conn.email);
    await prisma.mailConnection.update({
      where: { shop },
      data: { outgoingAliases: JSON.stringify(aliases) },
    });
    console.log(`[gmail] backfilled ${aliases.length} outgoing aliases for shop=${shop}`);
  } catch (err) {
    console.warn(`[gmail] alias backfill failed for shop=${shop}:`, err);
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

export async function getConnection(shop: string) {
  return prisma.mailConnection.findUnique({ where: { shop } });
}

export async function getAuthenticatedClient(shop: string) {
  const conn = await prisma.mailConnection.findUnique({ where: { shop } });
  if (!conn) throw new Error("No Gmail connection for this shop");

  const client = getOAuth2Client();
  client.setCredentials({
    access_token: decrypt(conn.accessToken),
    refresh_token: decrypt(conn.refreshToken),
    expiry_date: conn.tokenExpiry.getTime(),
  });

  // Refresh if expired (120 s buffer to match Zoho/Outlook).
  if (conn.tokenExpiry.getTime() < Date.now() + 120_000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      // Persist new tokens
      await prisma.mailConnection.update({
        where: { shop },
        data: {
          accessToken: encrypt(credentials.access_token!),
          tokenExpiry: new Date(credentials.expiry_date!),
          ...(credentials.refresh_token
            ? { refreshToken: encrypt(credentials.refresh_token) }
            : {}),
        },
      });
    } catch (err) {
      // googleapis raises GaxiosError with response.data.error === "invalid_grant"
      // when the user revoked access (Google account → Security → Apps).
      // We surface a typed marker so callers can prompt the merchant to
      // reconnect, instead of looping forever on a dead refresh token.
      const code = extractOAuthErrorCode(err);
      if (code === "invalid_grant") {
        await prisma.mailConnection
          .update({
            where: { shop },
            data: { lastSyncError: "MAILBOX_REVOKED: please reconnect Gmail" },
          })
          .catch(() => undefined);
        throw new MailboxRevokedError("gmail", shop);
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
