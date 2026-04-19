import prisma from "../../db.server";
import type { AdminGraphqlClient } from "../support/shopify/order-search";
import { analyzeSupportEmail } from "../support/orchestrator";
import type { MailClient, MailMessage } from "../mail/types";
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
  };

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
      const afterDate = conn.lastSyncAt ?? new Date(Date.now() - 60 * 24 * 3600_000);
      messageIds = await client.listRecentMessages({ afterDate, maxResults: 500 });
      newCursor = await client.getSyncCursor();
    }
  } else {
    // First sync — fetch since lastSyncAt or last 2 months
    const afterDate = conn.lastSyncAt ?? new Date(Date.now() - 60 * 24 * 3600_000);
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

  // Process each email through the pipeline
  for (const msgId of newMessageIds) {
    try {
      await processOneEmail(shop, admin, client, msgId, customerEmails, report);
    } catch (err) {
      report.errors++;
      console.error(`[gmail/pipeline] Error processing message ${msgId}:`, err);
      // Try to save partial record
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
      } catch { /* ignore save errors */ }
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

async function processOneEmail(
  shop: string,
  admin: AdminGraphqlClient,
  client: MailClient,
  msgId: string,
  customerEmails: Set<string>,
  report: ProcessingReport,
) {
  const msg: MailMessage = await client.getMessage(msgId);
  const isKnown = customerEmails.has(msg.from.toLowerCase());

  // Save to DB immediately
  const record = await prisma.incomingEmail.upsert({
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
      processingStatus: "filtering",
    },
    update: {},
  });

  // --- Tier 1: Prefilter ---
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
    return;
  }

  await prisma.incomingEmail.update({
    where: { id: record.id },
    data: { tier1Result: "passed" },
  });

  // --- Tier 2: LLM classification ---
  const classification = await classifyEmail(msg.subject, msg.bodyText);
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

  // Skip Tier 3 if this is not the latest email in the thread
  if (msg.threadId) {
    const newer = await prisma.incomingEmail.findFirst({
      where: { shop, threadId: msg.threadId, receivedAt: { gt: msg.receivedAt } },
      select: { id: true },
    });
    if (newer) {
      await prisma.incomingEmail.update({
        where: { id: record.id },
        data: { processingStatus: "classified" },
      });
      return;
    }
  }

  try {
    // Build thread context for the LLM
    const bodyWithContext = await buildThreadBody(shop, msg.threadId, record.id);

    const analysis = await analyzeSupportEmail({
      subject: msg.subject,
      body: bodyWithContext,
      admin,
      shop,
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
}

/**
 * Build a combined body from all emails in a thread, ordered chronologically.
 * The current email (identified by currentEmailId) is labeled as "Current message",
 * older ones are labeled as "Previous message".
 */
async function buildThreadBody(
  shop: string,
  threadId: string,
  currentEmailId: string,
): Promise<string> {
  if (!threadId) {
    const current = await prisma.incomingEmail.findUnique({
      where: { id: currentEmailId },
      select: { bodyText: true },
    });
    return current?.bodyText ?? "";
  }

  const threadEmails = await prisma.incomingEmail.findMany({
    where: { shop, threadId },
    orderBy: { receivedAt: "asc" },
    select: { id: true, fromAddress: true, receivedAt: true, bodyText: true },
  });

  if (threadEmails.length <= 1) {
    return threadEmails[0]?.bodyText ?? "";
  }

  const parts: string[] = [];
  for (const email of threadEmails) {
    const date = email.receivedAt.toISOString().slice(0, 10);
    const label = email.id === currentEmailId ? "Current message" : "Previous message";
    parts.push(`--- ${label} (${date}, from: ${email.fromAddress}) ---\n${email.bodyText}`);
  }
  return parts.join("\n\n");
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

  // Build thread context
  const bodyWithContext = await buildThreadBody(shop, record.threadId, record.id);

  const analysis = await analyzeSupportEmail({
    subject: record.subject,
    body: bodyWithContext,
    admin,
    shop,
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
