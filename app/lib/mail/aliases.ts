/**
 * Provider-agnostic dispatcher that ensures `MailConnection.outgoingAliases`
 * is populated for a mailbox. Each provider's auth module exposes a
 * `backfill<Provider>AliasesIfMissing(shop)` function that's idempotent and
 * best-effort (logs and swallows errors). This module exists so the mail
 * pipeline doesn't have to know which provider implementation to call.
 *
 * Why lazy-populated: shops connected before the alias-detection feature
 * shipped have `outgoingAliases = "[]"` in DB. Doing it lazily on the
 * next sync avoids a one-shot migration that would need every shop's
 * OAuth token to be valid at deploy time.
 */

/**
 * Minimal connection fields required to check and backfill outgoing aliases.
 */
interface ConnectionForAliases {
  shop: string;
  provider: string;
  email: string;
  outgoingAliases: string;
}

/**
 * Mailbox-scoped variant: accepts an already-fetched connection row so the
 * caller (pipeline / backfill) doesn't need to do an extra DB query. The
 * provider-specific backfill functions still receive `shop` because they do
 * their own DB fetch internally (updating them is tracked separately).
 */
export async function ensureOutgoingAliasesForConnection(conn: ConnectionForAliases): Promise<void> {
  const aliasesNeedBackfill = !conn.outgoingAliases || conn.outgoingAliases === "[]";
  // Also run when the email column is "unknown" — older Outlook connections
  // sometimes ended up with that placeholder when the Graph /me call returned
  // no `mail` field. The provider-specific backfill recovers it from
  // proxyAddresses on the next sync.
  const emailIsUnknown = conn.provider === "outlook" && (!conn.email || conn.email === "unknown");
  if (!aliasesNeedBackfill && !emailIsUnknown) return;

  const { shop } = conn;
  switch (conn.provider) {
    case "zoho": {
      const { backfillZohoAliasesIfMissing } = await import("../zoho/auth");
      await backfillZohoAliasesIfMissing(shop);
      return;
    }
    case "gmail": {
      const { backfillGmailAliasesIfMissing } = await import("../gmail/auth");
      await backfillGmailAliasesIfMissing(shop);
      return;
    }
    case "outlook": {
      const { backfillOutlookAliasesIfMissing } = await import("../outlook/auth");
      await backfillOutlookAliasesIfMissing(shop);
      return;
    }
    default:
      return;
  }
}

/**
 * @deprecated Use `ensureOutgoingAliasesForConnection` instead — it avoids
 * an extra DB round-trip and is mailbox-scoped. Kept for any callers that
 * haven't been migrated yet.
 */
export async function ensureOutgoingAliases(shop: string): Promise<void> {
  const { default: prisma } = await import("../../db.server");
  const conn = await prisma.mailConnection.findFirst({
    where: { shop },
    select: { provider: true, email: true, outgoingAliases: true },
  });
  if (!conn) return;
  await ensureOutgoingAliasesForConnection({ shop, ...conn });
}
