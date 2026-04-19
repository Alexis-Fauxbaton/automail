import prisma from "../../db.server";
import type { AdminGraphqlClient } from "../support/shopify/order-search";
import { analyzeSupportEmail } from "../support/orchestrator";
import {
  getGmailService,
  getMessage,
  listRecentMessages,
  listHistoryChanges,
  getProfile,
  type GmailMessage,
} from "./client";
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

  const gmail = await getGmailService(shop);
  const conn = await prisma.gmailConnection.findUnique({ where: { shop } });
  if (!conn) throw new Error("No Gmail connection for this shop");

  // Determine which messages to fetch
  let messageIds: string[];
  let newHistoryId: string | undefined;

  if (conn.historyId) {
    // Incremental sync via History API
    const history = await listHistoryChanges(gmail, conn.historyId);
    messageIds = history.messageIds;
    newHistoryId = history.latestHistoryId;

    // If historyId was too old (404), fall back to date-based fetch
    if (messageIds.length === 0 && !newHistoryId) {
      const afterDate = conn.lastSyncAt ?? new Date(Date.now() - 7 * 24 * 3600_000);
      messageIds = await listRecentMessages(gmail, { afterDate, maxResults: 200 });
      const profile = await getProfile(gmail);
      newHistoryId = profile.historyId;
    }
  } else {
    // First sync — fetch since lastSyncAt or last 7 days
    const afterDate = conn.lastSyncAt ?? new Date(Date.now() - 7 * 24 * 3600_000);
    messageIds = await listRecentMessages(gmail, { afterDate, maxResults: 200 });
    const profile = await getProfile(gmail);
    newHistoryId = profile.historyId;
  }

  report.total = messageIds.length;

  // Dedup: skip messages already in DB
  const existing = await prisma.incomingEmail.findMany({
    where: { shop, gmailMessageId: { in: messageIds } },
    select: { gmailMessageId: true },
  });
  const existingIds = new Set(existing.map((e) => e.gmailMessageId));
  const newMessageIds = messageIds.filter((id) => !existingIds.has(id));
  report.alreadyProcessed = messageIds.length - newMessageIds.length;

  if (newMessageIds.length === 0) {
    // Still update sync cursor
    await prisma.gmailConnection.update({
      where: { shop },
      data: {
        lastSyncAt: new Date(),
        ...(newHistoryId ? { historyId: newHistoryId } : {}),
      },
    });
    return report;
  }

  // Fetch Shopify customer emails for cross-reference (Tier 1 boost)
  const customerEmails = await fetchCustomerEmails(admin);

  // Process each email through the pipeline
  for (const msgId of newMessageIds) {
    try {
      await processOneEmail(shop, admin, gmail, msgId, customerEmails, report);
    } catch (err) {
      report.errors++;
      console.error(`[gmail/pipeline] Error processing message ${msgId}:`, err);
      // Try to save partial record
      try {
        await prisma.incomingEmail.upsert({
          where: { shop_gmailMessageId: { shop, gmailMessageId: msgId } },
          create: {
            shop,
            gmailMessageId: msgId,
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
  await prisma.gmailConnection.update({
    where: { shop },
    data: {
      lastSyncAt: new Date(),
      ...(newHistoryId ? { historyId: newHistoryId } : {}),
    },
  });

  return report;
}

async function processOneEmail(
  shop: string,
  admin: AdminGraphqlClient,
  gmail: Awaited<ReturnType<typeof getGmailService>>,
  msgId: string,
  customerEmails: Set<string>,
  report: ProcessingReport,
) {
  const msg: GmailMessage = await getMessage(gmail, msgId);
  const isKnown = customerEmails.has(msg.from.toLowerCase());

  // Save to DB immediately
  const record = await prisma.incomingEmail.upsert({
    where: { shop_gmailMessageId: { shop, gmailMessageId: msgId } },
    create: {
      shop,
      gmailMessageId: msg.id,
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
  try {
    const analysis = await analyzeSupportEmail({
      subject: msg.subject,
      body: msg.bodyText,
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

export async function reanalyzeEmail(
  emailId: string,
  admin: AdminGraphqlClient,
  shop: string,
) {
  const record = await prisma.incomingEmail.findUnique({ where: { id: emailId } });
  if (!record || record.shop !== shop) {
    throw new Error("Email not found");
  }

  const analysis = await analyzeSupportEmail({
    subject: record.subject,
    body: record.bodyText,
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
