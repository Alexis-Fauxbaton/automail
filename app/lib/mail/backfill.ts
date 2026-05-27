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
import { getMailClient } from "./types";
import {
  resolveCanonicalThread,
  refreshThreadStats,
  attachProviderMapping,
  MailboxGoneError,
} from "./thread-resolver";
import { extractAndCache, mergeThreadIdentifiers } from "../support/thread-identifiers";
import { recomputeThreadState } from "../support/thread-state";
import { prefilterEmail } from "../gmail/prefilter";
import {
  isOutgoingMessage,
  loadOutgoingContext,
  type OutgoingContext,
} from "./outgoing-detection";

async function runInBatches<T>(
  items: T[],
  batchSize: number,
  delayMs: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(fn));
    if (i + batchSize < items.length && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// getMailClient is imported from ./types (canonical multi-mailbox factory).

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
  mailConnectionId: string,
): Promise<{ ingested: number; skipped: number }> {
  const conn = await prisma.mailConnection.findUnique({ where: { id: mailConnectionId } });
  if (!conn || conn.shop !== shop) throw new Error("No mail connection");
  if (conn.onboardingBackfillDoneAt) {
    return { ingested: 0, skipped: 0 };
  }

  const client = await getMailClient(conn);
  const afterDate = new Date(Date.now() - days * 24 * 3600_000);
  const messageIds = await client.listRecentMessages({
    afterDate,
    maxResults: 2000,
  });

  const existing = await prisma.incomingEmail.findMany({
    where: { shop, mailConnectionId, externalMessageId: { in: messageIds } },
    select: { externalMessageId: true },
  });
  const existingSet = new Set(existing.map((e) => e.externalMessageId));
  const fresh = messageIds.filter((id) => !existingSet.has(id));

  const outgoingCtx = await loadOutgoingContext(conn);
  let ingested = 0;
  await runInBatches(fresh, 10, 50, async (msgId) => {
    try {
      await ingestHistoricalMessage(shop, conn.provider, client, msgId, outgoingCtx, conn.id);
      ingested++;
    } catch (err) {
      console.error("[backfill/onboarding] failed for", msgId, err);
    }
  });

  await prisma.mailConnection.update({
    where: { id: mailConnectionId },
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
  mailConnectionId: string,
  maxResults = 2000,
): Promise<{ ingested: number; skipped: number }> {
  const conn = await prisma.mailConnection.findUnique({ where: { id: mailConnectionId } });
  if (!conn || conn.shop !== shop) throw new Error("No mail connection");
  const client = await getMailClient(conn);
  const messageIds = await client.listRecentMessages({ afterDate, maxResults });

  const existing = await prisma.incomingEmail.findMany({
    where: { shop, mailConnectionId, externalMessageId: { in: messageIds } },
    select: { externalMessageId: true },
  });
  const existingSet = new Set(existing.map((e) => e.externalMessageId));
  const fresh = messageIds.filter((id) => !existingSet.has(id));

  const outgoingCtx = await loadOutgoingContext(conn);
  let ingested = 0;
  await runInBatches(fresh, 10, 50, async (msgId) => {
    try {
      await ingestHistoricalMessage(shop, conn.provider, client, msgId, outgoingCtx, conn.id);
      ingested++;
    } catch (err) {
      console.error("[backfill/manual] failed for", msgId, err);
    }
  });
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
): Promise<{ added: 0 } | { added: number }> {
  const thread = await prisma.thread.findUnique({
    where: { id: canonicalThreadId },
    include: { providerIds: true },
  });
  if (!thread) return { added: 0 };

  // Use thread.mailConnectionId (set when the thread was created) so we
  // always talk to the correct mailbox. Fall back to any connection for the
  // shop only for legacy threads that predate the mailConnectionId column.
  const conn = thread.mailConnectionId
    ? await prisma.mailConnection.findUnique({ where: { id: thread.mailConnectionId } })
    : await prisma.mailConnection.findFirst({ where: { shop: thread.shop } });
  if (!conn) return { added: 0 };
  const client = await getMailClient(conn);

  const localIds = await prisma.incomingEmail.findMany({
    where: { canonicalThreadId, shop: thread.shop },
    select: { externalMessageId: true },
  });
  const localSet = new Set(localIds.map((r) => r.externalMessageId));

  const outgoingCtx = await loadOutgoingContext(conn);
  let added = 0;
  for (const mapping of thread.providerIds) {
    try {
      const remote = await client.getThreadMessages(mapping.providerThreadId);
      const missing = remote.filter((m) => !localSet.has(m.id));
      for (const m of missing) {
        try {
          await ingestHistoricalMessage(
            thread.shop,
            conn.provider,
            client,
            m.id,
            outgoingCtx,
            conn.id,
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

  // Fallback for legacy threads (thr_* IDs) that predate the ThreadProviderId
  // mapping table. In that schema the canonical ID was the raw Zoho thread ID,
  // so we can use it directly as the provider thread ID.
  if (thread.providerIds.length === 0) {
    try {
      // Create the mapping retroactively so resolveCanonicalThread inside
      // ingestHistoricalMessage links new emails to this existing thread.
      await attachProviderMapping(
        prisma,
        canonicalThreadId,
        thread.shop,
        conn.provider,
        canonicalThreadId,
      );
      const remote = await client.getThreadMessages(canonicalThreadId);
      const missing = remote.filter((m) => !localSet.has(m.id));
      for (const m of missing) {
        try {
          await ingestHistoricalMessage(
            thread.shop,
            conn.provider,
            client,
            m.id,
            outgoingCtx,
            conn.id,
          );
          added++;
        } catch (err) {
          console.error("[backfill/opportunistic] legacy message failed:", err);
        }
      }
    } catch (err) {
      // canonicalThreadId is not a valid provider thread ID — truly unrecoverable.
      console.log(
        `[backfill/opportunistic] legacy thread ${canonicalThreadId} has no provider mapping and ID is not a valid provider thread ID`,
      );
    }
  }

  await prisma.thread.update({
    where: { id: canonicalThreadId },
    data: { backfillAttemptedAt: new Date() },
  });
  // Re-evaluate after ingestion — best-effort, don't abort if these fail.
  try {
    await evaluateHistoryStatus(canonicalThreadId, thread.shop);
  } catch (err) {
    console.error("[backfill] evaluateHistoryStatus failed:", canonicalThreadId, err);
  }
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
  outgoingCtx: OutgoingContext,
  mailConnectionId: string,
): Promise<void> {
  const existing = await prisma.incomingEmail.findUnique({
    where: { shop_externalMessageId: { shop, externalMessageId: msgId } },
  });
  if (existing) return;

  const msg = await client.getMessage(msgId);
  const isOutgoing = isOutgoingMessage(msg, outgoingCtx);
  const mailboxAddress = outgoingCtx.mailboxAddress;

  const rfcMessageId = (msg.headers["message-id"] ?? "").replace(/^<|>$/g, "").trim();
  const inReplyTo = (msg.headers["in-reply-to"] ?? "").replace(/^<|>$/g, "").trim();
  const rfcReferences = (msg.headers["references"] ?? "").trim();

  let canonicalThreadId: string;
  try {
    ({ canonicalThreadId } = await resolveCanonicalThread({
      shop,
      mailConnectionId,
      provider,
      providerThreadId: msg.threadId,
      externalMessageId: msg.id,
      subject: msg.subject,
      receivedAt: msg.receivedAt,
      rfcMessageId,
      inReplyTo,
      rfcReferences,
    }));
  } catch (err) {
    if (err instanceof MailboxGoneError) {
      console.warn(`[backfill] skipping message — mailbox gone: ${err.mailConnectionId}`);
      return;
    }
    throw err;
  }

  // Run the free regex prefilter on historical messages so they get proper
  // tier1Result and classification badges in the UI. We never run tier 2 on
  // backfilled emails (too expensive, and historical context is stale), but
  // tier 1 is free and gives the Thread a meaningful supportNature.
  let tier1Result: string | null = null;
  if (!isOutgoing) {
    const pf = prefilterEmail(msg);
    tier1Result = pf.passed ? "passed" : `filtered:${pf.reason}`;
  }

  const created = await prisma.incomingEmail.create({
    data: {
      shop,
      mailConnectionId,
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
      // (LLM tier 2) never reprocesses them. Outgoing stays "outgoing".
      processingStatus: isOutgoing ? "outgoing" : "classified",
      tier1Result,
    },
    select: { id: true },
  });

  await refreshThreadStats(canonicalThreadId, shop);
  if (!isOutgoing) {
    try {
      await extractAndCache(created.id, msg.subject, msg.bodyText);
      await mergeThreadIdentifiers(canonicalThreadId, shop);
    } catch (err) {
      console.error("[backfill] identifier merge failed:", err);
    }
    // Recompute thread state so the Thread.supportNature reflects the
    // tier1 classification (e.g. noreply → non_support) immediately.
    try {
      await recomputeThreadState(canonicalThreadId, { mailboxAddress });
    } catch (err) {
      console.error("[backfill] recomputeThreadState failed:", err);
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
  shop: string,
): Promise<"complete" | "partial" | "unknown"> {
  const msgs = await prisma.incomingEmail.findMany({
    where: { canonicalThreadId, shop },
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
