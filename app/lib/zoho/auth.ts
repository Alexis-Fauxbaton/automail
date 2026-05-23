import prisma from "../../db.server";
import { encrypt, decrypt } from "../gmail/crypto";
import { signOAuthState } from "../mail/oauth-state";

function getZohoAccountsDomain(): string {
  const apiDomain = process.env.ZOHO_API_DOMAIN || "mail.zoho.com";
  // Extract TLD: mail.zoho.eu → zoho.eu, mail.zoho.com → zoho.com
  if (apiDomain.includes("zoho.eu")) return "accounts.zoho.eu";
  if (apiDomain.includes("zoho.in")) return "accounts.zoho.in";
  if (apiDomain.includes("zoho.com.au")) return "accounts.zoho.com.au";
  if (apiDomain.includes("zoho.jp")) return "accounts.zoho.jp";
  return "accounts.zoho.com";
}

const SCOPES = "ZohoMail.messages.ALL,ZohoMail.accounts.READ,ZohoMail.folders.READ";

export function getZohoApiDomain(): string {
  return process.env.ZOHO_API_DOMAIN || "mail.zoho.com";
}

function getRedirectUri(): string {
  return (
    process.env.ZOHO_REDIRECT_URI ||
    `${process.env.SHOPIFY_APP_URL || ""}/mail-auth`
  );
}

export function getZohoAuthUrl(shop: string): string {
  const clientId = process.env.ZOHO_CLIENT_ID;
  if (!clientId) throw new Error("ZOHO_CLIENT_ID is required");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: getRedirectUri(),
    access_type: "offline",
    prompt: "consent",
    // HMAC-signed state — see lib/mail/oauth-state.ts for the rationale.
    state: signOAuthState("zoho", shop),
  });
  return `https://${getZohoAccountsDomain()}/oauth/v2/auth?${params.toString()}`;
}

export async function exchangeZohoCode(code: string) {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET are required");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: getRedirectUri(),
    code,
  });
  const res = await fetch(`https://${getZohoAccountsDomain()}/oauth/v2/token`, { method: "POST", body });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (data.error || !data.access_token || !data.refresh_token) {
    throw new Error(`Zoho token exchange failed: ${data.error || "no tokens"}`);
  }

  // Fetch account ID and email
  const accountInfo = await fetchZohoAccount(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiry: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
    email: accountInfo.email,
    accountId: accountInfo.accountId,
    aliases: accountInfo.aliases,
  };
}

async function fetchZohoAccount(accessToken: string): Promise<{
  accountId: string;
  email: string;
  aliases: string[];
}> {
  const domain = getZohoApiDomain();
  const res = await fetch(`https://${domain}/api/accounts`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const json = await res.json();
  const account = (json as any).data?.[0];
  if (!account) {
    console.warn("[zoho] Could not fetch Mail account ID, will retry on first sync");
    return { accountId: "", email: "unknown", aliases: [] };
  }

  const email =
    account.primaryEmailAddress ||
    account.emailAddress?.find((e: any) => e.isPrimary === "true")?.mailId ||
    account.incomingUserName ||
    "unknown";

  // Zoho's `emailAddress` is the list of addresses the account can send
  // from (primary + aliases). Captured here so the outgoing-detection
  // allow-list is correct from the very first sync, before any data has
  // been ingested to infer it from.
  const aliases: string[] = Array.isArray(account.emailAddress)
    ? (account.emailAddress as Array<{ mailId?: unknown }>)
        .map((e) => (typeof e?.mailId === "string" ? e.mailId.trim().toLowerCase() : ""))
        .filter((s): s is string => s.length > 0)
    : [];

  return { accountId: String(account.accountId), email, aliases };
}

export async function saveZohoConnection(
  shop: string,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiry: Date;
    email: string;
    accountId: string;
    aliases: string[];
  },
) {
  const allowList = buildAllowList(tokens.email, tokens.aliases);
  const outgoingAliases = JSON.stringify(allowList);
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
      zohoAccountId: tokens.accountId,
    },
    // Reconnect: wipe sync-state fields so the new connection starts clean.
    // Stale historyId / lastSyncError from a prior session would otherwise
    // be replayed against the new tokens.
    // NOTE: onboardingBackfillDoneAt is intentionally NOT reset — preserves
    // backfill state across reconnects for the same (shop, email) pair.
    update: {
      provider: "zoho",
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      outgoingAliases,
      zohoAccountId: tokens.accountId,
      lastSyncError: null,
      lastSyncAt: null,
      historyId: null,
      deltaToken: null,
      syncCancelledAt: null,
    },
  });
}

function buildAllowList(primary: string, aliases: string[]): string[] {
  const set = new Set<string>();
  const p = primary.trim().toLowerCase();
  if (p && p !== "unknown") set.add(p);
  for (const a of aliases) {
    const n = a.trim().toLowerCase();
    if (n) set.add(n);
  }
  return Array.from(set);
}

/**
 * Lazy-populate `MailConnection.outgoingAliases` for shops connected before
 * the alias-detection feature shipped (or whose row still has the default
 * empty `"[]"`). Idempotent and best-effort: any API failure is logged and
 * swallowed so the caller's sync isn't blocked.
 */
export async function backfillZohoAliasesIfMissing(shop: string): Promise<void> {
  const conn = await prisma.mailConnection.findUnique({
    where: { shop },
    select: { provider: true, email: true, outgoingAliases: true },
  });
  if (!conn || conn.provider !== "zoho") return;
  if (conn.outgoingAliases && conn.outgoingAliases !== "[]") return;
  try {
    const accessToken = await getZohoAccessToken(shop);
    const info = await fetchZohoAccount(accessToken);
    const allowList = buildAllowList(conn.email || info.email, info.aliases);
    await prisma.mailConnection.update({
      where: { shop },
      data: { outgoingAliases: JSON.stringify(allowList) },
    });
    console.log(`[zoho] backfilled ${allowList.length} outgoing aliases for shop=${shop}`);
  } catch (err) {
    console.warn(`[zoho] alias backfill failed for shop=${shop}:`, err);
  }
}

export async function refreshZohoToken(shop: string): Promise<string> {
  const conn = await prisma.mailConnection.findUnique({ where: { shop } });
  if (!conn || conn.provider !== "zoho") throw new Error("No Zoho connection");

  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Zoho credentials missing");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: decrypt(conn.refreshToken),
  });
  const res = await fetch(`https://${getZohoAccountsDomain()}/oauth/v2/token`, { method: "POST", body });
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (data.error || !data.access_token) {
    // Zoho returns "invalid_code" / "invalid_client" / "access_denied" when
    // the refresh token has been revoked from the user's Zoho account.
    // Surface a typed marker so callers prompt the merchant to reconnect
    // instead of looping on a dead token.
    if (data.error === "invalid_code" || data.error === "access_denied" || data.error === "invalid_client") {
      await prisma.mailConnection
        .update({
          where: { shop },
          data: { lastSyncError: "MAILBOX_REVOKED: please reconnect Zoho Mail" },
        })
        .catch(() => undefined);
      const { MailboxRevokedError } = await import("../gmail/auth");
      throw new MailboxRevokedError("zoho", shop);
    }
    throw new Error(`Zoho token refresh failed: ${data.error || "no token"}`);
  }

  await prisma.mailConnection.update({
    where: { shop },
    data: {
      accessToken: encrypt(data.access_token),
      tokenExpiry: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
    },
  });

  return data.access_token;
}

export async function getZohoAccessToken(shop: string): Promise<string> {
  const conn = await prisma.mailConnection.findUnique({ where: { shop } });
  if (!conn || conn.provider !== "zoho") throw new Error("No Zoho connection");

  // 120 s buffer guards against clock skew and request-in-flight expiry.
  if (conn.tokenExpiry.getTime() < Date.now() + 120_000) {
    return refreshZohoToken(shop);
  }
  return decrypt(conn.accessToken);
}
