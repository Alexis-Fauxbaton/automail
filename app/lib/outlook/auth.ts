import prisma from "../../db.server";
import { encrypt, decrypt } from "../gmail/crypto";
import { signOAuthState } from "../mail/oauth-state";

const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const AUTH_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName";
const GRAPH_ME_PROXY = "https://graph.microsoft.com/v1.0/me?$select=mail,proxyAddresses";
// User.Read is required to read `proxyAddresses` from Graph /me for the
// outgoing-aliases allow-list. Without it, the field is silently omitted
// from the $select response. Existing merchants who connected before this
// scope was added won't have it — their alias backfill will fail
// gracefully (out = [primary] only) until they re-consent at next reauth.
const SCOPES = "Mail.Read User.Read offline_access";

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
    const err = await tokenRes.json().catch(() => ({})) as { error?: string; error_description?: string };
    // Log only the error code — error_description may echo back secret/PII fragments.
    console.error(`[outlook/auth] token exchange error (${tokenRes.status}): ${err.error ?? "unknown"}`);
    throw new Error(`Microsoft token exchange failed (${tokenRes.status})`);
  }

  const tokenData = await tokenRes.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const meRes = await fetch(GRAPH_ME, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!meRes.ok) {
    console.warn("[outlook/auth] failed to fetch user email from Graph /me, using 'unknown'");
  }
  const meData = meRes.ok ? await meRes.json() as { mail?: string; userPrincipalName?: string } : {};
  const email = meData.mail || meData.userPrincipalName || "unknown";

  const aliases = await fetchOutlookAliases(tokenData.access_token, email).catch((err) => {
    console.warn("[outlook/auth] proxyAddresses fetch failed:", err);
    return [] as string[];
  });

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiry: new Date(Date.now() + tokenData.expires_in * 1000),
    email,
    aliases,
  };
}

/**
 * Fetch every address the user can send mail from via this Microsoft 365
 * account. Graph's `proxyAddresses` returns entries like `SMTP:primary@x`
 * (uppercase prefix = primary) and `smtp:alias@x` (lowercase = alias).
 * Used to populate the outgoing-detection allow-list at OAuth time so
 * customer replies aren't misclassified.
 */
async function fetchOutlookAliases(
  accessToken: string,
  primaryEmail: string,
): Promise<string[]> {
  const res = await fetch(GRAPH_ME_PROXY, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Graph proxyAddresses ${res.status}`);
  const data = (await res.json()) as { mail?: string; proxyAddresses?: string[] };
  const out = new Set<string>();
  const p = primaryEmail.trim().toLowerCase();
  if (p && p !== "unknown") out.add(p);
  for (const entry of data.proxyAddresses ?? []) {
    // Each entry: "SMTP:foo@bar.com" (primary) or "smtp:alias@bar.com".
    // Anything not prefixed with smtp (case-insensitive) is a non-mail
    // proxy (SIP, EUM, …) and must be ignored.
    if (typeof entry !== "string") continue;
    const idx = entry.indexOf(":");
    if (idx < 0) continue;
    const proto = entry.slice(0, idx).toLowerCase();
    if (proto !== "smtp") continue;
    const addr = entry.slice(idx + 1).trim().toLowerCase();
    if (addr) out.add(addr);
  }
  return Array.from(out);
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
    const err = await res.json().catch(() => ({})) as { error?: string; error_description?: string };
    console.error(`[outlook/auth] token refresh error (${res.status}): ${err.error ?? "unknown"}`);
    throw new Error(`Microsoft token refresh failed (${res.status})`);
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
    where: { shop },
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
      email: tokens.email,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      outgoingAliases,
    },
  });
}

/**
 * Lazy-populate aliases for shops connected before this feature shipped.
 * Idempotent and best-effort.
 */
export async function backfillOutlookAliasesIfMissing(shop: string): Promise<void> {
  const conn = await prisma.mailConnection.findUnique({
    where: { shop },
    select: { provider: true, email: true, outgoingAliases: true },
  });
  if (!conn || conn.provider !== "outlook") return;
  if (conn.outgoingAliases && conn.outgoingAliases !== "[]") return;
  try {
    const { accessToken } = await getAuthenticatedClient(shop);
    const aliases = await fetchOutlookAliases(accessToken, conn.email);
    await prisma.mailConnection.update({
      where: { shop },
      data: { outgoingAliases: JSON.stringify(aliases) },
    });
    console.log(`[outlook] backfilled ${aliases.length} outgoing aliases for shop=${shop}`);
  } catch (err) {
    console.warn(`[outlook] alias backfill failed for shop=${shop}:`, err);
  }
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

  // 120 s buffer protects against clock skew and request-in-flight expiry.
  if (conn.tokenExpiry.getTime() > Date.now() + 120_000) {
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
