import prisma from "../../db.server";
import type { AdminGraphqlClient } from "../support/shopify/order-search";
import { analyzeSupportEmail } from "../support/orchestrator";
import type { MailAttachment, MailClient, MailMessage } from "../mail/types";
import type { ConversationMessage } from "../support/types";
import { createGmailClient } from "./mail-client";
import { createZohoClient } from "../zoho/client";
import { fetchCustomerEmails } from "./customers";
import { prefilterEmail } from "./prefilter";
import { classifyEmail } from "./classifier";
import {
  resolveCanonicalThread,
  refreshThreadStats,
  getTrueLatestMessage,
} from "../mail/thread-resolver";
import {
  extractAndCache,
  mergeThreadIdentifiers,
  getThreadResolution,
} from "../support/thread-identifiers";
import {
  recomputeThreadState,
  readStructuredState,
} from "../support/thread-state";
import {
  evaluateHistoryStatus,
  runOpportunisticThreadBackfill,
} from "../mail/backfill";

export interface ProcessingReport {
  total: number;
  alreadyProcessed: number;
  filtered: number;
  supportClient: number;
  uncertain: number;
  nonClient: number;
  errors: number;
  cancelled: boolean;
}

export async function getMailClient(shop: string, provider: string): Promise<MailClient> {
  if (provider === "zoho") return createZohoClient(shop);
  return createGmailClient(shop);
}

export async function processNewEmails(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<ProcessingReport> {
  const report: ProcessingReport = {
    total: 0,
    alreadyProcessed: 0,
    filtered: 0,
    supportClient: 0,
    uncertain: 0,
    nonClient: 0,
    errors: 0,
    cancelled: false,
  };

  const syncStartedAt = new Date();

  // Clear any previous top-level error and cancel flag at the start of a new sync.
  await prisma.mailConnection.update({
    where: { shop },
    data: { lastSyncError: null, syncCancelledAt: null },
  }).catch(() => { /* ignore if connection gone */ });

  try {
    return await _processNewEmails(shop, admin, report, syncStartedAt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gmail/pipeline] Top-level sync error:", err);
    await prisma.mailConnection.update({
      where: { shop },
      data: { lastSyncError: msg.slice(0, 500) },
    }).catch(() => {});
    throw err;
  }
}

async function _processNewEmails(
  shop: string,
  admin: AdminGraphqlClient,
  report: ProcessingReport,
  syncStartedAt: Date,
): Promise<ProcessingReport> {
  const conn = await prisma.mailConnection.findUnique({ where: { shop } });
  if (!conn) throw new Error("No mail connection for this shop");

  const client = await getMailClient(shop, conn.provider);

  // Determine which messages to fetch
  let messageIds: string[];
  let newCursor: string | null = null;

  if (conn.historyId) {
    // Incremental sync via provider cursor
    const result = await client.listNewMessages(conn.historyId);
    messageIds = result.messageIds;
    newCursor = result.latestCursor;

    // If cursor was stale (returns empty), fall back to date-based fetch
    if (messageIds.length === 0 && !newCursor) {
      const afterDate = conn.lastSyncAt ?? new Date(Date.now() - 365 * 24 * 3600_000);
      messageIds = await client.listRecentMessages({ afterDate, maxResults: 500 });
      newCursor = await client.getSyncCursor();
    }
  } else {
    // First sync or after resync — fetch last 14 days only.
    // A full historical backfill (60d) is triggered separately by the
    // auto-sync loop via runOnboardingBackfill.
    const afterDate = conn.lastSyncAt ?? new Date(Date.now() - 14 * 24 * 3600_000);
    messageIds = await client.listRecentMessages({ afterDate, maxResults: 500 });
    newCursor = await client.getSyncCursor();
  }

  report.total = messageIds.length;

  // Dedup: skip messages already in DB
  const existing = await prisma.incomingEmail.findMany({
    where: { shop, externalMessageId: { in: messageIds } },
    select: { externalMessageId: true },
  });
  const existingIds = new Set(existing.map((e) => e.externalMessageId));
  const newMessageIds = messageIds.filter((id) => !existingIds.has(id));
  report.alreadyProcessed = messageIds.length - newMessageIds.length;

  if (newMessageIds.length === 0) {
    // Still update sync cursor
    await prisma.mailConnection.update({
      where: { shop },
      data: {
        lastSyncAt: new Date(),
        ...(newCursor ? { historyId: newCursor } : {}),
      },
    });
    return report;
  }

  // Fetch Shopify customer emails for cross-reference (Tier 1 boost)
  const customerEmails = await fetchCustomerEmails(admin);

  // ---------------------------------------------------------------------
  // PASS 1 — Ingestion + Tier 1 (free regex prefilter)
  // Every new message is stored in DB. Outgoing messages are marked and
  // skipped from further tiers. Tier 1 is run here because it is free.
  // This ensures that when Pass 2 runs, the full thread context
  // (including outgoing replies) is already persisted.
  // ---------------------------------------------------------------------
  for (let i = 0; i < newMessageIds.length; i++) {
    if (i > 0 && i % 10 === 0 && (await isCancelled(shop, syncStartedAt))) {
      console.log(`[gmail/pipeline] Sync cancelled during ingestion after ${i} emails.`);
      report.cancelled = true;
      break;
    }
    const msgId = newMessageIds[i];
    try {
      await ingestAndPrefilter(shop, conn.provider, client, msgId, customerEmails, conn.email, report);
    } catch (err) {
      report.errors++;
      console.error(`[gmail/pipeline] Ingestion error for ${msgId}:`, err);
      try {
        await prisma.incomingEmail.upsert({
          where: { shop_externalMessageId: { shop, externalMessageId: msgId } },
          create: {
            shop,
            externalMessageId: msgId,
            fromAddress: "",
            subject: "",
            receivedAt: new Date(),
            processingStatus: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
          },
          update: {
            processingStatus: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
      } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------
  // PASS 2 — Tier 2 + Tier 3 on the LATEST incoming of each thread only.
  // By now every message (incoming + outgoing) is in DB, so the LLM has
  // the full thread context. We avoid wasting LLM calls on stale replies.
  // ---------------------------------------------------------------------
  if (!report.cancelled) {
    const threadsToClassify = await pickThreadsForClassification(shop, newMessageIds);
    for (let i = 0; i < threadsToClassify.length; i++) {
      if (i > 0 && i % 5 === 0 && (await isCancelled(shop, syncStartedAt))) {
        console.log(`[gmail/pipeline] Sync cancelled during classification after ${i} threads.`);
        report.cancelled = true;
        break;
      }
      const recordId = threadsToClassify[i];
      try {
        await classifyAndDraft(shop, admin, client, recordId, customerEmails, conn.email, report);
      } catch (err) {
        report.errors++;
        console.error(`[gmail/pipeline] Classification error for ${recordId}:`, err);
        await prisma.incomingEmail.update({
          where: { id: recordId },
          data: {
            processingStatus: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        }).catch(() => {});
      }
    }
  }

  // Update sync cursor
  await prisma.mailConnection.update({
    where: { shop },
    data: {
      lastSyncAt: new Date(),
      ...(newCursor ? { historyId: newCursor } : {}),
    },
  });

  return report;
}

/**
 * Persist attachments for an incoming email. Idempotent: skips records that
 * already exist (identified by emailId + fileName + sizeBytes).
 */
export async function persistEmailAttachments(
  emailId: string,
  shop: string,
  provider: string,
  providerMsgId: string,
  attachments: MailAttachment[],
): Promise<void> {
  const existing = await prisma.incomingEmailAttachment.findMany({
    where: { emailId },
    select: { id: true },
  });
  if (existing.length > 0) return; // already persisted

  await prisma.incomingEmailAttachment.createMany({
    data: attachments.map((att) => ({
      shop,
      emailId,
      fileName: att.fileName,
      mimeType: att.mimeType,
      sizeBytes: att.sizeBytes,
      contentId: att.contentId ?? null,
      disposition: att.disposition,
      inlineData: att.inlineData ?? null,
      provider,
      providerMsgId,
      providerAttachId: att.providerAttachId ?? null,
    })),
    skipDuplicates: true,
  });
}

async function isCancelled(shop: string, syncStartedAt: Date): Promise<boolean> {
  const fresh = await prisma.mailConnection.findUnique({
    where: { shop },
    select: { syncCancelledAt: true },
  });
  return !!(fresh?.syncCancelledAt && fresh.syncCancelledAt > syncStartedAt);
}

/**
 * Pass 1: fetch the remote message, store it in DB, and run the free
 * regex prefilter. LLM-based tiers are deferred to Pass 2.
 */
async function ingestAndPrefilter(
  shop: string,
  provider: string,
  client: MailClient,
  msgId: string,
  customerEmails: Set<string>,
  mailboxAddress: string,
  report: ProcessingReport,
) {
  const msg: MailMessage = await client.getMessage(msgId);
  const isKnown = customerEmails.has(msg.from.toLowerCase());
  const isOutgoing =
    msg.labelIds.includes("SENT") ||
    (mailboxAddress !== "" && msg.from.toLowerCase() === mailboxAddress.toLowerCase());

  // Extract RFC 5322 headers for thread reconciliation. Gmail populates
  // msg.headers with lower-cased keys; Zoho currently does not expose
  // them, so these will be empty strings for Zoho messages.
  const rfcMessageId = (msg.headers["message-id"] ?? "").replace(/^<|>$/g, "").trim();
  const inReplyTo = (msg.headers["in-reply-to"] ?? "").replace(/^<|>$/g, "").trim();
  const rfcReferences = (msg.headers["references"] ?? "").trim();

  // Resolve (or create) the canonical Thread BEFORE upserting the email,
  // so we can write canonicalThreadId atomically.
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

  const msgAttachments = msg.attachments ?? [];
  const hasAttachments = msgAttachments.length > 0;

  // Upsert the base record
  const upserted = await prisma.incomingEmail.upsert({
    where: { shop_externalMessageId: { shop, externalMessageId: msgId } },
    create: {
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
      bodyHtml: msg.bodyHtml ?? "",
      hasAttachments,
      receivedAt: msg.receivedAt,
      isKnownCustomer: isKnown,
      processingStatus: isOutgoing ? "outgoing" : "ingested",
    },
    update: {
      // Defensive: if a legacy row existed without canonicalThreadId or
      // RFC headers, backfill them on next encounter without overwriting
      // downstream processing state.
      canonicalThreadId,
      ...(rfcMessageId ? { rfcMessageId } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(rfcReferences ? { rfcReferences } : {}),
      // Always refresh HTML body and attachments when re-encountering a message.
      ...(msg.bodyHtml !== undefined ? { bodyHtml: msg.bodyHtml } : {}),
      ...(hasAttachments ? { hasAttachments } : {}),
    },
    select: { id: true },
  });

  // Persist attachments (idempotent: only insert if none exist yet)
  if (msgAttachments.length > 0) {
    await persistEmailAttachments(upserted.id, shop, provider, msg.id, msgAttachments);
  }

  // Refresh cached thread stats (lastMessageAt, lastMessageId, count).
  await refreshThreadStats(canonicalThreadId);

  if (isOutgoing) {
    // Outgoing messages still affect operational state (merchant replied
    // → thread should move to waiting_customer), so recompute + return.
    try {
      await recomputeThreadState(canonicalThreadId, { mailboxAddress });
      await evaluateHistoryStatus(canonicalThreadId);
    } catch (err) {
      console.error("[pipeline] state recompute (outgoing) failed:", err);
    }
    return;
  }

  // Cheap per-message regex extraction + thread-level consolidation.
  // Must run for every non-outgoing message so the thread's
  // resolvedOrderNumber / resolvedTrackingNumber are always fresh.
  const recordForExtraction = await prisma.incomingEmail.findUniqueOrThrow({
    where: { shop_externalMessageId: { shop, externalMessageId: msgId } },
    select: { id: true },
  });
  try {
    await extractAndCache(recordForExtraction.id, msg.subject, msg.bodyText);
    await mergeThreadIdentifiers(canonicalThreadId);
  } catch (err) {
    // Extraction is best-effort: failures must not block ingestion.
    console.error("[pipeline] thread identifier extraction failed:", err);
  }

  // Free regex prefilter
  const record = await prisma.incomingEmail.findUniqueOrThrow({
    where: { shop_externalMessageId: { shop, externalMessageId: msgId } },
  });

  // Skip re-running Tier 1 for emails that have already been fully
  // processed (analyzed, classified). Re-running would reset
  // processingStatus to "ingested" and trigger unnecessary Tier 2/3
  // re-processing during a resync, causing misclassification due to
  // stale context (e.g. agentHasReplied flipping the classifier).
  // Only re-process emails that are truly new (ingested) or failed.
  if (
    record.processingStatus !== "ingested" &&
    record.processingStatus !== "error"
  ) {
    // Already processed — still recompute thread state in case a new
    // outgoing message changed the conversation context.
    try {
      await recomputeThreadState(canonicalThreadId, { mailboxAddress });
      await evaluateHistoryStatus(canonicalThreadId);
    } catch (err) {
      console.error("[pipeline] state recompute (skip-tier1) failed:", err);
    }
    return;
  }

  const prefilterResult = prefilterEmail(msg, customerEmails);
  if (!prefilterResult.passed) {
    report.filtered++;
    await prisma.incomingEmail.update({
      where: { id: record.id },
      data: {
        tier1Result: `filtered:${prefilterResult.reason}`,
        processingStatus: "classified",
      },
    });
  } else {
    await prisma.incomingEmail.update({
      where: { id: record.id },
      data: { tier1Result: "passed", processingStatus: "ingested" },
    });
  }

  // Recompute thread state + history status after every incoming
  // message (spec §4, §5, §7, §12).
  try {
    await recomputeThreadState(canonicalThreadId, { mailboxAddress });
    const hist = await evaluateHistoryStatus(canonicalThreadId);

    // Opportunistic backfill (spec §11): if history looks partial and
    // we haven't attempted a backfill in the last 24h, try once.
    if (hist === "partial") {
      const t = await prisma.thread.findUnique({
        where: { id: canonicalThreadId },
        select: { backfillAttemptedAt: true },
      });
      const last = t?.backfillAttemptedAt?.getTime() ?? 0;
      if (Date.now() - last > 24 * 3600_000) {
        // Fire-and-forget — must not block ingestion.
        runOpportunisticThreadBackfill(canonicalThreadId).catch((err) =>
          console.error("[pipeline] opportunistic backfill failed:", err),
        );
      }
    }
  } catch (err) {
    console.error("[pipeline] state recompute failed:", err);
  }
}

/**
 * Determine which records need Tier 2/3 processing in Pass 2.
 * For every canonical thread touched by the ingestion batch, keep only
 * the LATEST incoming email that passed Tier 1 and hasn't been fully
 * analyzed yet. Older messages in the same thread are marked as
 * "classified" without running further LLM calls (avoids duplicate work
 * and stale drafts).
 */
async function pickThreadsForClassification(
  shop: string,
  newMessageIds: string[],
): Promise<string[]> {
  if (newMessageIds.length === 0) return [];

  // Find which canonical threads were touched by this batch.
  const newRecords = await prisma.incomingEmail.findMany({
    where: { shop, externalMessageId: { in: newMessageIds } },
    select: { canonicalThreadId: true },
  });
  const canonicalIds = Array.from(
    new Set(
      newRecords
        .map((r) => r.canonicalThreadId)
        .filter((id): id is string => !!id),
    ),
  );
  if (canonicalIds.length === 0) return [];

  const selected: string[] = [];

  for (const canonicalThreadId of canonicalIds) {
    // Latest incoming (non-outgoing) in this canonical thread that
    // passed Tier 1.
    const latest = await prisma.incomingEmail.findFirst({
      where: {
        shop,
        canonicalThreadId,
        processingStatus: { notIn: ["outgoing"] },
        tier1Result: "passed",
      },
      orderBy: { receivedAt: "desc" },
    });
    if (!latest) continue;

    // Skip if already fully analyzed
    if (latest.processingStatus === "analyzed") continue;

    selected.push(latest.id);

    // Mark older incoming messages in the same canonical thread as
    // "classified" so they don't consume LLM calls and the UI shows a
    // clean state.
    await prisma.incomingEmail.updateMany({
      where: {
        shop,
        canonicalThreadId,
        id: { not: latest.id },
        processingStatus: { notIn: ["outgoing", "classified"] },
        receivedAt: { lt: latest.receivedAt },
      },
      data: { processingStatus: "classified" },
    });
  }

  return selected;
}

/**
 * Pass 2: run Tier 2 (LLM classification) and Tier 3 (full support
 * analysis + draft) on the given record. Thread context (incoming AND
 * outgoing) is pulled from DB — it was fully populated in Pass 1.
 */
async function classifyAndDraft(
  shop: string,
  admin: AdminGraphqlClient,
  client: MailClient,
  recordId: string,
  customerEmails: Set<string>,
  mailboxAddress: string,
  report: ProcessingReport,
) {
  const record = await prisma.incomingEmail.findUniqueOrThrow({
    where: { id: recordId },
  });

  // Rebuild a MailMessage shape from the DB record for the classifier.
  const msg: MailMessage = {
    id: record.externalMessageId,
    threadId: record.threadId,
    from: record.fromAddress,
    fromName: record.fromName,
    subject: record.subject,
    snippet: record.snippet,
    bodyText: record.bodyText,
    receivedAt: record.receivedAt,
    labelIds: [],
    headers: {},
  };

  // --- Tier 2: LLM classification ---
  // Spec §6, §8: inject the compact structured thread state + the true
  // latest message so the classifier has useful context at low cost.
  const threadStateForClassify = record.canonicalThreadId
    ? await readStructuredState(record.canonicalThreadId)
    : null;
  let trueLatestBody: string | undefined;
  let agentHasReplied = false;
  if (record.canonicalThreadId) {
    const trueLatest = await getTrueLatestMessage(record.canonicalThreadId);
    if (trueLatest && trueLatest.id !== record.id) {
      trueLatestBody = trueLatest.bodyText;
    }
    // "Agent replied" must mean "replied AFTER this message". A stale
    // outgoing message from earlier in the thread must not flip the flag.
    const lastAgentIso = threadStateForClassify?.lastAgentMessageAt;
    if (lastAgentIso) {
      agentHasReplied = new Date(lastAgentIso).getTime() > record.receivedAt.getTime();
    }
  }

  const classification = await classifyEmail(msg.subject, msg.bodyText, {
    shop,
    emailId: record.id,
    threadId: record.threadId,
    threadState: threadStateForClassify,
    trueLatestBody,
    agentHasReplied,
  });
  await prisma.incomingEmail.update({
    where: { id: record.id },
    data: { tier2Result: classification },
  });

  // Refresh thread state now that message-level classification changed.
  if (record.canonicalThreadId) {
    try {
      await recomputeThreadState(record.canonicalThreadId, {
        mailboxAddress,
      });
    } catch (err) {
      console.error("[pipeline] post-Tier2 state recompute failed:", err);
    }
  }

  if (classification === "probable_non_client") {
    report.nonClient++;
    await prisma.incomingEmail.update({
      where: { id: record.id },
      data: { processingStatus: "classified" },
    });
    return;
  }

  if (classification === "incertain") {
    report.uncertain++;
    await prisma.incomingEmail.update({
      where: { id: record.id },
      data: { processingStatus: "classified" },
    });
    return;
  }

  // --- Tier 3: Full support analysis ---
  report.supportClient++;

  try {
    const threadContext = await buildThreadContext(
      shop,
      msg.threadId,
      record.canonicalThreadId,
      record.id,
      mailboxAddress,
      client,
    );

    // Thread-level resolved identifiers (cheap path, populated at
    // ingestion). The orchestrator will prefer these over re-parsing.
    const threadResolution = record.canonicalThreadId
      ? await getThreadResolution(record.canonicalThreadId)
      : null;

    const analysis = await analyzeSupportEmail({
      subject: msg.subject,
      body: threadContext.body,
      conversationMessages: threadContext.messages,
      admin,
      shop,
      trackedCallContext: {
        shop,
        emailId: record.id,
        threadId: record.threadId,
      },
      threadResolution: threadResolution
        ? {
            identifiers: {
              orderNumber: threadResolution.orderNumber,
              trackingNumber: threadResolution.trackingNumber,
              email: threadResolution.email,
              customerName: threadResolution.customerName,
            },
            confidence: threadResolution.confidence,
          }
        : undefined,
      // Draft generation is intentionally skipped during auto-sync.
      // The user must click "Generate draft" explicitly in the inbox.
      skipDraft: true,
    });
    await prisma.incomingEmail.update({
      where: { id: record.id },
      data: {
        processingStatus: "analyzed",
        analysisResult: JSON.stringify(analysis),
        // Promoted columns — kept in sync with the JSON blob so SQL
        // dashboards / rules don't have to parse JSON.
        detectedIntent: analysis.intent,
        analysisConfidence: analysis.confidence,
      },
    });
    if (record.canonicalThreadId) {
      try {
        await recomputeThreadState(record.canonicalThreadId, {
          mailboxAddress,
        });
      } catch (err) {
        console.error("[pipeline] post-Tier3 state recompute failed:", err);
      }
    }
  } catch (err) {
    report.errors++;
    await prisma.incomingEmail.update({
      where: { id: record.id },
      data: {
        processingStatus: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
  }

  // Ensure customerEmails is referenced (silence unused-var lint even though
  // we keep the param for future Tier 2 boosts).
  void customerEmails;
}

/**
 * Build a combined conversation context from all messages in a thread.
 * Messages are ordered chronologically and labeled with direction.
 *
 * Strategy:
 *  1. Try to fetch the FULL thread (inbox + sent) from the mail provider
 *     so we include outgoing replies the merchant sent from their mailbox.
 *  2. On failure, fall back to DB-stored incoming messages only.
 */
async function buildThreadContext(
  shop: string,
  threadId: string,
  canonicalThreadId: string | null,
  currentEmailId: string,
  mailboxAddress: string,
  client?: MailClient,
): Promise<{ body: string; messages: ConversationMessage[] }> {
  // Resolve the semantic "target" of this analysis: it's the latest
  // incoming message that passed Tier 1, as computed by thread-state.
  // Falls back to the currently-processed record when no target is set
  // (e.g. first message in a fresh thread).
  const targetEmailId = await resolveTargetEmailId(
    canonicalThreadId,
    currentEmailId,
  );
  const targetRecord = await prisma.incomingEmail.findUnique({
    where: { id: targetEmailId },
    select: { externalMessageId: true },
  });
  const targetExternalId = targetRecord?.externalMessageId ?? "";

  // --- 1. Try provider API for the full thread (incoming + outgoing) ---
  if (threadId && client) {
    try {
      const threadMessages = await client.getThreadMessages(threadId);
      if (threadMessages.length > 0) {
        // Sort chronologically (provider may already do it, but be safe)
        threadMessages.sort(
          (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
        );

        // "Latest" = the target message (semantic anchor for classify/draft).
        // If the provider thread doesn't contain the target (stale cache,
        // external-id mismatch), fall back to the most recent message.
        let latestIdx = threadMessages.findIndex(
          (m) => m.id === targetExternalId,
        );
        if (latestIdx === -1) latestIdx = threadMessages.length - 1;

        const messages: ConversationMessage[] = threadMessages.map((m, i) => ({
          direction: getMessageDirection(m.from, mailboxAddress),
          fromAddress: m.from,
          receivedAt: m.receivedAt.toISOString(),
          subject: m.subject,
          body: m.bodyText,
          isLatest: i === latestIdx,
        }));

        const parts = messages.map((m) => {
          const label = m.isLatest ? "Latest message" : "Earlier message";
          return [
            `--- ${label} [${m.direction.toUpperCase()}] ---`,
            `Date: ${m.receivedAt}`,
            `From: ${m.fromAddress}`,
            `Subject: ${m.subject}`,
            "Body:",
            m.body,
          ].join("\n");
        });

        return { body: parts.join("\n\n"), messages };
      }
    } catch (err) {
      console.error("[pipeline] getThreadMessages failed, falling back to DB:", err);
    }
  }

  // --- 2. Fallback to DB, preferring the canonical thread so Zoho
  // splits (several providerThreadIds mapped to the same canonical id)
  // are reassembled into a single conversation.
  if (!canonicalThreadId && !threadId) {
    const current = await prisma.incomingEmail.findUnique({
      where: { id: currentEmailId },
      select: { bodyText: true, subject: true, fromAddress: true, receivedAt: true },
    });
    if (!current) {
      return { body: "", messages: [] };
    }

    const direction = getMessageDirection(current.fromAddress, mailboxAddress);
    return {
      body: current.bodyText,
      messages: [
        {
          direction,
          fromAddress: current.fromAddress,
          receivedAt: current.receivedAt.toISOString(),
          subject: current.subject,
          body: current.bodyText,
          isLatest: true,
        },
      ],
    };
  }

  const threadEmails = await prisma.incomingEmail.findMany({
    where: canonicalThreadId
      ? { shop, canonicalThreadId }
      : { shop, threadId },
    orderBy: { receivedAt: "asc" },
    select: {
      id: true,
      fromAddress: true,
      receivedAt: true,
      subject: true,
      bodyText: true,
    },
  });

  if (threadEmails.length === 0) {
    return { body: "", messages: [] };
  }

  const parts: string[] = [];
  const messages: ConversationMessage[] = [];
  for (const email of threadEmails) {
    const direction = getMessageDirection(email.fromAddress, mailboxAddress);
    const date = email.receivedAt.toISOString();
    const isLatest = email.id === targetEmailId;
    const label = isLatest ? "Latest message" : "Earlier message";
    const directionLabel = direction.toUpperCase();

    messages.push({
      direction,
      fromAddress: email.fromAddress,
      receivedAt: date,
      subject: email.subject,
      body: email.bodyText,
      isLatest,
    });

    parts.push(
      [
        `--- ${label} [${directionLabel}] ---`,
        `Date: ${date}`,
        `From: ${email.fromAddress}`,
        `Subject: ${email.subject}`,
        "Body:",
        email.bodyText,
      ].join("\n"),
    );
  }

  return {
    body: parts.join("\n\n"),
    messages,
  };
}

export async function reanalyzeEmail(
  emailId: string,
  admin: AdminGraphqlClient,
  shop: string,
) {
  const record = await prisma.incomingEmail.findUnique({ where: { id: emailId } });
  if (!record || record.shop !== shop) {
    throw new Error("Email not found");
  }

  const conn = await prisma.mailConnection.findUnique({
    where: { shop },
    select: { email: true, provider: true },
  });

  // Build a provider client so we can pull the FULL thread (inbox + sent)
  let client: MailClient | undefined;
  try {
    if (conn) client = await getMailClient(shop, conn.provider);
  } catch (err) {
    console.error("[pipeline] Could not create mail client for reanalyze:", err);
  }

  // Build thread context
  const threadContext = await buildThreadContext(
    shop,
    record.threadId,
    record.canonicalThreadId,
    record.id,
    conn?.email ?? "",
    client,
  );

  // Re-run thread-level identifier consolidation before drafting —
  // this message's extraction may have been stale.
  if (record.canonicalThreadId) {
    try {
      await extractAndCache(record.id, record.subject, record.bodyText);
      await mergeThreadIdentifiers(record.canonicalThreadId);
    } catch (err) {
      console.error("[pipeline] reanalyze: thread identifier merge failed:", err);
    }
  }
  const threadResolution = record.canonicalThreadId
    ? await getThreadResolution(record.canonicalThreadId)
    : null;

  const analysis = await analyzeSupportEmail({
    subject: record.subject,
    body: threadContext.body,
    conversationMessages: threadContext.messages,
    admin,
    shop,
    trackedCallContext: {
      shop,
      emailId: record.id,
      threadId: record.threadId,
    },
    threadResolution: threadResolution
      ? {
          identifiers: {
            orderNumber: threadResolution.orderNumber,
            trackingNumber: threadResolution.trackingNumber,
            email: threadResolution.email,
            customerName: threadResolution.customerName,
          },
          confidence: threadResolution.confidence,
        }
      : undefined,
  });

  await prisma.incomingEmail.update({
    where: { id: emailId },
    data: {
      processingStatus: "analyzed",
      tier2Result: "support_client",
      analysisResult: JSON.stringify(analysis),
      detectedIntent: analysis.intent,
      analysisConfidence: analysis.confidence,
    },
  });
  if (analysis.draftReply) {
    const { upsertReplyDraftBody } = await import("../support/reply-draft");
    await upsertReplyDraftBody(emailId, shop, analysis.draftReply);
  }

  if (record.canonicalThreadId) {
    try {
      await recomputeThreadState(record.canonicalThreadId, {
        mailboxAddress: conn?.email ?? "",
      });
    } catch (err) {
      console.error("[pipeline] reanalyze: state recompute failed:", err);
    }
  }

  return analysis;
}

/**
 * Regenerate a draft reply from the existing analysisResult already stored in DB,
 * without re-fetching Shopify or tracking data. Useful to get a fresh draft
 * when the context is already up-to-date.
 */
export async function redraftEmail(emailId: string, shop: string): Promise<string> {
  const record = await prisma.incomingEmail.findUnique({ where: { id: emailId } });
  if (!record || record.shop !== shop) throw new Error("Email not found");
  if (!record.analysisResult) throw new Error("No analysis result found — run Refresh context first");

  const analysis = JSON.parse(record.analysisResult as string);

  const { generateLLMDraft } = await import("../support/llm-draft");
  const { getSettings } = await import("../support/settings");
  const settings = await getSettings(shop);

  const newDraft = await generateLLMDraft({
    parsed: analysis.parsed ?? { subject: record.subject, body: record.bodyText, identifiers: {} },
    intent: analysis.intent,
    order: analysis.order ?? null,
    orderCandidates: analysis.orderCandidates ?? [],
    trackings: analysis.trackings ?? [],
    crawledContexts: analysis.crawledContexts?.filter((c: { success: boolean }) => c.success) ?? [],
    warnings: analysis.warnings ?? [],
    settings,
    conversationMessages: analysis.conversation?.messages ?? undefined,
    trackedCallContext: { shop, emailId: record.id, threadId: record.threadId },
  });

  const { upsertReplyDraftBody } = await import("../support/reply-draft");
  await upsertReplyDraftBody(emailId, shop, newDraft);

  return newDraft;
}

function getMessageDirection(
  fromAddress: string,
  mailboxAddress: string,
): "incoming" | "outgoing" | "unknown" {
  const from = fromAddress.trim().toLowerCase();
  const mailbox = mailboxAddress.trim().toLowerCase();
  if (!from) return "unknown";
  if (!mailbox) return "unknown";
  return from === mailbox ? "outgoing" : "incoming";
}

/**
 * Resolve the "target" message id: the semantic anchor of a thread's
 * analysis. Source of truth is thread-state.targetMessageId (the latest
 * incoming that passed Tier 1). Falls back to the currently-processed
 * record when no target is set yet.
 */
async function resolveTargetEmailId(
  canonicalThreadId: string | null,
  currentEmailId: string,
): Promise<string> {
  if (!canonicalThreadId) return currentEmailId;
  const state = await readStructuredState(canonicalThreadId);
  return state?.targetMessageId ?? currentEmailId;
}
