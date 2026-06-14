import prisma from "../../db.server";
import { encrypt, decrypt } from "../gmail/crypto";
import { MailboxRevokedError } from "../gmail/auth";
import type { MailConnection } from "@prisma/client";
import { signOAuthState } from "../mail/oauth-state";

const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const AUTH_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName";
const GRAPH_ME_PROXY = "https://graph.microsoft.com/v1.0/me?$select=mail,proxyAddresses";
// User.Read is required to read `proxyAddresses` from Graph /me for the
// outgoing-aliases allow-list. Without it, the field is silently omitted
// from the $select response. Existing merchants who connected before this
// scope was added won't have it — their alias backfill will fail
// gracefully (out = [primary] only) until they re-consent at next reauth.
// Mail.ReadWrite is required to create draft messages via POST /me/messages
// (used by the create-draft + send pattern in mail-client.ts to capture the
// message id for the pre-emptive outgoing insert). Mail.Send alone only
// allows POST /me/sendMail which returns 202 no body, breaking that flow.
const SCOPES = "Mail.ReadWrite Mail.Send User.Read offline_access";

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
    // `prompt=consent` instead of `select_account` so every authorize hit
    // re-shows the consent screen. Necessary when our SCOPES set evolves
    // (we added User.Read after Mail.Read offline_access): merchants whose
    // original consent only covered the old subset would otherwise refresh
    // silently with the narrower scopes, and proxyAddresses / userPrincipal
    // lookups would 403 — leaving connection.email stuck at "unknown".
    // Only impacts initial connection + explicit reconnect; daily token
    // refresh is a server-side POST that ignores `prompt`.
    prompt: "consent",
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
    scope?: string;
  };

  const meRes = await fetch(GRAPH_ME, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!meRes.ok) {
    console.warn("[outlook/auth] failed to fetch user email from Graph /me, using 'unknown'");
  }
  const meData = meRes.ok ? await meRes.json() as { mail?: string; userPrincipalName?: string; otherMails?: string[]; displayName?: string } : {};
  // Some Microsoft accounts return `mail: null` (no Exchange mailbox configured
  // yet) and a non-email userPrincipalName (e.g. live.com#alias@…). Fall back
  // through `otherMails` and proxyAddresses before giving up.
  let email = meData.mail || meData.userPrincipalName || "";
  // Reject UPNs that aren't plausible email addresses.
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) email = "";
  if (!email && Array.isArray(meData.otherMails) && meData.otherMails.length > 0) {
    email = meData.otherMails.find((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) ?? "";
  }
  // Last resort: pull the primary SMTP address from proxyAddresses (the
  // entry prefixed with uppercase "SMTP:"). fetchOutlookAliases already calls
  // /me?$select=mail,proxyAddresses — reuse it.
  let aliases: string[] = [];
  try {
    const proxyRes = await fetch(GRAPH_ME_PROXY, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (proxyRes.ok) {
      const proxyData = (await proxyRes.json()) as { mail?: string; proxyAddresses?: string[] };
      if (!email) {
        // Primary (uppercase "SMTP:") wins.
        const primary = (proxyData.proxyAddresses ?? []).find(
          (e) => typeof e === "string" && e.startsWith("SMTP:"),
        );
        if (primary) email = primary.slice("SMTP:".length).trim().toLowerCase();
        else if (proxyData.mail) email = proxyData.mail;
      }
      const set = new Set<string>();
      if (email) set.add(email.toLowerCase());
      for (const entry of proxyData.proxyAddresses ?? []) {
        if (typeof entry !== "string") continue;
        const idx = entry.indexOf(":");
        if (idx < 0) continue;
        if (entry.slice(0, idx).toLowerCase() !== "smtp") continue;
        const addr = entry.slice(idx + 1).trim().toLowerCase();
        if (addr) set.add(addr);
      }
      aliases = Array.from(set);
    }
  } catch (err) {
    console.warn("[outlook/auth] proxyAddresses fetch failed:", err);
  }
  if (!email) {
    console.warn("[outlook/auth] could not determine primary email from Graph; using 'unknown'");
    email = "unknown";
  }

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiry: new Date(Date.now() + tokenData.expires_in * 1000),
    email,
    aliases,
    displayName: (typeof meData.displayName === "string" ? meData.displayName.trim() : "") || null,
    scope: tokenData.scope ?? null,
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

  // Note: we deliberately omit `scope` on refresh. Microsoft rejects the
  // refresh with AADSTS70000 ("scopes requested are unauthorized or
  // expired") if the requested scope set is broader than what the user
  // originally consented to. Older connections were authorized with
  // `Mail.Read offline_access` only; we later added `User.Read`. Without
  // the scope parameter, MS returns a token with the originally-granted
  // scopes, which is exactly what we want.
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string; error_description?: string };
    console.error(`[outlook/auth] token refresh error (${res.status}): ${err.error ?? "unknown"}`);
    // Microsoft Graph returns "invalid_grant" when the user revokes the
    // app from their account (Microsoft Account → Security & privacy →
    // app permissions). Surface a typed marker so callers prompt the
    // merchant to reconnect.
    if (err.error === "invalid_grant" || err.error === "interaction_required") {
      throw new MailboxRevokedError("outlook", "unknown");
    }
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
    displayName?: string | null;
    grantedScopes?: string | null;
  },
): Promise<{ id: string }> {
  const outgoingAliases = JSON.stringify(tokens.aliases ?? []);
  const conn = await prisma.mailConnection.upsert({
    where: { shop_email: { shop, email: tokens.email } },
    create: {
      shop,
      provider: "outlook",
      email: tokens.email,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      outgoingAliases,
      displayName: tokens.displayName ?? null,
      grantedScopes: tokens.grantedScopes ?? null,
    },
    // Reconnect: wipe sync-state fields so the new connection starts clean.
    // Stale state from a previous session (deltaToken, lastSyncError,
    // onboardingBackfillDoneAt) would otherwise be replayed against the
    // new tokens — e.g. a deltaToken bound to the OLD account would 410
    // on first call, or a leftover lastSyncError ("Vite module runner has
    // been closed" from a dev process) would surface on the inbox UI even
    // though the new connection is healthy.
    update: {
      provider: "outlook",
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiry: tokens.expiry,
      outgoingAliases,
      // Only overwrite when present, so a transient null doesn't wipe a name.
      ...(tokens.displayName ? { displayName: tokens.displayName } : {}),
      grantedScopes: tokens.grantedScopes ?? null,
      lastSyncError: null,
      lastSyncAt: null,
      historyId: null,
      deltaToken: null,
      syncCancelledAt: null,
    },
    select: { id: true },
  });
  return conn;
}

/**
 * Lazy-populate aliases for a specific Outlook MailConnection.
 * Idempotent and best-effort.
 */
export async function backfillOutlookAliasesIfMissing(connection: MailConnection): Promise<void> {
  if (connection.provider !== "outlook") return;
  const aliasesNeedBackfill = !connection.outgoingAliases || connection.outgoingAliases === "[]";
  const emailIsUnknown = !connection.email || connection.email === "unknown";
  if (!aliasesNeedBackfill && !emailIsUnknown) return;
  try {
    const { accessToken } = await getAuthenticatedClientByConnection(connection);
    // Recover the primary email from Graph if the connection was saved with
    // "unknown". Old connections predate the proxyAddresses fallback in
    // authenticate(); refresh them lazily on the next sync.
    let primaryEmail = connection.email;
    if (emailIsUnknown) {
      try {
        const meRes = await fetch(GRAPH_ME, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!meRes.ok) {
          console.warn(`[outlook] /me failed during recovery: HTTP ${meRes.status}`);
        }
        if (meRes.ok) {
          const meData = (await meRes.json()) as { mail?: string; userPrincipalName?: string; otherMails?: string[] };
          console.log(`[outlook] /me recovery data for connection=${connection.id}: mail=${meData.mail ?? "null"} upn=${meData.userPrincipalName ?? "null"} otherMails=${JSON.stringify(meData.otherMails ?? [])}`);
          const isEmail = (s: string | undefined) => !!s && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
          let email = (meData.mail && isEmail(meData.mail) ? meData.mail : "")
            || (meData.userPrincipalName && isEmail(meData.userPrincipalName) ? meData.userPrincipalName : "")
            || (Array.isArray(meData.otherMails) ? (meData.otherMails.find(isEmail) ?? "") : "");
          if (!email) {
            // proxyAddresses fallback
            const proxyRes = await fetch(GRAPH_ME_PROXY, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (proxyRes.ok) {
              const proxyData = (await proxyRes.json()) as { proxyAddresses?: string[] };
              const primary = (proxyData.proxyAddresses ?? []).find(
                (e) => typeof e === "string" && e.startsWith("SMTP:"),
              );
              if (primary) email = primary.slice("SMTP:".length).trim().toLowerCase();
            }
          }
          if (email) {
            primaryEmail = email.toLowerCase();
            await prisma.mailConnection.update({
              where: { id: connection.id },
              data: { email: primaryEmail },
            });
            console.log(`[outlook] recovered primary email for connection=${connection.id} → ${primaryEmail}`);
          }
        }
      } catch (err) {
        console.warn(`[outlook] email recovery failed for connection=${connection.id}:`, err);
      }
    }
    if (aliasesNeedBackfill) {
      const aliases = await fetchOutlookAliases(accessToken, primaryEmail);
      await prisma.mailConnection.update({
        where: { id: connection.id },
        data: { outgoingAliases: JSON.stringify(aliases) },
      });
      console.log(`[outlook] backfilled ${aliases.length} outgoing aliases for connection=${connection.id}`);
    }
  } catch (err) {
    console.warn(`[outlook] backfill failed for connection=${connection.id}:`, err);
  }
}

export interface OutlookTokens {
  accessToken: string;
}

// Per-connection in-flight refresh promises, keyed by connection `id`.
// Same thundering-herd coalescing as the shop-scoped variant above, but
// multi-mailbox safe (a single shop may have multiple Outlook mailboxes).
const _outlookRefreshInFlightById = new Map<string, Promise<OutlookTokens>>();

/**
 * Like `getAuthenticatedClient` but scoped to a specific MailConnection by
 * its PK (`id`). All DB updates use `id` so they are multi-mailbox safe.
 */
export async function getAuthenticatedClientByConnection(connection: MailConnection): Promise<OutlookTokens> {
  // 120 s buffer protects against clock skew and request-in-flight expiry.
  if (connection.tokenExpiry.getTime() > Date.now() + 120_000) {
    return { accessToken: decrypt(connection.accessToken) };
  }

  // Coalesce concurrent refreshes for the same connection.
  const existing = _outlookRefreshInFlightById.get(connection.id);
  if (existing) return existing;

  const p = (async () => {
    try {
      const refreshed = await refreshAccessToken(decrypt(connection.refreshToken));
      await prisma.mailConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: encrypt(refreshed.accessToken),
          refreshToken: encrypt(refreshed.refreshToken),
          tokenExpiry: refreshed.expiry,
        },
      });
      return { accessToken: refreshed.accessToken };
    } finally {
      _outlookRefreshInFlightById.delete(connection.id);
    }
  })();
  _outlookRefreshInFlightById.set(connection.id, p);
  return p;
}

/**
 * Fetch a connection by its PK and delegate to `getAuthenticatedClientByConnection`.
 * Used by `outlook/client.ts` functions that now accept `connectionId` instead of `shop`.
 */
export async function getAuthenticatedClientById(connectionId: string): Promise<OutlookTokens> {
  const conn = await prisma.mailConnection.findUnique({ where: { id: connectionId } });
  if (!conn) throw new Error(`No Outlook connection for id=${connectionId}`);
  return getAuthenticatedClientByConnection(conn);
}
