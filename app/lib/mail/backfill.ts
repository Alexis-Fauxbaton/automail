// Historical backfill + history completeness flags.
//
// Spec §11 (backfill): three modes
//   - onboarding:   on first connection, fetch the last N days (default 60)
//   - manual:       admin button that extends the window
//   - opportunistic: when a reply lands in a thread whose history looks
//                    incomplete, pull older messages on that thread only
//
// Spec §12 (history status): compute a per-thread flag
//   - complete: thread starts with a root message and every reply's
//               parent (In-Reply-To) is present locally
//   - partial:  at least one reply references an unknown parent
//   - unknown:  not enough info (yet)

import prisma from "../../db.server";
import type { MailClient } from "./types";
import { createGmailClient } from "../gmail/mail-client";
import { createZohoClient } from "../zoho/client";
import {
  resolveCanonicalThread,
  refreshThreadStats,
} from "./thread-resolver";
import { extractAndCache, mergeThreadIdentifiers } from "../support/thread-identifiers";
import { recomputeThreadState } from "../support/thread-state";

async function getMailClient(shop: string, provider: string): Promise<MailClient> {
  if (provider === "zoho") return createZohoClient(shop);
  return createGmailClient(shop);
}

/**
 * Onboarding backfill: on first connection, ingest raw messages from
 * the last `days` days (default 60). Kept separate from the regular
 * sync so the first sync isn't unbounded.
 *
 * Fire-and-forget friendly — the caller should `.catch()` errors.
 */
export async function runOnboardingBackfill(
  shop: string,
  days: number,
): Promise<{ ingested: number; skipped: number }> {
  const conn = await prisma.mailConnection.findUnique({ where: { shop } });
  if (!conn) throw new Error("No mail connection");
  if (conn.onboardingBackfillDoneAt) {
    return { ingested: 0, skipped: 0 };
  }

  const client = await getMailClient(shop, conn.provider);
  const afterDate = new Date(Date.now() - days * 24 * 3600_000);
  const messageIds = await client.listRecentMessages({
    afterDate,
    maxResults: 2000,
  });

  const existing = await prisma.incomingEmail.findMany({
    where: { shop, externalMessageId: { in: messageIds } },
    select: { externalMessageId: true },
  });
  const existingSet = new Set(existing.map((e) => e.externalMessageId));
  const fresh = messageIds.filter((id) => !existingSet.has(id));

  let ingested = 0;
  for (const msgId of fresh) {
    try {
      await ingestHistoricalMessage(shop, conn.provider, client, msgId, conn.email);
      ingested++;
    } catch (err) {
      console.error("[backfill/onboarding] failed for", msgId, err);
    }
  }

  await prisma.mailConnection.update({
    where: { shop },
    data: { onboardingBackfillDoneAt: new Date(), onboardingBackfillDays: days },
  });

  return { ingested, skipped: existing.length };
}

/**
 * Manual backfill: re-fetch messages from a given `afterDate`. Unlike
 * the onboarding pass, this can be run multiple times.
 */
export async function runManualBackfill(
  shop: string,
  afterDate: Date,
  maxResults = 2000,
): Promise<{ ingested: number; skipped: number }> {
  const conn = await prisma.mailConnection.findUnique({ where: { shop } });
  if (!conn) throw new Error("No mail connection");
  const client = await getMailClient(shop, conn.provider);
  const messageIds = await client.listRecentMessages({ afterDate, maxResults });

  const existing = await prisma.incomingEmail.findMany({
    where: { shop, externalMessageId: { in: messageIds } },
    select: { externalMessageId: true },
  });
  const existingSet = new Set(existing.map((e) => e.externalMessageId));
  const fresh = messageIds.filter((id) => !existingSet.has(id));

  let ingested = 0;
  for (const msgId of fresh) {
    try {
      await ingestHistoricalMessage(shop, conn.provider, client, msgId, conn.email);
      ingested++;
    } catch (err) {
      console.error("[backfill/manual] failed for", msgId, err);
    }
  }
  return { ingested, skipped: existing.length };
}

/**
 * Opportunistic thread backfill (spec §11). Given a canonical thread
 * whose history looks incomplete (see `evaluateHistoryStatus`), try to
 * pull the full remote thread from the provider and ingest any missing
 * messages. Cheap and idempotent.
 */
export async function runOpportunisticThreadBackfill(
  canonicalThreadId: string,
): Promise<{ added: number }> {
  const thread = await prisma.thread.findUnique({
    where: { id: canonicalThreadId },
    include: { providerIds: true },
  });
  if (!thread) return { added: 0 };

  const conn = await prisma.mailConnection.findUnique({
    where: { shop: thread.shop },
  });
  if (!conn) return { added: 0 };
  const client = await getMailClient(thread.shop, conn.provider);

  let added = 0;
  for (const mapping of thread.providerIds) {
    try {
      const remote = await client.getThreadMessages(mapping.providerThreadId);
      const localIds = await prisma.incomingEmail.findMany({
        where: { canonicalThreadId },
        select: { externalMessageId: true },
      });
      const localSet = new Set(localIds.map((r) => r.externalMessageId));
      const missing = remote.filter((m) => !localSet.has(m.id));
      for (const m of missing) {
        try {
          await ingestHistoricalMessage(
            thread.shop,
            conn.provider,
            client,
            m.id,
            conn.email,
          );
          added++;
        } catch (err) {
          console.error("[backfill/opportunistic] message failed:", err);
        }
      }
    } catch (err) {
      console.error("[backfill/opportunistic] thread fetch failed:", err);
    }
  }

  await prisma.thread.update({
    where: { id: canonicalThreadId },
    data: { backfillAttemptedAt: new Date() },
  });
  // Re-evaluate after ingestion
  await evaluateHistoryStatus(canonicalThreadId);
  await recomputeThreadState(canonicalThreadId, { mailboxAddress: conn.email });
  return { added };
}

/**
 * Ingest a historical message — same shape as pipeline.ingestAndPrefilter
 * but without Tier 1/2 side-effects (history messages should not trigger
 * draft generation just because they were backfilled).
 */
async function ingestHistoricalMessage(
  shop: string,
  provider: string,
  client: MailClient,
  msgId: string,
  mailboxAddress: string,
): Promise<void> {
  const existing = await prisma.incomingEmail.findUnique({
    where: { shop_externalMessageId: { shop, externalMessageId: msgId } },
  });
  if (existing) return;

  const msg = await client.getMessage(msgId);
  const isOutgoing =
    msg.labelIds.includes("SENT") ||
    (mailboxAddress !== "" && msg.from.toLowerCase() === mailboxAddress.toLowerCase());

  const rfcMessageId = (msg.headers["message-id"] ?? "").replace(/^<|>$/g, "").trim();
  const inReplyTo = (msg.headers["in-reply-to"] ?? "").replace(/^<|>$/g, "").trim();
  const rfcReferences = (msg.headers["references"] ?? "").trim();

  const { canonicalThreadId } = await resolveCanonicalThread({
    shop,
    provider,
    providerThreadId: msg.threadId,
    externalMessageId: msg.id,
    subject: msg.subject,
    receivedAt: msg.receivedAt,
    rfcMessageId,
    inReplyTo,
    rfcReferences,
  });

  await prisma.incomingEmail.create({
    data: {
      shop,
      externalMessageId: msg.id,
      threadId: msg.threadId,
      canonicalThreadId,
      rfcMessageId,
      inReplyTo,
      rfcReferences,
      fromAddress: msg.from,
      fromName: msg.fromName,
      subject: msg.subject,
      snippet: msg.snippet,
      bodyText: msg.bodyText,
      receivedAt: msg.receivedAt,
      // Historical messages are marked as "classified" directly so Pass 2
      // doesn't reprocess them. Outgoing stays "outgoing".
      processingStatus: isOutgoing ? "outgoing" : "classified",
      tier1Result: isOutgoing ? null : "passed",
    },
  });

  await refreshThreadStats(canonicalThreadId);
  if (!isOutgoing) {
    const row = await prisma.incomingEmail.findUniqueOrThrow({
      where: { shop_externalMessageId: { shop, externalMessageId: msgId } },
      select: { id: true },
    });
    try {
      await extractAndCache(row.id, msg.subject, msg.bodyText);
      await mergeThreadIdentifiers(canonicalThreadId);
    } catch (err) {
      console.error("[backfill] identifier merge failed:", err);
    }
  }
}

/**
 * Evaluate and persist Thread.historyStatus (spec §12).
 *   - complete: every reply's inReplyTo/references resolves locally
 *   - partial:  at least one reply references a missing message
 *   - unknown:  no RFC headers (Zoho) → we can't tell
 */
export async function evaluateHistoryStatus(
  canonicalThreadId: string,
): Promise<"complete" | "partial" | "unknown"> {
  const msgs = await prisma.incomingEmail.findMany({
    where: { canonicalThreadId },
    select: {
      id: true,
      rfcMessageId: true,
      inReplyTo: true,
      rfcReferences: true,
      receivedAt: true,
    },
  });

  if (msgs.length === 0) {
    await prisma.thread.update({
      where: { id: canonicalThreadId },
      data: { historyStatus: "unknown" },
    });
    return "unknown";
  }

  const knownIds = new Set(
    msgs.map((m) => m.rfcMessageId).filter((id) => id.length > 0),
  );

  // If zero messages have any RFC header at all (typically all-Zoho
  // threads), we cannot assess history → unknown.
  const anyRfc = msgs.some(
    (m) => m.rfcMessageId || m.inReplyTo || m.rfcReferences,
  );
  if (!anyRfc) {
    await prisma.thread.update({
      where: { id: canonicalThreadId },
      data: {
        historyStatus: "unknown",
        oldestSyncedMessageAt: msgs
          .map((m) => m.receivedAt)
          .reduce((a, b) => (a < b ? a : b)),
      },
    });
    return "unknown";
  }

  let partial = false;
  for (const m of msgs) {
    const parents = [
      m.inReplyTo,
      ...(m.rfcReferences ? m.rfcReferences.split(/\s+/) : []),
    ]
      .map((s) => s.replace(/^<|>$/g, "").trim())
      .filter((s) => s.length > 0);
    if (parents.length === 0) continue; // likely the root
    const anyMissing = parents.every((p) => !knownIds.has(p));
    if (anyMissing) {
      partial = true;
      break;
    }
  }

  const status: "complete" | "partial" = partial ? "partial" : "complete";
  const oldest = msgs
    .map((m) => m.receivedAt)
    .reduce((a, b) => (a < b ? a : b));
  await prisma.thread.update({
    where: { id: canonicalThreadId },
    data: { historyStatus: status, oldestSyncedMessageAt: oldest },
  });
  return status;
}
