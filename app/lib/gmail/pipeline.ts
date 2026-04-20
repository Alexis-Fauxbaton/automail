import prisma from "../../db.server";
import type { AdminGraphqlClient } from "../support/shopify/order-search";
import { analyzeSupportEmail } from "../support/orchestrator";
import type { MailClient, MailMessage } from "../mail/types";
import type { ConversationMessage } from "../support/types";
import { createGmailClient } from "./mail-client";
import { createZohoClient } from "../zoho/client";
import { fetchCustomerEmails } from "./customers";
import { prefilterEmail } from "./prefilter";
import { classifyEmail } from "./classifier";

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

async function getMailClient(shop: string, provider: string): Promise<MailClient> {
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
    // First sync or after resync — fetch up to 1 year
    const afterDate = conn.lastSyncAt ?? new Date(Date.now() - 365 * 24 * 3600_000);
    messageIds = await client.listRecentMessages({ afterDate, maxResults: 2000 });
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
      await ingestAndPrefilter(shop, client, msgId, customerEmails, conn.email, report);
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

  // Upsert the base record
  await prisma.incomingEmail.upsert({
    where: { shop_externalMessageId: { shop, externalMessageId: msgId } },
    create: {
      shop,
      externalMessageId: msg.id,
      threadId: msg.threadId,
      fromAddress: msg.from,
      fromName: msg.fromName,
      subject: msg.subject,
      snippet: msg.snippet,
      bodyText: msg.bodyText,
      receivedAt: msg.receivedAt,
      isKnownCustomer: isKnown,
      processingStatus: isOutgoing ? "outgoing" : "ingested",
    },
    update: {},
  });

  if (isOutgoing) return; // no tiers for outgoing

  // Free regex prefilter
  const record = await prisma.incomingEmail.findUniqueOrThrow({
    where: { shop_externalMessageId: { shop, externalMessageId: msgId } },
  });
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
}

/**
 * Determine which records need Tier 2/3 processing in Pass 2.
 * For every thread touched by the ingestion batch, keep only the LATEST
 * incoming email that passed Tier 1 and hasn't been fully analyzed yet.
 * Older messages in the same thread are marked as "classified" without
 * running further LLM calls (avoids duplicate work and stale drafts).
 */
async function pickThreadsForClassification(
  shop: string,
  newMessageIds: string[],
): Promise<string[]> {
  if (newMessageIds.length === 0) return [];

  // Find which threads were touched by this batch
  const newRecords = await prisma.incomingEmail.findMany({
    where: { shop, externalMessageId: { in: newMessageIds } },
    select: { threadId: true },
  });
  const threadIds = Array.from(new Set(newRecords.map((r) => r.threadId).filter(Boolean)));
  if (threadIds.length === 0) return [];

  const selected: string[] = [];

  for (const threadId of threadIds) {
    // Latest incoming (non-outgoing) in this thread that passed Tier 1
    const latest = await prisma.incomingEmail.findFirst({
      where: {
        shop,
        threadId,
        processingStatus: { notIn: ["outgoing"] },
        tier1Result: "passed",
      },
      orderBy: { receivedAt: "desc" },
    });
    if (!latest) continue;

    // Skip if already fully analyzed
    if (latest.processingStatus === "analyzed") continue;

    selected.push(latest.id);

    // Mark older incoming messages in the same thread as "classified"
    // so they don't consume LLM calls and the UI shows a clean state.
    await prisma.incomingEmail.updateMany({
      where: {
        shop,
        threadId,
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
  const classification = await classifyEmail(msg.subject, msg.bodyText, {
    shop,
    emailId: record.id,
    threadId: record.threadId,
  });
  await prisma.incomingEmail.update({
    where: { id: record.id },
    data: { tier2Result: classification },
  });

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
      record.id,
      mailboxAddress,
      client,
    );

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
    });
    await prisma.incomingEmail.update({
      where: { id: record.id },
      data: {
        processingStatus: "analyzed",
        analysisResult: JSON.stringify(analysis),
        draftReply: analysis.draftReply,
      },
    });
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
  currentEmailId: string,
  mailboxAddress: string,
  client?: MailClient,
): Promise<{ body: string; messages: ConversationMessage[] }> {
  // --- 1. Try provider API for the full thread (incoming + outgoing) ---
  if (threadId && client) {
    try {
      const threadMessages = await client.getThreadMessages(threadId);
      if (threadMessages.length > 0) {
        const currentRecord = await prisma.incomingEmail.findUnique({
          where: { id: currentEmailId },
          select: { externalMessageId: true },
        });
        const currentExternalId = currentRecord?.externalMessageId ?? "";

        // Sort chronologically (provider may already do it, but be safe)
        threadMessages.sort(
          (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
        );

        // Determine "latest": prefer the message matching the currently-processed email;
        // otherwise use the most recent one.
        let latestIdx = threadMessages.findIndex(
          (m) => m.id === currentExternalId,
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

  // --- 2. Fallback to DB (incoming-only) ---
  if (!threadId) {
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
    where: { shop, threadId },
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
    const isLatest = email.id === currentEmailId;
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
    record.id,
    conn?.email ?? "",
    client,
  );

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
  });

  await prisma.incomingEmail.update({
    where: { id: emailId },
    data: {
      processingStatus: "analyzed",
      tier2Result: "support_client",
      analysisResult: JSON.stringify(analysis),
      draftReply: analysis.draftReply,
    },
  });

  return analysis;
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
