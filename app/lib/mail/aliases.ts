/**
 * Provider-agnostic dispatcher that ensures `MailConnection.outgoingAliases`
 * is populated for a shop. Each provider's auth module exposes a
 * `backfill<Provider>AliasesIfMissing(shop)` function that's idempotent and
 * best-effort (logs and swallows errors). This module exists so the mail
 * pipeline doesn't have to know which provider implementation to call.
 *
 * Why lazy-populated: shops connected before the alias-detection feature
 * shipped have `outgoingAliases = "[]"` in DB. Doing it lazily on the
 * next sync avoids a one-shot migration that would need every shop's
 * OAuth token to be valid at deploy time.
 */

import prisma from "../../db.server";

export async function ensureOutgoingAliases(shop: string): Promise<void> {
  const conn = await prisma.mailConnection.findUnique({
    where: { shop },
    select: { provider: true, outgoingAliases: true },
  });
  if (!conn) return;
  if (conn.outgoingAliases && conn.outgoingAliases !== "[]") return;

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
