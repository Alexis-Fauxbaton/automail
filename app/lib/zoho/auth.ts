import prisma from "../../db.server";
import { encrypt, decrypt } from "../gmail/crypto";

function getZohoAccountsDomain(): string {
  const apiDomain = process.env.ZOHO_API_DOMAIN || "mail.zoho.com";
  // Extract TLD: mail.zoho.eu → zoho.eu, mail.zoho.com → zoho.com
  if (apiDomain.includes("zoho.eu")) return "accounts.zoho.eu";
  if (apiDomain.includes("zoho.in")) return "accounts.zoho.in";
  if (apiDomain.includes("zoho.com.au")) return "accounts.zoho.com.au";
  if (apiDomain.includes("zoho.jp")) return "accounts.zoho.jp";
  return "accounts.zoho.com";
}

const SCOPES = "ZohoMail.messages.READ,ZohoMail.accounts.READ,ZohoMail.folders.READ";

function getZohoApiDomain(): string {
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
    state: `zoho:${shop}`,
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
  };
}

async function fetchZohoAccount(accessToken: string): Promise<{
  accountId: string;
  email: string;
}> {
  const domain = getZohoApiDomain();
  const res = await fetch(`https://${domain}/api/accounts`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const json = await res.json();
  const account = (json as any).data?.[0];
  if (!account) {
    console.warn("[zoho] Could not fetch Mail account ID, will retry on first sync");
    return { accountId: "", email: "unknown" };
  }

  const email =
    account.primaryEmailAddress ||
    account.emailAddress?.find((e: any) => e.isPrimary === "true")?.mailId ||
    account.incomingUserName ||
    "unknown";

  return { accountId: String(account.accountId), email };
}

export async function saveZohoConnection(
  shop: string,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiry: Date;
    email: string;
    accountId: string;
  },
) {
  await prisma.mailConnection.upsert({
    where: { shop },
    create: {
      shop,
      provider: "zoho",
      email: tokens.email,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      zohoAccountId: tokens.accountId,
    },
    update: {
      provider: "zoho",
      email: tokens.email,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      zohoAccountId: tokens.accountId,
    },
  });
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

  // Refresh if expired or about to expire
  if (conn.tokenExpiry.getTime() < Date.now() + 60_000) {
    return refreshZohoToken(shop);
  }
  return decrypt(conn.accessToken);
}
