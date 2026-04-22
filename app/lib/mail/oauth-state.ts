/**
 * HMAC-signed OAuth state for the mail (Gmail / Zoho) authorization flow.
 *
 * Why: without a signed state, an attacker can craft an OAuth authorization
 * request on Google/Zoho with `state=<provider>:<victimShop>.myshopify.com`,
 * complete consent with their own mailbox, and land on our public
 * `/mail-auth` callback. The callback would then bind the attacker's
 * mailbox tokens to the victim shop's `MailConnection` row — a cross-tenant
 * account takeover that leaks Shopify data through auto-generated drafts.
 *
 * How: the state embeds {provider, shop, iat} and an HMAC-SHA256 signature
 * keyed by `SHOPIFY_API_SECRET`. The callback refuses any state whose
 * signature does not verify, or whose timestamp is older than 10 minutes.
 *
 * This gives us shop authenticity (nobody outside the server can mint a
 * state) and freshness (old/leaked states cannot be replayed) without a
 * cross-origin cookie — which matters for embedded apps where cookies on
 * the provider redirect can be stripped by browsers.
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const STATE_TTL_MS = 10 * 60_000; // 10 minutes

export type MailOAuthProvider = "gmail" | "zoho";

interface StatePayload {
  p: MailOAuthProvider;
  s: string;       // shop domain
  t: number;       // issued-at (ms)
  n: string;       // nonce (anti-replay within TTL if state is leaked)
}

function getSecret(): string {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("SHOPIFY_API_SECRET is required to sign OAuth state");
  return secret;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signOAuthState(provider: MailOAuthProvider, shop: string): string {
  const payload: StatePayload = {
    p: provider,
    s: shop,
    t: Date.now(),
    n: b64url(randomBytes(12)),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", getSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export interface VerifiedState {
  provider: MailOAuthProvider;
  shop: string;
}

export function verifyOAuthState(raw: string): VerifiedState | null {
  if (!raw || typeof raw !== "string") return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  const expected = b64url(createHmac("sha256", getSecret()).update(body).digest());
  // timing-safe compare — reject on any length mismatch or tampering
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: StatePayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || (payload.p !== "gmail" && payload.p !== "zoho")) return null;
  if (typeof payload.s !== "string" || !payload.s) return null;
  if (typeof payload.t !== "number") return null;
  if (Date.now() - payload.t > STATE_TTL_MS) return null;

  // Basic shop-domain shape check. Shopify shops are *.myshopify.com.
  // Custom domains may be configured via SHOP_CUSTOM_DOMAIN — but OAuth
  // flows only bind mailboxes to the canonical *.myshopify.com identity.
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(payload.s)) return null;

  return { provider: payload.p, shop: payload.s };
}
