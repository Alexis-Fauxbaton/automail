import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

const prisma = new PrismaClient();

const SECRET = process.env.GMAIL_TOKEN_SECRET || "";
const IV_LEN = 16;
const TAG_LEN = 16;
function decrypt(ciphertext: string): string {
  const key = Buffer.from(SECRET, "hex");
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encrypted = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

async function main() {
  const conn = await prisma.mailConnection.findUnique({
    where: { shop: "test-automail.myshopify.com" },
  });
  if (!conn) {
    console.log("No connection found in DB");
    return;
  }
  console.log("Connection:", {
    provider: conn.provider,
    email: conn.email,
    zohoAccountId: conn.zohoAccountId,
    tokenExpiry: conn.tokenExpiry,
  });

  const refreshToken = decrypt(conn.refreshToken);

  // Refresh the token first (it's likely expired)
  console.log("Refreshing token...");
  const refreshRes = await fetch("https://accounts.zoho.eu/oauth/v2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ZOHO_CLIENT_ID || "",
      client_secret: process.env.ZOHO_CLIENT_SECRET || "",
      refresh_token: refreshToken,
    }),
  });
  const refreshData = (await refreshRes.json()) as any;
  console.log("Refresh response:", JSON.stringify(refreshData));
  const accessToken = refreshData.access_token;
  if (!accessToken) {
    console.log("Failed to refresh token");
    return;
  }

  // Test 1: User info
  console.log("\n--- Test: /oauth/user/info ---");
  const userInfoRes = await fetch("https://accounts.zoho.eu/oauth/user/info", {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  console.log("Status:", userInfoRes.status);
  console.log("Body:", await userInfoRes.text());

  // Test 2: Mail accounts - various URL formats
  const urls = [
    "https://mail.zoho.eu/api/accounts",
    "https://mail.zoho.eu/api/accounts?",
    "https://www.zohoapis.eu/mail/accounts",
    "https://mail.zohoapis.eu/api/accounts",
  ];
  for (const url of urls) {
    console.log(`\n--- Test: ${url} ---`);
    const r = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    console.log("Status:", r.status);
    console.log("Body:", await r.text());
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
