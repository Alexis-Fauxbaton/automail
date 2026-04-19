import { google } from "googleapis";
import prisma from "../../db.server";
import { encrypt, decrypt } from "./crypto";

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  // Use a dedicated redirect URI (fixed ngrok domain) so it doesn't change
  // with the Shopify Cloudflare tunnel URL.
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    `${process.env.SHOPIFY_APP_URL || ""}/app/gmail/auth`;
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
    state: shop,
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

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600_000),
    email: data.email || "unknown",
  };
}

export async function saveConnection(
  shop: string,
  tokens: { accessToken: string; refreshToken: string; expiry: Date; email: string },
) {
  await prisma.gmailConnection.upsert({
    where: { shop },
    create: {
      shop,
      googleEmail: tokens.email,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
    },
    update: {
      googleEmail: tokens.email,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
    },
  });
}

export async function deleteConnection(shop: string) {
  await prisma.gmailConnection.delete({ where: { shop } }).catch(() => {});
  // Also clean up related emails
  await prisma.incomingEmail.deleteMany({ where: { shop } });
}

export async function getConnection(shop: string) {
  return prisma.gmailConnection.findUnique({ where: { shop } });
}

export async function getAuthenticatedClient(shop: string) {
  const conn = await prisma.gmailConnection.findUnique({ where: { shop } });
  if (!conn) throw new Error("No Gmail connection for this shop");

  const client = getOAuth2Client();
  client.setCredentials({
    access_token: decrypt(conn.accessToken),
    refresh_token: decrypt(conn.refreshToken),
    expiry_date: conn.tokenExpiry.getTime(),
  });

  // Refresh if expired
  if (conn.tokenExpiry.getTime() < Date.now() + 60_000) {
    const { credentials } = await client.refreshAccessToken();
    client.setCredentials(credentials);
    // Persist new tokens
    await prisma.gmailConnection.update({
      where: { shop },
      data: {
        accessToken: encrypt(credentials.access_token!),
        tokenExpiry: new Date(credentials.expiry_date!),
        ...(credentials.refresh_token
          ? { refreshToken: encrypt(credentials.refresh_token) }
          : {}),
      },
    });
  }

  return client;
}
