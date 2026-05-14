/**
 * Outgoing-message detection — shared between the live pipeline and the
 * historical backfill.
 *
 * Why a dedicated module: the previous duplicated check (`labelIds.includes("SENT")
 * || from === mailboxAddress`) was fragile. It depended on the provider
 * exposing a SENT label AND on the mailbox address being non-empty at ingest
 * time, AND assumed the merchant only ever sends from one exact address. Any
 * one of those failing produced a customer-tagged merchant message, which
 * then poisoned downstream signals (prior-contact false positives, draft
 * regeneration on internal mails, etc.).
 *
 * New strategy — multi-signal, more forgiving:
 *   1. Provider SENT label (existing signal, kept first).
 *   2. Exact match against the connected mailbox address.
 *   3. Exact match against any address previously used as an outgoing
 *      `fromAddress` for the same shop (covers `support@`, `contact@` aliases
 *      configured in Zoho/Gmail without us having to enumerate them).
 *
 * The caller fetches the known-outgoing-address set once per sync pass and
 * passes it through — avoids hitting Prisma per-message.
 */

import prisma from "../../db.server";

export interface OutgoingContext {
  /** The shop's connected mailbox address (`MailConnection.email`). Lowercased. */
  mailboxAddress: string;
  /**
   * Lowercased addresses already used as `fromAddress` on rows with
   * `processingStatus = "outgoing"` for this shop. Caches across all messages
   * in one sync pass.
   */
  knownOutgoingAddresses: Set<string>;
}

/**
 * Load the per-shop outgoing-address context once at the start of a sync /
 * backfill pass. Cheap query (single SELECT DISTINCT, ~10s of rows max).
 */
export async function loadOutgoingContext(
  shop: string,
  mailboxAddress: string,
): Promise<OutgoingContext> {
  const rows = await prisma.incomingEmail.findMany({
    where: { shop, processingStatus: "outgoing" },
    select: { fromAddress: true },
    distinct: ["fromAddress"],
  });
  const knownOutgoingAddresses = new Set<string>();
  const norm = mailboxAddress.trim().toLowerCase();
  if (norm) knownOutgoingAddresses.add(norm);
  for (const r of rows) knownOutgoingAddresses.add(r.fromAddress.toLowerCase());
  return { mailboxAddress: norm, knownOutgoingAddresses };
}

/**
 * Decide whether an inbound provider message represents an outgoing reply
 * sent by the merchant. Robust to:
 *   - Zoho returning the message in inbox only (no SENT label)
 *   - A mailbox address being briefly empty during initial OAuth setup
 *   - The merchant replying from an alias (support@, contact@, …)
 */
export function isOutgoingMessage(
  msg: { from: string; labelIds: string[] },
  ctx: OutgoingContext,
): boolean {
  if (msg.labelIds.includes("SENT")) return true;
  const from = msg.from.trim().toLowerCase();
  if (!from) return false;
  if (ctx.mailboxAddress && from === ctx.mailboxAddress) return true;
  if (ctx.knownOutgoingAddresses.has(from)) return true;
  return false;
}
