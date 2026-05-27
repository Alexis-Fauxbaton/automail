/**
 * Outgoing-message detection — shared between the live pipeline and the
 * historical backfill.
 *
 * Direction is decided from a deterministic, per-mailbox allow-list:
 *   - the connected mailbox address (`MailConnection.email`)
 *   - the merchant's send-as aliases (`MailConnection.outgoingAliases`),
 *     populated at OAuth completion from the provider's API
 *
 * Why no longer a self-reinforcing pool: the previous design built the
 * "known outgoing addresses" set from rows already tagged outgoing in DB.
 * A single bad inference (e.g. the Zoho client briefly returning a virtual
 * SENT label on inbound messages) poisoned the pool permanently — every
 * future email from those customers got auto-tagged outgoing, classifier
 * skipped them, threads stayed `supportNature: "unknown"`, and the only
 * fix was per-shop manual SQL. Self-reinforcement is the wrong shape for
 * this signal; deterministic allow-list is the right one.
 *
 * Multi-mailbox: `loadOutgoingContext` is scoped to a specific
 * `MailConnection` (by `id`), not to the shop as a whole. This prevents
 * outgoing mail from mailbox A from being misattributed to mailbox B.
 */

import prisma from "../../db.server";
import { outgoingSelfHealTotal } from "../metrics/definitions";
import { ensureOutgoingAliasesForConnection } from "./aliases";

export interface OutgoingContext {
  /** The shop's connected mailbox address (`MailConnection.email`), lowercased. */
  mailboxAddress: string;
  /**
   * Lowercased addresses the merchant can send from. Includes the primary
   * mailbox and any aliases configured at the provider level (Zoho send-as,
   * Gmail sendAs, Outlook proxy addresses). Looked up at OAuth time and
   * refreshed on token renewal; NOT built from existing DB rows.
   */
  knownOutgoingAddresses: Set<string>;
}

function parseAliases(json: string): string[] {
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/**
 * Minimal connection shape required by `loadOutgoingContext`. Callers pass
 * their already-fetched `MailConnection` row — we accept a structural subset
 * so the function stays decoupled from the Prisma model type.
 */
export interface MailConnectionForOutgoing {
  id: string;
  shop: string;
  provider: string;
  email: string;
  outgoingAliases: string;
}

/**
 * Load the per-mailbox outgoing-address context at the start of a sync /
 * backfill pass. Also runs the self-heal sweep: any row currently tagged
 * `processingStatus = "outgoing"` whose `fromAddress` is NOT in the
 * allow-list is reset to `"ingested"` and re-classification will run on
 * the next pipeline pass. Defensive — no-op when the data is already clean.
 *
 * Multi-mailbox: scoped to `connection.id` so a shop with two mailboxes
 * cannot have their outgoing allow-lists cross-contaminate.
 */
export async function loadOutgoingContext(
  connection: MailConnectionForOutgoing,
): Promise<OutgoingContext> {
  const { shop, id: mailConnectionId } = connection;
  const norm = (connection.email ?? "").trim().toLowerCase();
  // Lazy-populate aliases for legacy connections that pre-date this feature.
  // Idempotent no-op once aliases are stored.
  await ensureOutgoingAliasesForConnection(connection);
  // Re-fetch after the lazy backfill in case outgoingAliases just got populated.
  const fresh = await prisma.mailConnection.findUnique({
    where: { id: mailConnectionId },
    select: { outgoingAliases: true },
  });
  const aliases = fresh ? parseAliases(fresh.outgoingAliases) : [];

  const knownOutgoingAddresses = new Set<string>();
  if (norm) knownOutgoingAddresses.add(norm);
  for (const a of aliases) knownOutgoingAddresses.add(a);

  // Only self-heal when we have a *trusted* allow-list. A fetch from the
  // provider (Zoho/Gmail/Outlook) always includes the primary mailbox, so
  // a stored value of `"[]"` means the fetch never succeeded — running
  // self-heal here would risk resetting legitimate alias rows.
  const aliasesFetched = !!(fresh?.outgoingAliases && fresh.outgoingAliases !== "[]");
  if (aliasesFetched) {
    await selfHealMisattributedOutgoing(shop, mailConnectionId, knownOutgoingAddresses);
  }

  return { mailboxAddress: norm, knownOutgoingAddresses };
}

/**
 * Reset rows tagged `outgoing` whose sender is not in the merchant's
 * allow-list. These were misclassified at ingest time (typically by a
 * provider-side bug — see Zoho folder-probing incident, May 2026). Reset
 * to `"ingested"` so the next pipeline pass re-runs tier1/tier2. Tracks
 * the count in `outgoing_self_heal_total{shop}` for production alerting.
 *
 * Multi-mailbox: scoped to `mailConnectionId` so healing one mailbox
 * never disturbs rows belonging to another mailbox in the same shop.
 */
async function selfHealMisattributedOutgoing(
  shop: string,
  mailConnectionId: string,
  allowList: Set<string>,
): Promise<number> {
  // Skip when allow-list is empty (e.g. mailbox not yet configured) — we
  // can't tell legitimate outgoing from misattributed, and clearing
  // everything would create a worse problem.
  if (allowList.size === 0) return 0;

  const allow = Array.from(allowList);
  const fixed = await prisma.$executeRaw`
    UPDATE "IncomingEmail"
    SET "processingStatus" = 'ingested',
        "tier1Result" = NULL,
        "tier2Result" = NULL,
        "analysisResult" = NULL,
        "detectedIntent" = NULL,
        "analysisConfidence" = NULL,
        "lastAnalyzedAt" = NULL
    WHERE shop = ${shop}
      AND "mailConnectionId" = ${mailConnectionId}
      AND "processingStatus" = 'outgoing'
      AND LOWER("fromAddress") <> ALL(${allow}::text[])
  `;
  if (fixed > 0) {
    outgoingSelfHealTotal.inc({ shop }, fixed);
    console.warn(
      `[outgoing-detection] self-heal: reset ${fixed} misattributed outgoing rows for shop=${shop} mailConnectionId=${mailConnectionId}`,
    );
  }
  return fixed;
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
