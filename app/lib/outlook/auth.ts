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
