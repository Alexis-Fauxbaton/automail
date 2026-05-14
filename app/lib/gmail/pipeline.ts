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
import {
  isOutgoingMessage,
  loadOutgoingContext,
  type OutgoingContext,
} from "../mail/outgoing-detection";
import { upsertReplyDraftBody } from "../support/reply-draft";
import { generateLLMDraft } from "../support/llm-draft";
import { evaluateThread } from "../support/draft-usage-heuristic";
import { getSettings } from "../support/settings";
import { createLogger } from "../log/logger";
import { isWithin48hZone } from "../billing/catchup";

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
  if (provider === "outlook") {
    const { createOutlookClient } = await import("../outlook/mail-client");
    return createOutlookClient(shop);
  }
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
  const log = createLogger({ shop, mod: "gmail/pipeline" });

  // Clear any previous top-level error and cancel flag at the start of a new sync.
  await prisma.mailConnection.update({
    where: { shop },
    data: { lastSyncError: null, syncCancelledAt: null },
  }).catch(() => { /* ignore if connection gone */ });

  try {
    return await _processNewEmails(shop, admin, report, syncStartedAt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Top-level sync error");
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
  const log = createLogger({ shop, mod: "gmail/pipeline" });
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

  // Dedup: skip messages that have already been through Tier 2/3.
  // "classified" emails without tier2Result were ingested by the backfill
  // without LLM analysis — include them so Tier 2/3 can run after a resync,
  // restoring intent badges that would otherwise disappear.
  const existing = await prisma.incomingEmail.findMany({
    where: {
      shop,
      externalMessageId: { in: messageIds },
      OR: [
        { processingStatus: "outgoing" },
        { processingStatus: "analyzed" },
        { processingStatus: "classified", tier2Result: { not: null } },
      ],
    },
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
    // Backfill even when there are no new messages — resolved threads
    // accumulate over time and need intent badges regardless of new activity.
    try {
      await backfillResolvedIntents(shop, admin);
    } catch (err) {
      log.error({ err }, "backfillResolvedIntents failed (no-new-messages path)");
    }
    return report;
  }

  // Fetch Shopify customer emails for cross-reference (Tier 1 boost)
  const customerEmails = await fetchCustomerEmails(admin, shop);

  // Load the outgoing-detection context once per pass so each ingest can
  // reliably tag merchant replies (aliases included) as `outgoing` even when
  // the provider didn't expose a SENT label.
  const outgoingCtx = await loadOutgoingContext(shop, conn.email);

  // PRE-PASS-1: backfill closed-thread intent badges BEFORE Pass 1 mutates
  // operationalState. During a resync (historyId=null), all emails are deleted
  // and re-ingested without analysisResult. Pass 1's recomputeThreadState then
  // temporarily flips no_reply_needed → waiting_merchant (noReplyNeeded=false
  // with no analysisResult). By saving analysisResult here first, we give
  // recomputeThreadState the data it needs to keep those threads in their
  // correct closed state throughout Pass 1 and Pass 2.
  // For regular syncs (few new messages) this call is nearly free: alreadyAnalyzed
  // covers almost all threads and the function returns after two cheap DB queries.
  try {
    await backfillResolvedIntents(shop, admin);
  } catch (err) {
    log.error({ err }, "pre-pass1 backfillResolvedIntents failed");
  }

  // ---------------------------------------------------------------------
  // PASS 1 — Ingestion + Tier 1 (free regex prefilter)
  // Every new message is stored in DB. Outgoing messages are marked and
  // skipped from further tiers. Tier 1 is run here because it is free.
  // This ensures that when Pass 2 runs, the full thread context
  // (including outgoing replies) is already persisted.
  // ---------------------------------------------------------------------
  const INGESTION_BATCH_SIZE = 10;
  for (let i = 0; i < newMessageIds.length; i += INGESTION_BATCH_SIZE) {
    if (i > 0 && (await isCancelled(shop, syncStartedAt))) {
      log.info({ processed: i }, "Sync cancelled during ingestion");
      report.cancelled = true;
      break;
    }
    const batch = newMessageIds.slice(i, i + INGESTION_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (msgId) => {
        try {
          await ingestAndPrefilter(shop, conn.provider, client, msgId, customerEmails, outgoingCtx, report);
        } catch (err) {
          report.errors++;
          log.error({ err, msgId }, "Ingestion error");
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
      }),
    );
  }

  // ---------------------------------------------------------------------
  // PASS 2 — Tier 2 + Tier 3 on the LATEST incoming of each thread only.
  // By now every message (incoming + outgoing) is in DB, so the LLM has
  // the full thread context. We avoid wasting LLM calls on stale replies.
  // ---------------------------------------------------------------------
  if (!report.cancelled) {
    const threadsToClassify = await pickThreadsForClassification(shop, newMessageIds);
    const CLASSIFY_BATCH_SIZE = 5;
    for (let i = 0; i < threadsToClassify.length; i += CLASSIFY_BATCH_SIZE) {
      if (i > 0 && (await isCancelled(shop, syncStartedAt))) {
        log.info({ processed: i }, "Sync cancelled during classification");
        report.cancelled = true;
        break;
      }
      const batch = threadsToClassify.slice(i, i + CLASSIFY_BATCH_SIZE);
      await Promise.allSettled(
        batch.map(async (recordId) => {
          try {
            await classifyAndDraft(shop, admin, client, recordId, customerEmails, conn.email, report);
          } catch (err) {
            report.errors++;
            log.error({ err, recordId }, "Classification error");
            await prisma.incomingEmail.update({
              where: { id: recordId },
              data: {
                processingStatus: "error",
                errorMessage: err instanceof Error ? err.message : String(err),
              },
            }).catch(() => {});
          }
        }),
      );
    }
  }

  // Backfill intent badges for resolved threads that lack detectedIntent.
  // Best-effort: failures must never abort the main sync.
  try {
    await backfillResolvedIntents(shop, admin);
  } catch (err) {
    log.error({ err }, "post-pass2 backfillResolvedIntents failed");
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
  if (attachments.length === 0) return;
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
      providerFolderId: att.providerFolderId ?? null,
    })),
    skipDuplicates: true,
  });
}

const cancelledCache = new Map<string, { result: boolean; checkedAt: number }>();
const CANCEL_CHECK_TTL_MS = 15_000;

async function isCancelled(shop: string, syncStartedAt: Date): Promise<boolean> {
  const now = Date.now();
  const cached = cancelledCache.get(shop);
  if (cached && now - cached.checkedAt < CANCEL_CHECK_TTL_MS) {
    return cached.result;
  }
  const fresh = await prisma.mailConnection.findUnique({
    where: { shop },
    select: { syncCancelledAt: true },
  });
  const result = !!(fresh?.syncCancelledAt && fresh.syncCancelledAt > syncStartedAt);
  cancelledCache.set(shop, { result, checkedAt: now });
  return result;
}

/**
 * Pass 1: fetch the remote message, store it in DB, and run the free
 * regex prefilter. LLM-based tiers are deferred to Pass 2.
 */
export async function ingestAndPrefilter(
  shop: string,
  provider: string,
  client: MailClient,
  msgId: string,
  customerEmails: Set<string>,
  outgoingCtx: OutgoingContext,
  report: ProcessingReport,
) {
  const log = createLogger({ shop, mod: "gmail/pipeline", msgId });
  const msg: MailMessage = await client.getMessage(msgId);
  const isKnown = customerEmails.has(msg.from.toLowerCase());
  const isOutgoing = isOutgoingMessage(msg, outgoingCtx);
  const mailboxAddress = outgoingCtx.mailboxAddress;

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

  const msgAttachments = msg.attachments;
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
  await refreshThreadStats(canonicalThreadId, shop);

  if (isOutgoing) {
    // Outgoing messages still affect operational state (merchant replied
    // → thread should move to waiting_customer), so recompute + return.
    try {
      await recomputeThreadState(canonicalThreadId, { mailboxAddress });
      await evaluateHistoryStatus(canonicalThreadId, shop);
    } catch (err) {
      log.error({ err }, "state recompute (outgoing) failed");
    }
    try {
      await evaluateThread(canonicalThreadId, shop);
    } catch (err) {
      log.error({ err }, "draft-usage heuristic failed");
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
    await mergeThreadIdentifiers(canonicalThreadId, shop);
  } catch (err) {
    // Extraction is best-effort: failures must not block ingestion.
    log.error({ err }, "thread identifier extraction failed");
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
  // Only re-process emails that are truly new (ingested), failed, or
  // were ingested by the backfill without Tier 2 (classified + no tier2Result).
  const isBackfillOnly = record.processingStatus === "classified" && !record.tier2Result;
  if (
    record.processingStatus !== "ingested" &&
    record.processingStatus !== "error" &&
    !isBackfillOnly
  ) {
    // Already processed — still recompute thread state in case a new
    // outgoing message changed the conversation context.
    try {
      await recomputeThreadState(canonicalThreadId, { mailboxAddress });
      await evaluateHistoryStatus(canonicalThreadId, shop);
    } catch (err) {
      log.error({ err }, "state recompute (skip-tier1) failed");
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
    const hist = await evaluateHistoryStatus(canonicalThreadId, shop);

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
          log.error({ err, canonicalThreadId }, "opportunistic backfill failed"),
        );
      }
    }
  } catch (err) {
    log.error({ err }, "state recompute failed");
  }
}

/**
 * Backfill intent badges for resolved threads that have no analysisResult.
 *
 * The inbox list badge reads intent from analysisResult JSON (not detectedIntent).
 * Threads that were resolved before Tier 3 ran have no analysisResult and therefore
 * no badge. This function runs `analyzeSupportEmail` with `skipTracking + skipDraft`
 * (intent + identifiers + Shopify order search, no 17track / crawler / draft) on
 * those threads and stores the result so the badge and matched-order context appear.
 *
 * Per-thread strategy:
 *   1. Skip threads that already have at least one email with analysisResult.
 *   2. For the remaining threads, find the latest incoming email that passed Tier 1.
 *   3. Run analyzeSupportEmail (intent + identifiers + Shopify, no tracking/crawler/draft).
 *   4. Persist analysisResult + detectedIntent + processingStatus="analyzed".
 */
export async function backfillResolvedIntents(
  shop: string,
  admin: AdminGraphqlClient,
  opts: { maxThreads?: number } = {},
): Promise<void> {
  const log = createLogger({ shop, mod: "gmail/pipeline:backfillResolvedIntents" });
  // Step 1: collect thread IDs for both closed states.
  // The inbox "Résolu" bucket displays operationalState "resolved" AND
  // "no_reply_needed" together, so both must be backfilled.
  // Exclude non_support threads: they land in no_reply_needed automatically
  // (deriveOperationalState returns no_reply_needed when replyNeeded=false),
  // but running the LLM on them wastes tokens and bypasses Tier 2 by setting
  // processingStatus="analyzed" before classifyAndDraft can run.
  const [resolvedRows, noReplyRows] = await Promise.all([
    prisma.thread.findMany({ where: { shop, operationalState: "resolved", supportNature: { not: "non_support" } }, select: { id: true } }),
    prisma.thread.findMany({ where: { shop, operationalState: "no_reply_needed", supportNature: { not: "non_support" } }, select: { id: true } }),
  ]);
  const resolvedSet = new Set(resolvedRows.map((t) => t.id));
  const noReplySet = new Set(noReplyRows.map((t) => t.id));

  // Step 1b: threads that appear in the "Résolu" tab via the UI's 7-day
  // auto-resolve heuristic (last message outgoing, age ≥ 7 days) but have no
  // DB Thread record with operationalState "resolved" or "no_reply_needed".
  // This covers both pure sent-folder threads (all outgoing) and mixed threads
  // where the latest email is outgoing. Adding them to resolvedSet lets the
  // anchor strategy (Steps 3a/3b/3c) pick the best email for each.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const outgoingOldIds = (
    await prisma.incomingEmail.findMany({
      where: { shop, processingStatus: "outgoing", receivedAt: { lt: sevenDaysAgo } },
      select: { canonicalThreadId: true },
      distinct: ["canonicalThreadId"],
    })
  )
    .map((e) => e.canonicalThreadId)
    .filter((id): id is string => !!id);
  for (const id of outgoingOldIds) resolvedSet.add(id);

  const allClosedIds = [...resolvedSet, ...noReplySet];
  log.info(
    {
      resolved: resolvedSet.size,
      noReply: noReplySet.size,
      outgoingOld: outgoingOldIds.length,
      total: allClosedIds.length,
    },
    "scan complete",
  );
  if (allClosedIds.length === 0) return;

  // Step 2: threads that already have at least one email with analysisResult.
  const alreadyAnalyzed = new Set(
    (
      await prisma.incomingEmail.findMany({
        where: {
          shop,
          canonicalThreadId: { in: allClosedIds },
          analysisResult: { not: null },
        },
        select: { canonicalThreadId: true },
        distinct: ["canonicalThreadId"],
      })
    )
      .map((e) => e.canonicalThreadId)
      .filter((id): id is string => !!id),
  );

  const needsBackfill = allClosedIds.filter((id) => !alreadyAnalyzed.has(id));
  log.info(
    { alreadyAnalyzed: alreadyAnalyzed.size, needsBackfill: needsBackfill.length },
    "filter applied",
  );
  if (needsBackfill.length === 0) return;

  // Default cap 200 for regular syncs (fast LLM-only calls, but don't hog
  // the sync slot). Callers can pass Infinity for a full resync pass.
  const toProcess = needsBackfill.slice(0, opts.maxThreads ?? 200);
  log.info({ count: toProcess.length }, "thread(s) need intent backfill");

  // Fetch mailbox address once — used by buildThreadContext for direction labels.
  const connEmail = (
    await prisma.mailConnection.findUnique({ where: { shop }, select: { email: true } })
  )?.email ?? "";

  const anchorSelect = {
    id: true,
    subject: true,
    bodyText: true,
    threadId: true,
    canonicalThreadId: true,
  } as const;

  // Process in parallel chunks of 5 — each thread is independent
  // (different canonicalThreadId, no shared state). skipTracking means each
  // iteration is one LLM call + 1-2 Shopify Admin queries (~1-2s).
  // Kept at 5 (not 10) to avoid hitting OpenAI rate limits when
  // backfillResolvedIntents runs right after a heavy processNewEmails Pass 2
  // (which may have already made 50-80 LLM calls during a resync).
  const CONCURRENCY = 5;

  async function processThread(canonicalThreadId: string): Promise<void> {
    // Step 3a: prefer the latest email that passed Tier 1.
    let anchor = await prisma.incomingEmail.findFirst({
      where: {
        shop,
        canonicalThreadId,
        processingStatus: { notIn: ["outgoing", "error"] },
        tier1Result: "passed",
      },
      orderBy: { receivedAt: "desc" },
      select: anchorSelect,
    });

    // Step 3b: fallback — only for "resolved" threads (manually closed by the
    // merchant, definitely a support conversation). Skip for "no_reply_needed"
    // to avoid classifying automated notifications (Trustpilot, Zoho, etc.)
    // that correctly land in that state without a customer email.
    if (!anchor && resolvedSet.has(canonicalThreadId)) {
      anchor = await prisma.incomingEmail.findFirst({
        where: {
          shop,
          canonicalThreadId,
          processingStatus: { notIn: ["outgoing"] },
          bodyText: { not: "" },
        },
        orderBy: { receivedAt: "desc" },
        select: anchorSelect,
      });
    }

    // Step 3c: last resort for "resolved" threads — use the OLDEST outgoing
    // email (AMBIENT HOME's first reply). The first reply typically quotes the
    // customer's original message, giving the LLM enough context to infer
    // intent. This covers threads stored entirely in the Sent folder
    // (canonicalThreadId different from the customer's inbox thread).
    // We do NOT change processingStatus to "analyzed" for these anchors to
    // avoid polluting the Tier 3 counter with sent-folder emails.
    let isOutgoingAnchor = false;
    if (!anchor && resolvedSet.has(canonicalThreadId)) {
      anchor = await prisma.incomingEmail.findFirst({
        where: {
          shop,
          canonicalThreadId,
          processingStatus: "outgoing",
          bodyText: { not: "" },
        },
        orderBy: { receivedAt: "asc" },
        select: anchorSelect,
      });
      if (anchor) isOutgoingAnchor = true;
    }

    // Step 4: no email in DB at all (thread emails are older than the 60-day
    // backfill window, deleted by the resync). Try to pull them from the mail
    // provider via the opportunistic backfill, then retry anchor selection.
    // Covers modern threads with ThreadProviderId mappings. Legacy thr_* threads
    // without mappings will have 0 added and fall through to the skip below.
    if (!anchor && resolvedSet.has(canonicalThreadId)) {
      try {
        const fetched = await runOpportunisticThreadBackfill(canonicalThreadId);
        if (fetched.added > 0) {
          log.info(
            { added: fetched.added, canonicalThreadId },
            "fetched emails from provider for thread",
          );
          // Retry Steps 3a → 3b → 3c after provider fetch.
          anchor = await prisma.incomingEmail.findFirst({
            where: {
              shop, canonicalThreadId,
              processingStatus: { notIn: ["outgoing", "error"] },
              tier1Result: "passed",
            },
            orderBy: { receivedAt: "desc" },
            select: anchorSelect,
          });
          if (!anchor) {
            anchor = await prisma.incomingEmail.findFirst({
              where: {
                shop, canonicalThreadId,
                processingStatus: { notIn: ["outgoing"] },
                bodyText: { not: "" },
              },
              orderBy: { receivedAt: "desc" },
              select: anchorSelect,
            });
          }
          if (!anchor) {
            anchor = await prisma.incomingEmail.findFirst({
              where: { shop, canonicalThreadId, processingStatus: "outgoing", bodyText: { not: "" } },
              orderBy: { receivedAt: "asc" },
              select: anchorSelect,
            });
            if (anchor) isOutgoingAnchor = true;
          }
        }
      } catch (err) {
        log.error({ err, canonicalThreadId }, "provider fetch failed for thread");
      }
    }

    if (!anchor) {
      log.info({ canonicalThreadId }, "no anchor for thread (likely legacy orphan)");
      return;
    }

    log.info(
      {
        anchorId: anchor.id,
        canonicalThreadId,
        tier1BodyChars: anchor.bodyText?.length ?? 0,
      },
      "processThread: anchor selected",
    );

    // Build full thread context (DB fallback, no mail client needed) so the
    // LLM has conversation history, not just the single anchor email body.
    const threadContext = await buildThreadContext(
      shop,
      anchor.threadId,
      canonicalThreadId,
      anchor.id,
      connEmail,
      undefined,
    );

    const threadResolution = await getThreadResolution(canonicalThreadId, shop);
    const analysis = await analyzeSupportEmail({
      subject: anchor.subject,
      body: threadContext.body,
      conversationMessages: threadContext.messages,
      admin,
      shop,
      mailboxAddress: connEmail,
      skipDraft: true,
      // Run the Shopify order search even for resolved threads — the
      // matched order remains useful context. Tracking lookup + crawler
      // stay skipped (no value once the conversation is closed).
      skipTracking: true,
      trackedCallContext: { shop, emailId: anchor.id, threadId: anchor.threadId },
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
    log.info(
      {
        intent: analysis.intent,
        usedLLM: !analysis.warnings?.some((w) => w.code === "llm_fallback"),
        canonicalThreadId,
      },
      "processThread: analyze done",
    );

    // Restore overrides snapshotted by handleResync, if any.
    if (anchor.canonicalThreadId) {
      const { applyPreservedOverridesIfAny } = await import("../support/preserved-overrides");
      await applyPreservedOverridesIfAny(analysis, anchor.canonicalThreadId, shop);
    }

    await prisma.incomingEmail.update({
      where: { id: anchor.id },
      data: {
        analysisResult: JSON.stringify(analysis),
        detectedIntent: analysis.intent,
        analysisConfidence: analysis.confidence,
        // Don't overwrite processingStatus for outgoing anchors — the email
        // stays as "outgoing"; we only add the badge metadata.
        ...(isOutgoingAnchor ? {} : { processingStatus: "analyzed" }),
        lastAnalyzedAt: new Date(),
      },
    });
    // Recompute thread state immediately so Thread.structuredState reflects
    // the new analysisResult. Critical for the pre-Pass-1 call: Pass 1's
    // recomputeThreadState reads analysisResult to decide noReplyNeeded, and
    // a stale structuredState could cause it to flip back to waiting_merchant.
    if (anchor.canonicalThreadId) {
      try {
        await recomputeThreadState(anchor.canonicalThreadId, { mailboxAddress: connEmail });
      } catch (err) {
        log.error({ err, canonicalThreadId }, "processThread: recomputeThreadState failed");
      }
    }
    log.info({ anchorId: anchor.id, intent: analysis.intent }, "processThread: saved");
  }

  let done = 0;
  let failed = 0;
  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const chunk = toProcess.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((canonicalThreadId) =>
        processThread(canonicalThreadId).catch((err) => {
          failed++;
          log.error({ err, canonicalThreadId }, "processThread failed");
        }),
      ),
    );
    done += results.filter((r) => r.status === "fulfilled").length;
    // Small pause between chunks — avoids hammering OpenAI rate limits
    // when backfillResolvedIntents runs immediately after a heavy Pass 2
    // (e.g. full resync with 50+ LLM classification calls).
    if (i + CONCURRENCY < toProcess.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  log.info({ done, failed, total: toProcess.length }, "backfill complete");
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

  const results = await Promise.all(
    canonicalIds.map(async (canonicalThreadId) => {
      const latest = await prisma.incomingEmail.findFirst({
        where: {
          shop,
          canonicalThreadId,
          processingStatus: { notIn: ["outgoing"] },
          tier1Result: "passed",
        },
        orderBy: { receivedAt: "desc" },
      });
      if (!latest) return null;

      if (latest.processingStatus === "analyzed") return null;

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

      return latest.id;
    }),
  );

  return results.filter((id): id is string => id !== null);
}

/**
 * Pass 2: run Tier 2 (LLM classification) and Tier 3 (full support
 * analysis + draft) on the given record. Thread context (incoming AND
 * outgoing) is pulled from DB — it was fully populated in Pass 1.
 */
export async function classifyAndDraft(
  shop: string,
  admin: AdminGraphqlClient,
  client: MailClient,
  recordId: string,
  customerEmails: Set<string>,
  mailboxAddress: string,
  report: ProcessingReport,
) {
  const log = createLogger({ shop, mod: "gmail/pipeline:classifyAndDraft", recordId });
  const record = await prisma.incomingEmail.findFirst({
    where: { id: recordId, shop },
  });
  if (!record) throw new Error(`Email ${recordId} not found for shop ${shop}`);

  // Resolved threads: restore intent badges without hitting Shopify/tracking.
  const thread = record.canonicalThreadId
    ? await prisma.thread.findUnique({
        where: { id: record.canonicalThreadId },
        select: { operationalState: true },
      })
    : null;
  const isResolved = thread?.operationalState === "resolved";

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
    attachments: [],
  };

  // --- Catch-up gate: skip Tier 2 + Tier 3 for emails older than 48h ---
  // When auto-sync resumes after a suspend, it pulls all messages since
  // lastSyncAt. Older messages are marked "received" and surfaced in the
  // inbox; the merchant triggers explicit analysis from the UI (1 quota unit).
  const isFresh = isWithin48hZone(record.receivedAt);
  if (!isFresh) {
    console.log(`[pipeline] ${shop} email=${record.id} older than 48h, skipping Tier 2/3 (catch-up)`);
    await prisma.incomingEmail.update({
      where: { id: record.id },
      data: { processingStatus: "ingested" },
    });
    return;
  }

  // --- Tier 2: LLM classification ---
  // Spec §6, §8: inject the compact structured thread state + the true
  // latest message so the classifier has useful context at low cost.
  const threadStateForClassify = record.canonicalThreadId
    ? await readStructuredState(record.canonicalThreadId)
    : null;
  let trueLatestBody: string | undefined;
  let agentHasReplied = false;
  if (record.canonicalThreadId) {
    const trueLatest = await getTrueLatestMessage(record.canonicalThreadId, shop);
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
      log.error({ err }, "post-Tier2 state recompute failed");
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
      ? await getThreadResolution(record.canonicalThreadId, shop)
      : null;

    // Respect any manual intent override set on the previous anchor.
    // Aligns this path with reanalyzeEmail (which does the same at ~line 1301).
    const prevAnchor = record.canonicalThreadId
      ? await prisma.incomingEmail.findFirst({
          where: {
            canonicalThreadId: record.canonicalThreadId,
            processingStatus: "analyzed",
            analysisResult: { not: null },
            id: { not: record.id },
          },
          orderBy: { receivedAt: "desc" },
          select: { analysisResult: true },
        })
      : null;
    let prevAnalysis: Awaited<ReturnType<typeof analyzeSupportEmail>> | null = null;
    if (prevAnchor?.analysisResult) {
      try {
        prevAnalysis = JSON.parse(prevAnchor.analysisResult) as Awaited<ReturnType<typeof analyzeSupportEmail>>;
      } catch (err) {
        log.error({ err }, "failed to parse prevAnchor analysisResult");
      }
    }
    const reuseIntents = prevAnalysis?.manualOverrides?.intents
      ? {
          intent: prevAnalysis.intent,
          intents: prevAnalysis.intents ?? [prevAnalysis.intent],
          identifiers: prevAnalysis.identifiers,
        }
      : undefined;
    const reuseOrder = prevAnalysis?.manualOverrides?.order
      ? {
          order: prevAnalysis.order ?? null,
          orderCandidates: prevAnalysis.orderCandidates ?? [],
        }
      : undefined;

    const analysis = await analyzeSupportEmail({
      subject: msg.subject,
      body: threadContext.body,
      conversationMessages: threadContext.messages,
      admin,
      shop,
      mailboxAddress,
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
      // Resolved threads: extract intent only, skip Shopify/tracking fetch.
      skipTracking: isResolved,
      reuseIntents,
      reuseOrder,
    });

    // Carry forward manual override markers (same as reanalyzeEmail line ~1342).
    if (prevAnalysis?.manualOverrides) {
      analysis.manualOverrides = prevAnalysis.manualOverrides;
    }

    // Restore overrides snapshotted by handleResync, if any. No-op when
    // there's no snapshot (regular sync path).
    if (record.canonicalThreadId) {
      const { applyPreservedOverridesIfAny } = await import("../support/preserved-overrides");
      await applyPreservedOverridesIfAny(analysis, record.canonicalThreadId, shop);
    }

    if (record.canonicalThreadId && analysis.manualOverrides?.order) {
      const finalOrderNumber = analysis.order?.name?.replace(/^#/, "") ?? null;
      await prisma.thread.update({
        where: { id: record.canonicalThreadId, shop },
        data: { resolvedOrderNumber: finalOrderNumber },
      }).catch((err) => {
        log.error({ err }, "thread order sync failed");
      });
    }

    await prisma.incomingEmail.update({
      where: { id: record.id },
      data: {
        processingStatus: "analyzed",
        analysisResult: JSON.stringify(analysis),
        // Promoted columns — kept in sync with the JSON blob so SQL
        // dashboards / rules don't have to parse JSON.
        detectedIntent: analysis.intent,
        analysisConfidence: analysis.confidence,
        lastAnalyzedAt: new Date(),
      },
    });
    if (record.canonicalThreadId) {
      try {
        await recomputeThreadState(record.canonicalThreadId, {
          mailboxAddress,
        });
      } catch (err) {
        log.error({ err }, "post-Tier3 state recompute failed");
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
export async function buildThreadContext(
  shop: string,
  threadId: string,
  canonicalThreadId: string | null,
  currentEmailId: string,
  mailboxAddress: string,
  client?: MailClient,
): Promise<{ body: string; messages: ConversationMessage[] }> {
  const log = createLogger({ shop, mod: "gmail/pipeline:buildThreadContext" });
  // Resolve the semantic "target" of this analysis: it's the latest
  // incoming message that passed Tier 1, as computed by thread-state.
  // Falls back to the currently-processed record when no target is set
  // (e.g. first message in a fresh thread).
  const targetEmailId = await resolveTargetEmailId(
    canonicalThreadId,
    currentEmailId,
  );
  const targetRecord = await prisma.incomingEmail.findFirst({
    where: { id: targetEmailId, shop },
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
          attachmentFileNames: m.attachments
            .filter((a) => a.disposition === "attachment")
            .map((a) => a.fileName),
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
      log.error({ err, threadId }, "getThreadMessages failed, falling back to DB");
    }
  }

  // --- 2. Fallback to DB, preferring the canonical thread so Zoho
  // splits (several providerThreadIds mapped to the same canonical id)
  // are reassembled into a single conversation.
  if (!canonicalThreadId && !threadId) {
    const current = await prisma.incomingEmail.findFirst({
      where: { id: currentEmailId, shop },
      select: {
        bodyText: true, subject: true, fromAddress: true, receivedAt: true,
        incomingAttachments: { select: { fileName: true, disposition: true } },
      },
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
          attachmentFileNames: current.incomingAttachments
            .filter((a) => a.disposition === "attachment")
            .map((a) => a.fileName),
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
      incomingAttachments: { select: { fileName: true, disposition: true } },
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
      attachmentFileNames: email.incomingAttachments
        .filter((a) => a.disposition === "attachment")
        .map((a) => a.fileName),
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
  options: { skipDraft?: boolean } = {},
) {
  const log = createLogger({ shop, mod: "gmail/pipeline:reanalyzeEmail", emailId });
  const record = await prisma.incomingEmail.findFirst({ where: { id: emailId, shop } });
  if (!record) {
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
    log.error({ err }, "Could not create mail client for reanalyze");
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
      await mergeThreadIdentifiers(record.canonicalThreadId, shop);
    } catch (err) {
      log.error({ err }, "thread identifier merge failed");
    }
  }
  const threadResolution = record.canonicalThreadId
    ? await getThreadResolution(record.canonicalThreadId, shop)
    : null;

  // Honour any manual classification overrides set by the user in the
  // editor: feed the orchestrator with reuseIntents/reuseOrder so the
  // draft is written from the user's chosen classification, not from
  // the LLM's autonomous re-classification.
  const previous = record.analysisResult
    ? (JSON.parse(record.analysisResult) as Awaited<ReturnType<typeof analyzeSupportEmail>>)
    : null;
  const reuseIntents = previous && previous.manualOverrides?.intents
    ? {
        intent: previous.intent,
        intents: previous.intents ?? [previous.intent],
        identifiers: previous.identifiers,
      }
    : undefined;
  const reuseOrder = previous && previous.manualOverrides?.order
    ? {
        order: previous.order,
        orderCandidates: previous.orderCandidates ?? [],
      }
    : undefined;

  const analysis = await analyzeSupportEmail({
    subject: record.subject,
    body: threadContext.body,
    conversationMessages: threadContext.messages,
    admin,
    shop,
    mailboxAddress: conn?.email,
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
    reuseIntents,
    reuseOrder,
  });

  // Carry forward manual override markers so they survive the regen.
  if (previous?.manualOverrides) {
    analysis.manualOverrides = previous.manualOverrides;
  }

  // Restore overrides snapshotted by handleResync, if any.
  if (record.canonicalThreadId) {
    const { applyPreservedOverridesIfAny } = await import("../support/preserved-overrides");
    await applyPreservedOverridesIfAny(analysis, record.canonicalThreadId, shop);
  }

  await prisma.incomingEmail.update({
    where: { id: emailId },
    data: {
      processingStatus: "analyzed",
      tier2Result: "support_client",
      analysisResult: JSON.stringify(analysis),
      detectedIntent: analysis.intent,
      analysisConfidence: analysis.confidence,
      lastAnalyzedAt: new Date(),
    },
  });

  // If the user manually set the order, re-apply it on Thread now that
  // mergeThreadIdentifiers may have pulled an old order number out of
  // the email body again.
  if (record.canonicalThreadId && analysis.manualOverrides?.order) {
    const finalOrderNumber = analysis.order?.name?.replace(/^#/, "") ?? null;
    await prisma.thread.update({
      where: { id: record.canonicalThreadId },
      data: { resolvedOrderNumber: finalOrderNumber },
    }).catch((err) => {
      log.error({ err }, "thread order sync failed");
    });
  }
  if (analysis.draftReply && !options.skipDraft) {
    await upsertReplyDraftBody(emailId, shop, analysis.draftReply);
  }

  if (record.canonicalThreadId) {
    try {
      await recomputeThreadState(record.canonicalThreadId, {
        mailboxAddress: conn?.email ?? "",
      });
    } catch (err) {
      log.error({ err }, "state recompute failed");
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
  const record = await prisma.incomingEmail.findFirst({ where: { id: emailId, shop } });
  if (!record) throw new Error("Email not found");
  if (!record.analysisResult) throw new Error("No analysis result found — run Refresh context first");

  let analysis: ReturnType<typeof JSON.parse>;
  try {
    analysis = JSON.parse(record.analysisResult as string);
  } catch {
    throw new Error("analysisResult is not valid JSON — run Refresh context first");
  }

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
