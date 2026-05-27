import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// AES-256-GCM encryption for Shopify Session access/refresh tokens at rest.
//
// Why a separate module from lib/gmail/crypto.ts:
//   - Mail-provider tokens (Gmail/Outlook/Zoho) and Shopify session tokens are
//     two distinct trust boundaries. Compromising one shouldn't compromise the
//     other, so they're keyed independently.
//   - The session secret is read via SHOPIFY_SESSION_SECRET; if missing we fall
//     back to GMAIL_TOKEN_SECRET so a single-key deploy still works, but the
//     two-key setup is recommended in production (see README / .env.example).
//
// Ciphertext format: `enc:v1:<base64(iv|tag|ciphertext)>`
// The `enc:v1:` prefix is the explicit marker that lets the storage wrapper
// distinguish encrypted-at-rest values from legacy plaintext rows that
// pre-date this migration. Anything that doesn't start with the prefix is
// treated as plaintext and re-encrypted on the next write.

const ALGO = "aes-256-gcm";
const IV_LEN = 16;
const TAG_LEN = 16;
const CIPHERTEXT_PREFIX = "enc:v1:";

function getKey(): Buffer {
  const secret =
    process.env.SHOPIFY_SESSION_SECRET || process.env.GMAIL_TOKEN_SECRET;
  if (!secret) {
    throw new Error(
      "SHOPIFY_SESSION_SECRET (or GMAIL_TOKEN_SECRET as fallback) is required to encrypt Shopify session tokens",
    );
  }
  const buf = Buffer.from(secret, "hex");
  if (buf.length !== 32) {
    throw new Error(
      "SHOPIFY_SESSION_SECRET must be 64 hex chars (32 bytes); generate via `openssl rand -hex 32`",
    );
  }
  return buf;
}

export function encryptSessionToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return CIPHERTEXT_PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSessionToken(value: string): string {
  // Backward-compatible: a value without the marker is a legacy plaintext
  // row that survived the migration window. Return as-is; it will be
  // re-encrypted the next time the session is written.
  if (!isEncrypted(value)) return value;
  const key = getKey();
  const buf = Buffer.from(value.slice(CIPHERTEXT_PREFIX.length), "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encrypted = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(CIPHERTEXT_PREFIX);
}
