/**
 * One-shot migration: encrypt plaintext Shopify Session tokens in place.
 *
 * Idempotent — rows already encrypted (prefixed with `enc:v1:`) are skipped,
 * so running this twice is safe. The script targets `accessToken` and
 * `refreshToken` columns on the Session table.
 *
 * Usage:
 *   npx tsx scripts/encrypt-shopify-session-tokens.ts
 *   npx tsx scripts/encrypt-shopify-session-tokens.ts --dry-run
 *
 * Run this once after deploying the EncryptedPrismaSessionStorage wrapper.
 * The wrapper accepts legacy plaintext rows (returns them unchanged), so the
 * migration is not blocking — but every plaintext row is a window where a
 * DB leak exposes a live Shopify Admin API token.
 */
import prisma from "../app/db.server.js";
import { encryptSessionToken, isEncrypted } from "../app/lib/session-crypto.js";

const dryRun = process.argv.includes("--dry-run");

const sessions = await prisma.session.findMany({
  select: { id: true, accessToken: true, refreshToken: true },
});

let encryptedAccess = 0;
let encryptedRefresh = 0;
let alreadyEncrypted = 0;
let skipped = 0;

for (const s of sessions) {
  const data: { accessToken?: string; refreshToken?: string } = {};

  if (s.accessToken) {
    if (isEncrypted(s.accessToken)) {
      alreadyEncrypted++;
    } else {
      data.accessToken = encryptSessionToken(s.accessToken);
      encryptedAccess++;
    }
  }

  if (s.refreshToken && !isEncrypted(s.refreshToken)) {
    data.refreshToken = encryptSessionToken(s.refreshToken);
    encryptedRefresh++;
  }

  if (Object.keys(data).length === 0) {
    skipped++;
    continue;
  }

  if (!dryRun) {
    await prisma.session.update({ where: { id: s.id }, data });
  }
}

console.log(
  `${dryRun ? "[dry-run] " : ""}Session token encryption migration done: ` +
    `${encryptedAccess} access encrypted, ${encryptedRefresh} refresh encrypted, ` +
    `${alreadyEncrypted} already encrypted, ${skipped} skipped (no tokens). ` +
    `Total sessions: ${sessions.length}.`,
);

await prisma.$disconnect();
