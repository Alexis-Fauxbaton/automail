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

function getApiDomain(): string {
  return process.env.ZOHO_API_DOMAIN || "mail.zoho.com";
}

async function zohoFetch(
  accessToken: string,
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const domain = getApiDomain();
  const url = new URL(`https://${domain}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zoho API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const accountsDomain = process.env.ZOHO_API_DOMAIN?.includes("zoho.eu")
    ? "accounts.zoho.eu"
    : "accounts.zoho.com";

  const refreshRes = await fetch(`https://${accountsDomain}/oauth/v2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ZOHO_CLIENT_ID || "",
      client_secret: process.env.ZOHO_CLIENT_SECRET || "",
      refresh_token: refreshToken,
    }),
  });
  const refreshData = (await refreshRes.json()) as any;
  if (!refreshData.access_token) {
    throw new Error("Failed to refresh Zoho token");
  }
  return refreshData.access_token;
}

async function getZohoFolderIds(
  accessToken: string,
  accountId: string,
): Promise<{ inbox: string; sent?: string }> {
  const data = (await zohoFetch(
    accessToken,
    `/api/accounts/${accountId}/folders`,
  )) as {
    data?: Array<{ folderId: string; folderName: string; folderType?: string }>;
  };
  const folders = data.data ?? [];
  const inbox = folders.find(
    (f) => f.folderType?.toLowerCase() === "inbox",
  );
  if (!inbox) {
    throw new Error("Inbox folder not found in Zoho");
  }
  return { inbox: inbox.folderId };
}

async function main() {
  const shop = process.env.SHOP || "test-automail.myshopify.com";
  console.log(`Fetching latest Zoho message for shop: ${shop}`);

  const conn = await prisma.mailConnection.findUnique({
    where: { shop },
  });
  if (!conn || conn.provider !== "zoho") {
    console.log("No Zoho connection found");
    return;
  }

  console.log(`Found Zoho connection for: ${conn.email}`);

  const refreshToken = decrypt(conn.refreshToken);
  const accessToken = await refreshAccessToken(refreshToken);
  console.log("✓ Token refreshed");

  const folders = await getZohoFolderIds(accessToken, conn.zohoAccountId!);
  console.log(`✓ Inbox folder ID: ${folders.inbox}`);

  // Fetch the most recent message
  const listData = (await zohoFetch(
    accessToken,
    `/api/accounts/${conn.zohoAccountId}/messages/view`,
    {
      folderId: folders.inbox,
      sortBy: "date",
      start: "1",
      limit: "1",
    },
  )) as { data?: any[] };

  const messages = listData.data ?? [];
  if (messages.length === 0) {
    console.log("No messages found in Inbox");
    return;
  }

  const messageId = messages[0].messageId;
  console.log(`\n✓ Found latest message ID: ${messageId}`);
  console.log(`  From: ${messages[0].fromAddress}`);
  console.log(`  Subject: ${messages[0].subject}`);
  console.log(`  Received: ${new Date(parseInt(messages[0].receivedTime, 10)).toISOString()}`);

  // Fetch full message details
  const detailData = (await zohoFetch(
    accessToken,
    `/api/accounts/${conn.zohoAccountId}/folders/${folders.inbox}/messages/${messageId}/details`,
  )) as { data?: any };

  const detail = detailData.data;
  if (detail) {
    console.log(`\n📧 Full message details:`);
    console.log(`  To: ${detail.toAddress || "(not provided)"}`);
    console.log(`  CC: ${detail.ccAddress || "(none)"}`);
    console.log(`  Thread ID: ${detail.threadId || "(none)"}`);
  }

  // Fetch message content
  const contentData = (await zohoFetch(
    accessToken,
    `/api/accounts/${conn.zohoAccountId}/folders/${folders.inbox}/messages/${messageId}/content`,
    { includeBlockContent: "true" },
  )) as { data?: { content: string } };

  const htmlBody = contentData.data?.content ?? "";
  console.log(`\n📝 Message body (HTML, first 500 chars):`);
  console.log(htmlBody.slice(0, 500));
  if (htmlBody.length > 500) {
    console.log(`... (${htmlBody.length} chars total)`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
