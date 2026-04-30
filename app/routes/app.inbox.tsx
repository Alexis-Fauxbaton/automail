import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useFetcher, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { useTranslation } from "react-i18next";

import { authenticate } from "../shopify.server";
import { getAuthUrl as getGmailAuthUrl, getConnection, deleteConnection } from "../lib/gmail/auth";
import { getZohoAuthUrl } from "../lib/zoho/auth";
import { reanalyzeEmail, redraftEmail, processNewEmails, getMailClient, persistEmailAttachments, type ProcessingReport } from "../lib/gmail/pipeline";
import { refineDraft } from "../lib/gmail/refine-draft";
import { runDiagnosis, type DiagnosisReport } from "../lib/gmail/diagnose";
import { enqueueJob } from "../lib/mail/job-queue";
import { AnalysisDisplay } from "../components/SupportAnalysisDisplay";
import type { SupportAnalysisExtended } from "../lib/support/orchestrator";
import type { MailProvider } from "../lib/mail/types";
import { decodeHtmlEntities } from "../lib/gmail/client";
import { sanitizeEmailHtml, buildCidMap } from "../lib/mail/sanitize-html";
import { buildReplySubject } from "../lib/support/draft-subject";
import prisma from "../db.server";
import { recordStateTransition } from "../lib/support/thread-state-history";
import {
  MetricCard,
  SegmentedTabs,
  Card,
  InboxIcon,
  SparklesIcon,
  CheckCircleIcon,
  MailIcon,
} from "../components/ui";

// Tracks email IDs for which an HTML body refresh was already submitted
// this browser session, so we don't re-fetch on every remount.
const _refreshedEmailIds = new Set<string>();

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const connection = await getConnection(shop);

  let emails: SerializedEmail[] = [];
  let threadStates: Record<string, SerializedThreadState> = {};
  let priorContact: Record<string, { byAddress: boolean; byOrder: boolean }> = {};
  if (connection) {
    const rows = await prisma.incomingEmail.findMany({
      where: { shop },
      orderBy: { receivedAt: "desc" },
      take: 500,
      include: {
        replyDraft: { include: { attachments: true } },
        incomingAttachments: {
          select: { id: true, fileName: true, mimeType: true, sizeBytes: true, disposition: true, contentId: true, inlineData: true },
        },
      },
    });

    const canonicalIds = Array.from(
      new Set(
        rows
          .map((r) => r.canonicalThreadId)
          .filter((id): id is string => !!id),
      ),
    );

    // For threads that appear in the 500-email window, also load the most
    // recent analyzed email (with analysisResult) per thread — even if it
    // sits outside the window. Without this, old analyzed emails (first
    // customer complaint) are invisible and the analysis + draft blocks
    // never render for long threads.
    const existingIds = new Set(rows.map((r) => r.id));
    let extraRows: typeof rows = [];
    if (canonicalIds.length > 0) {
      const analyzedPerThread = await prisma.incomingEmail.findMany({
        where: {
          shop,
          canonicalThreadId: { in: canonicalIds },
          analysisResult: { not: null },
        },
        orderBy: { receivedAt: "desc" },
        distinct: ["canonicalThreadId"],
        include: {
          replyDraft: { include: { attachments: true } },
          incomingAttachments: {
            select: { id: true, fileName: true, mimeType: true, sizeBytes: true, disposition: true, contentId: true, inlineData: true },
          },
        },
      });
      extraRows = analyzedPerThread.filter((r) => !existingIds.has(r.id));
    }

    emails = [...rows, ...extraRows].map(serializeEmail);
    let threadCreatedAt = new Map<string, Date>();
    if (canonicalIds.length > 0) {
      const threads = await prisma.thread.findMany({
        where: { id: { in: canonicalIds } },
        select: {
          id: true,
          createdAt: true,
          supportNature: true,
          operationalState: true,
          previousOperationalState: true,
          historyStatus: true,
          resolvedOrderNumber: true,
          resolvedTrackingNumber: true,
          resolvedEmail: true,
          resolvedCustomerName: true,
          resolutionConfidence: true,
        },
      });
      threadStates = Object.fromEntries(
        threads.map((t) => [t.id, serializeThreadState(t)]),
      );
      threadCreatedAt = new Map(threads.map((t) => [t.id, t.createdAt]));
    }

    // Cross-thread prior contact: find customer addresses and order numbers
    // that the shop has already replied to in OTHER threads (outgoing present).
    // Done in DB so it covers all history, not just the 500-email window.
    //
    // Badge condition: the OTHER thread has an outgoing message sent BEFORE
    // the current thread was created — i.e. we had already been in contact
    // before this thread even started.
    const outgoingRows = await prisma.incomingEmail.findMany({
      where: { shop, processingStatus: "outgoing" },
      select: { canonicalThreadId: true, receivedAt: true },
    });
    // Map: threadId → earliest AND latest outgoing date in that thread
    const earliestOutgoingByThread = new Map<string, number>();
    const latestOutgoingByThread = new Map<string, number>();
    for (const r of outgoingRows) {
      if (!r.canonicalThreadId) continue;
      const t = r.receivedAt.getTime();
      const prevEarliest = earliestOutgoingByThread.get(r.canonicalThreadId) ?? Infinity;
      if (t < prevEarliest) earliestOutgoingByThread.set(r.canonicalThreadId, t);
      const prevLatest = latestOutgoingByThread.get(r.canonicalThreadId) ?? -Infinity;
      if (t > prevLatest) latestOutgoingByThread.set(r.canonicalThreadId, t);
    }
    const repliedCanonicalIds = [...earliestOutgoingByThread.keys()];

    // Collect customer addresses that appeared in those replied threads
    const repliedAddressRows = repliedCanonicalIds.length > 0
      ? await prisma.incomingEmail.findMany({
          where: {
            shop,
            canonicalThreadId: { in: repliedCanonicalIds },
            processingStatus: { not: "outgoing" },
          },
          select: { fromAddress: true, canonicalThreadId: true },
        })
      : [];
    // Map: lowercase address → set of threadIds where we replied.
    // Shared system sender addresses (Shopify contact form forwards, etc.)
    // are excluded: they're not real customer identities and would match
    // every forwarded message, making the "same address" signal noise.
    const SHARED_SYSTEM_ADDRESSES = new Set([
      "mailer@shopify.com",
      "noreply@shopify.com",
      "no-reply@shopify.com",
    ]);
    const addressRepliedIn = new Map<string, Set<string>>();
    for (const r of repliedAddressRows) {
      if (!r.canonicalThreadId) continue;
      const addr = r.fromAddress.toLowerCase();
      if (SHARED_SYSTEM_ADDRESSES.has(addr)) continue;
      if (!addressRepliedIn.has(addr)) addressRepliedIn.set(addr, new Set());
      addressRepliedIn.get(addr)!.add(r.canonicalThreadId);
    }
    // Map: orderNumber → set of threadIds where we replied
    const orderRepliedIn = new Map<string, Set<string>>();
    if (repliedCanonicalIds.length > 0) {
      const repliedThreadMeta = await prisma.thread.findMany({
        where: { id: { in: repliedCanonicalIds } },
        select: { id: true, resolvedOrderNumber: true },
      });
      for (const r of repliedThreadMeta) {
        if (!r.resolvedOrderNumber) continue;
        if (!orderRepliedIn.has(r.resolvedOrderNumber)) orderRepliedIn.set(r.resolvedOrderNumber, new Set());
        orderRepliedIn.get(r.resolvedOrderNumber)!.add(r.id);
      }
    }
    // Build lookup: canonicalThreadId → { byAddress, byOrder, recentReply }
    // - byAddress / byOrder: other thread had an outgoing BEFORE this thread was created
    // - recentReply: other thread had an outgoing AFTER the latest incoming of this
    //   thread (relevant for to_process threads: we may have already replied elsewhere
    //   after the customer sent this message)
    const priorContactByThread: Record<string, { byAddress: boolean; byOrder: boolean; recentReply: boolean; matchedAddress: string | null }> = {};
    for (const id of canonicalIds) {
      const state = threadStates[id];
      const currentCreatedAt = threadCreatedAt.get(id);
      if (!currentCreatedAt) continue;
      const incomingMsgs = rows.filter(
        (r) => r.canonicalThreadId === id && r.processingStatus !== "outgoing",
      );
      const latestIncomingAt = incomingMsgs.reduce(
        (max, r) => (r.receivedAt.getTime() > max ? r.receivedAt.getTime() : max),
        0,
      );
      // Use the earliest real incoming message date as the reference point for "prior contact".
      // thread.createdAt reflects the DB insertion time (backfill date), not the actual first
      // customer message — using it would cause false positives for backfilled threads.
      const earliestIncomingAt = incomingMsgs.reduce(
        (min, r) => (r.receivedAt.getTime() < min ? r.receivedAt.getTime() : min),
        Infinity,
      );
      const threadStartedAt = earliestIncomingAt < Infinity ? earliestIncomingAt : currentCreatedAt.getTime();
      // Filter out shared system sender addresses: matching on them is noise,
      // not a real customer-identity signal.
      const addrs = incomingMsgs
        .map((r) => r.fromAddress.toLowerCase())
        .filter((a) => !SHARED_SYSTEM_ADDRESSES.has(a));
      // Other thread sent outgoing BEFORE the first real message of this thread
      const hadEarlierReply = (tid: string) =>
        tid !== id && (earliestOutgoingByThread.get(tid) ?? Infinity) < threadStartedAt;
      // Other thread sent outgoing AFTER latest incoming of this thread
      const hasRecentReply = (tid: string) =>
        tid !== id && latestIncomingAt > 0 &&
        (latestOutgoingByThread.get(tid) ?? -Infinity) > latestIncomingAt;
      let matchedAddress: string | null = null;
      const byAddress = addrs.some((addr) => {
        const ids = addressRepliedIn.get(addr);
        const hit = ids ? [...ids].some(hadEarlierReply) : false;
        if (hit && !matchedAddress) matchedAddress = addr;
        return hit;
      });
      const byOrder = !!state?.resolvedOrderNumber && (() => {
        const ids = orderRepliedIn.get(state.resolvedOrderNumber!);
        return ids ? [...ids].some(hadEarlierReply) : false;
      })();
      const recentReply =
        addrs.some((addr) => {
          const ids = addressRepliedIn.get(addr);
          return ids ? [...ids].some(hasRecentReply) : false;
        }) ||
        (!!state?.resolvedOrderNumber && (() => {
          const ids = orderRepliedIn.get(state.resolvedOrderNumber!);
          return ids ? [...ids].some(hasRecentReply) : false;
        })());
      if (byAddress || byOrder || recentReply) priorContactByThread[id] = { byAddress, byOrder, recentReply, matchedAddress };
    }
    priorContact = priorContactByThread;
  }

  // Build auth URLs for both providers (only shown when not connected)
  let gmailAuthUrl: string | null = null;
  let zohoAuthUrl: string | null = null;
  if (!connection) {
    try { gmailAuthUrl = getGmailAuthUrl(shop); } catch { /* credentials not configured */ }
    try { zohoAuthUrl = getZohoAuthUrl(shop); } catch { /* credentials not configured */ }
  }

  // Check if a heavy background job is still pending or running for this shop.
  // This lets the UI warn the user that badges / states may not yet be final.
  const activeHeavyJob = await prisma.syncJob.findFirst({
    where: {
      shop,
      kind: { in: ["sync", "resync", "backfill", "recompute", "reclassify"] },
      status: { in: ["pending", "running"] },
    },
    select: { kind: true },
  });
  const syncInProgress = !!activeHeavyJob;

  return {
    connected: !!connection,
    provider: (connection?.provider ?? null) as MailProvider | null,
    connectedEmail: connection?.email ?? null,
    lastSyncAt: connection?.lastSyncAt?.toISOString() ?? null,
    lastSyncError: connection?.lastSyncError ?? null,
    autoSyncEnabled: connection?.autoSyncEnabled ?? false,
    autoSyncIntervalMinutes: connection?.autoSyncIntervalMinutes ?? 5,
    gmailAuthUrl,
    zohoAuthUrl,
    emails,
    threadStates,
    priorContact,
    syncInProgress,
  };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("_action") ?? "");

  if (intent === "disconnect") {
    await deleteConnection(session.shop);
    return { disconnected: true, report: null, reanalyzed: null, refined: null, stopped: false };
  }

  if (intent === "stop") {
    await prisma.mailConnection.update({
      where: { shop: session.shop },
      data: { syncCancelledAt: new Date() },
    });
    return { stopped: true, report: null, disconnected: false, reanalyzed: null, refined: null };
  }

  if (intent === "resync") {
    await prisma.incomingEmail.deleteMany({ where: { shop: session.shop } });
    await prisma.mailConnection.update({
      where: { shop: session.shop },
      // Reset cursor + backfill flag so onboarding backfill re-runs.
      data: { historyId: null, lastSyncAt: null, onboardingBackfillDoneAt: null },
    });
    // Enqueue a durable resync job. The auto-sync worker picks it up on
    // the next tick — survives a process restart, unlike the previous
    // fire-and-forget Promise.
    await enqueueJob(session.shop, "resync");
    return { syncStarted: true, report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
  }

  if (intent === "reclassify") {
    await enqueueJob(session.shop, "reclassify");
    return { syncStarted: true, report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
  }

  if (intent === "sync") {
    // Run inline — incremental sync with cursor is fast (seconds, not minutes).
    // enqueueJob is reserved for heavy backfill/resync operations.
    const report = await processNewEmails(session.shop, admin);
    return { report, syncCompleted: true, disconnected: false, reanalyzed: null, refined: null, stopped: false };
  }

  if (intent === "backfill") {
    const days = Number(formData.get("days") ?? "60");
    const afterDate = new Date(Date.now() - Math.max(1, days) * 24 * 3600_000);
    await enqueueJob(session.shop, "backfill", {
      afterDateIso: afterDate.toISOString(),
    });
    return {
      syncStarted: true,
      report: null,
      disconnected: false,
      reanalyzed: null,
      refined: null,
      stopped: false,
    };
  }

  if (intent === "toggleAutoSync") {
    const enable = formData.get("enable") === "1";
    await prisma.mailConnection.update({
      where: { shop: session.shop },
      data: { autoSyncEnabled: enable },
    });
    return { report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
  }

  if (intent === "diagnose") {
    const diagnosis = await runDiagnosis(session.shop);
    return { diagnosis, report: null, disconnected: false, reanalyzed: null, refined: null };
  }

  if (intent === "reanalyze") {
    const emailId = String(formData.get("emailId") ?? "");
    const analysis = await reanalyzeEmail(emailId, admin, session.shop);
    return { reanalyzed: { emailId, analysis }, report: null, disconnected: false, refined: null };
  }

  if (intent === "redraft") {
    const emailId = String(formData.get("emailId") ?? "");
    await redraftEmail(emailId, session.shop);
    return { reanalyzed: null, report: null, disconnected: false, refined: null };
  }

  if (intent === "refresh_email_html") {
    const emailId = String(formData.get("emailId") ?? "");
    const record = await prisma.incomingEmail.findUnique({
      where: { id: emailId },
      select: { shop: true, externalMessageId: true },
    });
    if (!record || record.shop !== session.shop) {
      return { report: null, disconnected: false, reanalyzed: null, refined: null };
    }
    const conn = await prisma.mailConnection.findUnique({ where: { shop: session.shop } });
    if (!conn) return { report: null, disconnected: false, reanalyzed: null, refined: null };
    try {
      const client = await getMailClient(session.shop, conn.provider);
      const msg = await client.getMessage(record.externalMessageId);
      const msgAttachments = msg.attachments ?? [];
      console.log(`[refresh_email_html] email=${emailId} hasHtml=${!!msg.bodyHtml} attachments=${msgAttachments.length}`);
      await prisma.incomingEmail.update({
        where: { id: emailId },
        data: {
          ...(msg.bodyHtml !== undefined ? { bodyHtml: msg.bodyHtml } : {}),
          hasAttachments: msgAttachments.length > 0,
        },
      });
      if (msgAttachments.length > 0) {
        await persistEmailAttachments(emailId, session.shop, conn.provider, record.externalMessageId, msgAttachments);
      }
      console.log(`[refresh_email_html] done email=${emailId}`);
    } catch (err) {
      console.error("[refresh_email_html] failed:", err);
    }
    return { report: null, disconnected: false, reanalyzed: null, refined: null };
  }

  if (intent === "refine") {
    const emailId = String(formData.get("emailId") ?? "");
    const instructions = String(formData.get("instructions") ?? "");
    const currentDraft = String(formData.get("currentDraft") ?? "");
    const record = await prisma.incomingEmail.findUnique({ where: { id: emailId } });
    if (!record || record.shop !== session.shop || !currentDraft || !instructions) {
      return { report: null, disconnected: false, reanalyzed: null, refined: null };
    }
    const newDraft = await refineDraft(currentDraft, instructions, {
      subject: record.subject,
      body: record.bodyText,
    }, {
      shop: session.shop,
      emailId: emailId,
      threadId: record.threadId,
    });
    const { upsertReplyDraftBody } = await import("../lib/support/reply-draft");
    await upsertReplyDraftBody(emailId, session.shop, newDraft);
    const updatedRD = await prisma.replyDraft.findUnique({
      where: { emailId },
      select: { bodyHistory: true },
    });
    const history = Array.isArray(updatedRD?.bodyHistory)
      ? (updatedRD!.bodyHistory as string[])
      : [];
    return { refined: { emailId, newDraft, draftHistory: history }, report: null, disconnected: false, reanalyzed: null };
  }

  if (intent === "moveThread") {
    const canonicalThreadId = String(formData.get("canonicalThreadId") ?? "");
    const target = String(formData.get("target") ?? "");
    // Allowed operational states for manual override
    const ALLOWED_STATES = new Set([
      "waiting_merchant",
      "waiting_customer",
      "resolved",
    ]);
    if (!canonicalThreadId || !ALLOWED_STATES.has(target)) {
      return { report: null, disconnected: false, reanalyzed: null, refined: null };
    }
    // When reopening (moving to waiting_merchant), ensure the thread is
    // considered support so it doesn't fall into "other".
    const forceSupport = target === "waiting_merchant" || target === "waiting_customer";
    const thread = await prisma.thread.findUnique({
      where: { id: canonicalThreadId },
      select: { shop: true, supportNature: true, operationalState: true },
    });
    if (!thread || thread.shop !== session.shop) {
      return { report: null, disconnected: false, reanalyzed: null, refined: null };
    }
    // When manually resolving, remember where the thread came from.
    const previousOperationalState =
      target === "resolved" ? (thread.operationalState ?? null) : null;
    await prisma.thread.update({
      where: { id: canonicalThreadId },
      data: {
        operationalState: target,
        previousOperationalState,
        operationalStateUpdatedAt: new Date(),
        ...(forceSupport && thread.supportNature !== "confirmed_support"
          ? { supportNature: "confirmed_support", supportNatureUpdatedAt: new Date() }
          : {}),
      },
    });
    await recordStateTransition(prisma, {
      shop: session.shop,
      threadId: canonicalThreadId,
      fromState: thread.operationalState ?? null,
      toState: target,
    });
    return { movedThread: { canonicalThreadId, target }, report: null, disconnected: false, reanalyzed: null, refined: null };
  }

  if (intent === "editThreadIdentifiers") {
    const canonicalThreadId = String(formData.get("canonicalThreadId") ?? "");
    if (!canonicalThreadId) {
      return { report: null, disconnected: false, reanalyzed: null, refined: null };
    }
    const thread = await prisma.thread.findUnique({
      where: { id: canonicalThreadId },
      select: { shop: true },
    });
    if (!thread || thread.shop !== session.shop) {
      return { report: null, disconnected: false, reanalyzed: null, refined: null };
    }
    // Normalize: empty string → null. Strip leading '#' on order number.
    const norm = (v: FormDataEntryValue | null): string | null => {
      const s = (v == null ? "" : String(v)).trim();
      return s === "" ? null : s;
    };
    const orderRaw = norm(formData.get("resolvedOrderNumber"));
    const resolvedOrderNumber = orderRaw ? orderRaw.replace(/^#/, "").trim() || null : null;
    const resolvedTrackingNumber = norm(formData.get("resolvedTrackingNumber"));
    const resolvedEmail = norm(formData.get("resolvedEmail"))?.toLowerCase() ?? null;
    const resolvedCustomerName = norm(formData.get("resolvedCustomerName"));
    await prisma.thread.update({
      where: { id: canonicalThreadId },
      data: {
        resolvedOrderNumber,
        resolvedTrackingNumber,
        resolvedEmail,
        resolvedCustomerName,
        // Merchant-provided values are ground truth.
        resolutionConfidence: "high",
      },
    });
    return { editedThread: { canonicalThreadId }, report: null, disconnected: false, reanalyzed: null, refined: null };
  }

  return { report: null, disconnected: false, reanalyzed: null, refined: null };
};

// ---------------------------------------------------------------------------
// Types & serialization
// ---------------------------------------------------------------------------

interface SerializedThreadState {
  supportNature: string;
  operationalState: string;
  previousOperationalState: string | null;
  historyStatus: string;
  resolvedOrderNumber: string | null;
  resolvedTrackingNumber: string | null;
  resolvedEmail: string | null;
  resolvedCustomerName: string | null;
  resolutionConfidence: string;
}

function serializeThreadState(t: {
  supportNature: string;
  operationalState: string;
  previousOperationalState: string | null;
  historyStatus: string;
  resolvedOrderNumber: string | null;
  resolvedTrackingNumber: string | null;
  resolvedEmail: string | null;
  resolvedCustomerName: string | null;
  resolutionConfidence: string;
}): SerializedThreadState {
  return {
    supportNature: t.supportNature,
    operationalState: t.operationalState,
    previousOperationalState: t.previousOperationalState,
    historyStatus: t.historyStatus,
    resolvedOrderNumber: t.resolvedOrderNumber,
    resolvedTrackingNumber: t.resolvedTrackingNumber,
    resolvedEmail: t.resolvedEmail,
    resolvedCustomerName: t.resolvedCustomerName,
    resolutionConfidence: t.resolutionConfidence,
  };
}

interface IncomingAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  disposition: string;
  contentId: string | null;
  inlineData: string | null;
}

interface SerializedEmail {
  id: string;
  externalMessageId: string;
  threadId: string;
  canonicalThreadId: string | null;
  fromAddress: string;
  fromName: string;
  subject: string;
  snippet: string;
  bodyText: string;
  bodyHtml: string;
  incomingAttachments: IncomingAttachment[];
  receivedAt: string;
  tier1Result: string | null;
  tier2Result: string | null;
  isKnownCustomer: boolean;
  processingStatus: string;
  analysisResult: SupportAnalysisExtended | null;
  draftReply: string | null;
  draftHistory: string[];
  draftCC: string | null;
  draftBCC: string | null;
  draftSubject: string | null;
  draftReplyMode: string;
  draftAttachments: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    source: string;
    storagePath: string | null;
    threadAttachmentRef: string | null;
  }>;
  replyDraftId: string | null;
  errorMessage: string | null;
}

function serializeEmail(row: {
  id: string;
  externalMessageId: string;
  threadId: string;
  canonicalThreadId: string | null;
  fromAddress: string;
  fromName: string;
  subject: string;
  snippet: string;
  bodyText: string;
  bodyHtml: string;
  receivedAt: Date;
  tier1Result: string | null;
  tier2Result: string | null;
  isKnownCustomer: boolean;
  processingStatus: string;
  analysisResult: string | null;
  errorMessage: string | null;
  incomingAttachments: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    disposition: string;
    contentId: string | null;
    inlineData: string | null;
  }>;
  replyDraft?: {
    id: string;
    body: string | null;
    bodyHistory: unknown;
    cc: string | null;
    bcc: string | null;
    subject: string | null;
    replyMode: string;
    attachments: Array<{
      id: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      source: string;
      storagePath: string | null;
      threadAttachmentRef: string | null;
    }>;
  } | null;
}): SerializedEmail {
  let parsed: SupportAnalysisExtended | null = null;
  if (row.analysisResult) {
    try { parsed = JSON.parse(row.analysisResult); } catch { /* ignore */ }
  }
  const rd = row.replyDraft ?? null;
  const history: string[] = Array.isArray(rd?.bodyHistory) ? (rd!.bodyHistory as string[]) : [];
  return {
    id: row.id,
    externalMessageId: row.externalMessageId,
    threadId: row.threadId,
    canonicalThreadId: row.canonicalThreadId,
    fromAddress: row.fromAddress,
    fromName: decodeHtmlEntities(row.fromName),
    subject: decodeHtmlEntities(row.subject),
    snippet: decodeHtmlEntities(row.snippet),
    bodyText: decodeHtmlEntities(row.bodyText),
    bodyHtml: row.bodyHtml,
    incomingAttachments: row.incomingAttachments,
    receivedAt: row.receivedAt.toISOString(),
    tier1Result: row.tier1Result,
    tier2Result: row.tier2Result,
    isKnownCustomer: row.isKnownCustomer,
    processingStatus: row.processingStatus,
    analysisResult: parsed,
    draftReply: rd?.body ?? null,
    draftHistory: history,
    draftCC: rd?.cc ?? null,
    draftBCC: rd?.bcc ?? null,
    draftSubject: rd?.subject ?? null,
    draftReplyMode: rd?.replyMode ?? "thread",
    draftAttachments: rd?.attachments ?? [],
    replyDraftId: rd?.id ?? null,
    errorMessage: row.errorMessage,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Secondary classification filter, kept from the previous UI.
// Primary inbox buckets below now drive the main tabs.
type NatureFilter = "all" | "support" | "uncertain" | "filtered" | "non_support";

function getClassification(email: SerializedEmail): NatureFilter {
  if (email.tier1Result?.startsWith("filtered:")) return "filtered";
  if (email.tier2Result === "support_client") return "support";
  if (email.tier2Result === "incertain") return "uncertain";
  if (email.tier2Result === "probable_non_client") return "non_support";
  return "all";
}

// Primary inbox bucket derived from the thread's operational state +
// whether the latest message needs a reply. This is the view a merchant
// actually cares about ("what do I have to do next?").
type OpsBucket =
  | "to_process"       // support thread waiting for a human reply
  | "waiting_customer" // we replied, awaiting customer
  | "waiting_merchant" // internal / data action required on our side
  | "resolved"         // closed, no reply needed, or conversation ended
  | "other";           // filtered / non-support / unknown

function getOpsBucket(
  thread: EmailThread,
  state: SerializedThreadState | null,
  connectedEmail: string | null,
): OpsBucket {
  // Threads explicitly classified as non-support by Tier 2 never belong
  // in actionable or resolved buckets — they have nothing to do in a support inbox.
  if (state?.supportNature === "non_support") return "other";
  // A manual "resolved" set by the agent always wins — never override it
  // with automatic signal (e.g. last message incoming). This lets agents
  // explicitly close a thread even when the customer has the last word.
  if (state?.operationalState === "resolved" || state?.operationalState === "no_reply_needed") {
    return "resolved";
  }
  if (threadNeedsReply(thread, connectedEmail)) return "to_process";
  const op = state?.operationalState;
  // Before trusting the DB operational state, check message direction.
  // If the last message is outgoing but DB says "waiting_merchant", the
  // DB state is stale (thread was not recomputed after we sent a reply).
  // Override to a direction-consistent bucket so the UI is never wrong.
  const lastDir = getMessageDirection(thread.latest, connectedEmail);
  if (op === "waiting_merchant" && lastDir === "outgoing") {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const age = Date.now() - new Date(thread.latest.receivedAt).getTime();
    return age >= sevenDaysMs ? "resolved" : "waiting_customer";
  }
  if (op === "waiting_merchant") return "waiting_merchant";
  if (op === "waiting_customer") {
    // Auto-resolve threads where the customer hasn't replied in 7 days
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const age = Date.now() - new Date(thread.latest.receivedAt).getTime();
    if (age >= sevenDaysMs) return "resolved";
    return "waiting_customer";
  }
  if (thread.latest.analysisResult?.conversation?.noReplyNeeded === true) return "resolved";
  // Support/uncertain threads with no explicit operational state yet
  // (e.g. old threads before state tracking, or threads where recompute
  // hasn't run). Infer from the last message direction so the bucket is
  // at least plausible while the background recompute job catches up.
  const isLikelySupport =
    state?.supportNature === "confirmed_support" ||
    state?.supportNature === "needs_review" ||
    (!state && getThreadClassification(thread) === "support");
  if (isLikelySupport) {
    if (lastDir === "outgoing") {
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const age = Date.now() - new Date(thread.latest.receivedAt).getTime();
      return age >= sevenDaysMs ? "resolved" : "waiting_customer";
    }
    return "waiting_merchant";
  }
  return "other";
}

function hasLinkedOrder(state: SerializedThreadState | null): boolean {
  return !!state?.resolvedOrderNumber;
}

function filterReason(email: SerializedEmail): string | null {
  if (!email.tier1Result?.startsWith("filtered:")) return null;
  return email.tier1Result.replace("filtered:", "");
}

function relativeTime(dateStr: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return t("inbox.justNow");
  if (mins < 60) return t("inbox.timeAgoMinutes", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("inbox.timeAgoHours", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("inbox.timeAgoDays", { n: days });
  return new Date(dateStr).toLocaleDateString();
}

function getMessageDirection(
  email: SerializedEmail,
  connectedEmail: string | null,
): "incoming" | "outgoing" | "unknown" {
  const from = email.fromAddress.trim().toLowerCase();
  const mailbox = (connectedEmail ?? "").trim().toLowerCase();
  if (!from || !mailbox) return "unknown";
  return from === mailbox ? "outgoing" : "incoming";
}

function threadNeedsReply(
  thread: EmailThread,
  connectedEmail: string | null,
): boolean {
  const latestDirection = getMessageDirection(thread.latest, connectedEmail);
  const noReplyNeeded = thread.latest.analysisResult?.conversation?.noReplyNeeded === true;
  const isSupport = getThreadClassification(thread) === "support";
  return isSupport && latestDirection === "incoming" && !noReplyNeeded;
}

// ---------------------------------------------------------------------------
// Thread grouping
// ---------------------------------------------------------------------------

interface EmailThread {
  threadId: string;
  emails: SerializedEmail[]; // chronological order (oldest first)
  latest: SerializedEmail;   // most recent email
}

function groupByThread(emails: SerializedEmail[]): EmailThread[] {
  // Group by canonical thread id (populated at ingestion by the backend
  // thread resolver). Fall back to providerThreadId, then to the email
  // id for legacy rows that predate the canonical-thread migration.
  const map = new Map<string, SerializedEmail[]>();
  for (const email of emails) {
    const key = email.canonicalThreadId || email.threadId || email.id;
    const arr = map.get(key) ?? [];
    arr.push(email);
    map.set(key, arr);
  }

  const threads: EmailThread[] = [];
  for (const [threadId, threadEmails] of map) {
    threadEmails.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
    const latest = threadEmails[threadEmails.length - 1];
    threads.push({ threadId, emails: threadEmails, latest });
  }
  threads.sort((a, b) => new Date(b.latest.receivedAt).getTime() - new Date(a.latest.receivedAt).getTime());
  return threads;
}

function getThreadClassification(thread: EmailThread): NatureFilter {
  // Use the latest email that has actually been classified to avoid outgoing
  // messages (which have no tier results) from overriding the thread category.
  const classified = [...thread.emails]
    .reverse()
    .find((e) => e.tier1Result || e.tier2Result);
  return getClassification(classified ?? thread.latest);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConnectionCard({
  connected,
  provider,
  connectedEmail,
  lastSyncAt,
  gmailAuthUrl,
  zohoAuthUrl,
  isSyncing,
  autoSyncEnabled,
  autoSyncIntervalMinutes,
}: {
  connected: boolean;
  provider: MailProvider | null;
  connectedEmail: string | null;
  lastSyncAt: string | null;
  gmailAuthUrl: string | null;
  zohoAuthUrl: string | null;
  isSyncing: boolean;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
}) {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  if (!connected) {
    return (
      <s-box padding="large-500" borderWidth="base" borderRadius="large-200" background="subdued">
        <s-stack direction="block" gap="base" align="center">
          <s-heading>{t("inbox.connectHeading")}</s-heading>
          <s-paragraph>
            {t("inbox.connectDesc")}
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            {gmailAuthUrl && (
              <s-link href={gmailAuthUrl}>
                <s-button variant="primary">{t("inbox.connectGmail")}</s-button>
              </s-link>
            )}
            {zohoAuthUrl && (
              <s-link href={zohoAuthUrl}>
                <s-button variant="secondary">{t("inbox.connectZoho")}</s-button>
              </s-link>
            )}
          </s-stack>
        </s-stack>
      </s-box>
    );
  }

  const providerLabel = provider === "zoho" ? "Zoho Mail" : "Gmail";

  return (
    <s-stack direction="block" gap="small-300">
      {/* Row 1: status — what mailbox is connected, when did it last sync */}
      <s-stack direction="inline" gap="base" align="center" blockAlign="center">
        <s-stack direction="block" gap="small-100" align="start">
          <s-paragraph>
            <strong>{connectedEmail}</strong>
            <s-text tone="subdued"> ({providerLabel})</s-text>
          </s-paragraph>
          {lastSyncAt && (
            <s-text variant="bodySm" tone="subdued">
              {t("inbox.lastSync", { time: relativeTime(lastSyncAt, t) })}
              {" · "}
              {autoSyncEnabled ? t("inbox.autoSyncOn", { minutes: autoSyncIntervalMinutes }) : t("inbox.autoSyncOff")}
            </s-text>
          )}
        </s-stack>

        {/* Primary actions: what a merchant uses day-to-day. */}
        <s-stack direction="inline" gap="small-300">
          <Form method="post">
            <input type="hidden" name="_action" value="sync" />
            <s-button variant="primary" type="submit" {...(isSyncing ? { loading: true } : {})}>
              {isSyncing ? t("inbox.syncing") : t("inbox.syncNow")}
            </s-button>
          </Form>
          <Form method="post">
            <input type="hidden" name="_action" value="toggleAutoSync" />
            <input type="hidden" name="enable" value={autoSyncEnabled ? "0" : "1"} />
            <s-button variant="tertiary" type="submit">
              {autoSyncEnabled ? t("inbox.pauseAutoSync") : t("inbox.resumeAutoSync")}
            </s-button>
          </Form>
          <s-button variant="plain" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? t("inbox.hideAdvanced") : t("inbox.showAdvanced")}
          </s-button>
        </s-stack>
      </s-stack>

      {/* Advanced row: power-user / debug actions, hidden by default. */}
      {showAdvanced && (
        <s-box padding="small-300" background="subdued" borderRadius="base">
          <s-stack direction="inline" gap="small-300">
            <Form method="post">
              <input type="hidden" name="_action" value="backfill" />
              <input type="hidden" name="days" value="60" />
              <s-button variant="tertiary" type="submit" {...(isSyncing ? { loading: true } : {})}>
                {t("inbox.backfill")}
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="_action" value="resync" />
              <s-button variant="tertiary" type="submit" {...(isSyncing ? { loading: true } : {})}>
                {t("inbox.resyncAll")}
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="_action" value="reclassify" />
              <s-button variant="tertiary" type="submit" {...(isSyncing ? { loading: true } : {})}>
                {t("inbox.reclassify")}
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="_action" value="diagnose" />
              <s-button variant="tertiary" type="submit">
                {t("inbox.diagnose")}
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="_action" value="disconnect" />
              <s-button tone="critical" variant="plain" type="submit">
                {t("inbox.disconnect")}
              </s-button>
            </Form>
          </s-stack>
        </s-box>
      )}
    </s-stack>
  );
}

// Inbox-level filters applied on top of the primary operational tab.
interface InboxFilters {
  search: string;
  orderLinked: "any" | "yes" | "no";
  nature: NatureFilter;
  intent: string;
}

function FiltersBar({
  filters,
  onChange,
  onReset,
  intentOptions,
}: {
  filters: InboxFilters;
  onChange: (next: InboxFilters) => void;
  onReset: () => void;
  intentOptions: string[];
}) {
  const { t } = useTranslation();
  const isDefault =
    filters.search === "" &&
    filters.orderLinked === "any" &&
    filters.nature === "all" &&
    filters.intent === "";

  // Plain HTML controls on purpose: Shopify web components use their own
  // event shape that doesn't line up with controlled React inputs. The
  // filter bar is interaction-critical (instant feedback), so native
  // controls are the right trade-off here.
  const selectStyle: React.CSSProperties = {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--p-color-border, #d0d0d0)",
    background: "white",
    font: "inherit",
  };
  const inputStyle: React.CSSProperties = {
    ...selectStyle,
    width: "100%",
    boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    font: "inherit",
    fontSize: 12,
    color: "var(--p-color-text-subdued, #6d7175)",
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-end",
        flexWrap: "wrap",
      }}
    >
      <label style={{ ...labelStyle, flex: "1 1 220px", minWidth: 180 }}>
        {t("inbox.searchLabel")}
        <input
          type="search"
          placeholder={t("inbox.searchPlaceholder")}
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          style={inputStyle}
        />
      </label>
      <label style={labelStyle}>
        {t("inbox.orderLinkedLabel")}
        <select
          value={filters.orderLinked}
          onChange={(e) =>
            onChange({
              ...filters,
              orderLinked: e.target.value as InboxFilters["orderLinked"],
            })
          }
          style={selectStyle}
        >
          <option value="any">{t("inbox.filterAny")}</option>
          <option value="yes">{t("inbox.filterLinked")}</option>
          <option value="no">{t("inbox.filterNotLinked")}</option>
        </select>
      </label>
      <label style={labelStyle}>
        {t("inbox.classificationLabel")}
        <select
          value={filters.nature}
          onChange={(e) =>
            onChange({ ...filters, nature: e.target.value as NatureFilter })
          }
          style={selectStyle}
        >
          <option value="all">{t("inbox.filterAll")}</option>
          <option value="support">{t("inbox.filterSupport")}</option>
          <option value="uncertain">{t("inbox.filterUncertain")}</option>
          <option value="non_support">{t("inbox.filterNonSupport")}</option>
          <option value="filtered">{t("inbox.filterFiltered")}</option>
        </select>
      </label>
      {intentOptions.length > 0 && (
        <label style={labelStyle}>
          {t("inbox.intentLabel")}
          <select
            value={filters.intent}
            onChange={(e) => onChange({ ...filters, intent: e.target.value })}
            style={selectStyle}
          >
            <option value="">{t("inbox.filterAll")}</option>
            {intentOptions.map((intent) => (
              <option key={intent} value={intent}>
                {t(`analysis.intent_${intent}`, { defaultValue: intent })}
              </option>
            ))}
          </select>
        </label>
      )}
      {!isDefault && (
        <s-button variant="plain" onClick={onReset}>
          {t("inbox.resetFilters")}
        </s-button>
      )}
    </div>
  );
}

function PipelineStats({ emails }: { emails: SerializedEmail[] }) {
  const { t } = useTranslation();
  if (emails.length === 0) return null;
  const tier1 = emails.filter((e) => e.tier1Result?.startsWith("filtered:")).length;
  const tier2 = emails.filter((e) => e.tier1Result === "passed" && e.tier2Result).length;
  const tier3 = emails.filter((e) => e.processingStatus === "analyzed").length;

  return (
    <div className="ui-grid-4">
      <MetricCard
        label={t("inbox.totalMails")}
        value={emails.length.toLocaleString("fr-FR")}
        helper={t("inbox.totalMailsHelper")}
        icon={<MailIcon size={20} />}
        iconTone="info"
      />
      <MetricCard
        label={t("inbox.tier1")}
        value={tier1.toLocaleString("fr-FR")}
        helper={t("inbox.tier1Helper")}
        icon={<InboxIcon size={20} />}
        iconTone="neutral"
      />
      <MetricCard
        label={t("inbox.tier2")}
        value={tier2.toLocaleString("fr-FR")}
        helper={t("inbox.tier2Helper")}
        icon={<SparklesIcon size={20} />}
        iconTone="primary"
      />
      <MetricCard
        label={t("inbox.tier3")}
        value={tier3.toLocaleString("fr-FR")}
        helper={t("inbox.tier3Helper")}
        icon={<CheckCircleIcon size={20} />}
        iconTone="success"
      />
    </div>
  );
}

function MoveThreadControl({
  canonicalThreadId,
  bucket,
  previousOperationalState,
}: {
  canonicalThreadId: string;
  bucket: OpsBucket;
  previousOperationalState: string | null;
}) {
  const { t } = useTranslation();
  const isResolved = bucket === "resolved";
  const reopenTarget = previousOperationalState ?? "waiting_merchant";
  const moveFetcher = useFetcher();
  const moving = moveFetcher.state !== "idle";
  return (
    <moveFetcher.Form method="post" style={{ display: "inline" }}>
      <input type="hidden" name="_action" value="moveThread" />
      <input type="hidden" name="canonicalThreadId" value={canonicalThreadId} />
      <input type="hidden" name="target" value={isResolved ? reopenTarget : "resolved"} />
      <s-button type="submit" variant="plain" size="slim" {...(moving ? { loading: true } : {})}>
        {isResolved ? t("inbox.reopen") : t("inbox.markResolved")}
      </s-button>
    </moveFetcher.Form>
  );
}

function ThreadIdentifiersEditor({
  canonicalThreadId,
  threadState,
}: {
  canonicalThreadId: string;
  threadState: SerializedThreadState | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher();
  const submitting = fetcher.state !== "idle";
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-stack direction="inline" gap="small-300" blockAlign="center">
          <s-text variant="headingSm">{t("inbox.parsedIdentifiers")}</s-text>
          <s-button variant="plain" size="slim" onClick={() => setOpen((v) => !v)}>
            {open ? t("inbox.cancel") : t("inbox.edit")}
          </s-button>
        </s-stack>
        {!open ? (
          <s-stack direction="block" gap="small-100">
            <s-text variant="bodySm">
              <strong>{t("inbox.orderNumber")}:</strong>{" "}
              {threadState?.resolvedOrderNumber ? `#${threadState.resolvedOrderNumber}` : "—"}
            </s-text>
            <s-text variant="bodySm">
              <strong>{t("inbox.trackingNumber")}:</strong> {threadState?.resolvedTrackingNumber ?? "—"}
            </s-text>
            <s-text variant="bodySm">
              <strong>{t("inbox.customerEmail")}:</strong> {threadState?.resolvedEmail ?? "—"}
            </s-text>
            <s-text variant="bodySm">
              <strong>{t("inbox.customerName")}:</strong> {threadState?.resolvedCustomerName ?? "—"}
            </s-text>
          </s-stack>
        ) : (
          <fetcher.Form
            method="post"
            onSubmit={() => setOpen(false)}
          >
            <input type="hidden" name="_action" value="editThreadIdentifiers" />
            <input type="hidden" name="canonicalThreadId" value={canonicalThreadId} />
            <s-stack direction="block" gap="small-300">
              <s-text-field
                label={t("inbox.orderNumber")}
                name="resolvedOrderNumber"
                defaultValue={threadState?.resolvedOrderNumber ?? ""}
                placeholder="e.g. 257371239"
              />
              <s-text-field
                label={t("inbox.trackingNumber")}
                name="resolvedTrackingNumber"
                defaultValue={threadState?.resolvedTrackingNumber ?? ""}
              />
              <s-text-field
                label={t("inbox.customerEmail")}
                name="resolvedEmail"
                defaultValue={threadState?.resolvedEmail ?? ""}
              />
              <s-text-field
                label={t("inbox.customerName")}
                name="resolvedCustomerName"
                defaultValue={threadState?.resolvedCustomerName ?? ""}
              />
              <s-stack direction="inline" gap="small-300">
                <s-button type="submit" variant="primary" disabled={submitting}>
                  {submitting ? t("inbox.saving") : t("inbox.save")}
                </s-button>
                <s-button type="button" variant="plain" onClick={() => setOpen(false)}>
                  {t("inbox.cancel")}
                </s-button>
              </s-stack>
            </s-stack>
          </fetcher.Form>
        )}
      </s-stack>
    </s-box>
  );
}

function normalizeEmailBody(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]*(\n[ \t]*){2,}/g, "\n\n")
    .trimEnd();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function EmailHtmlBody({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const handleLoad = () => {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument?.body) return;
    iframe.style.height = iframe.contentDocument.body.scrollHeight + 4 + "px";
  };
  return (
    <iframe
      ref={iframeRef}
      srcDoc={html}
      sandbox="allow-popups"
      onLoad={handleLoad}
      title="Email body"
      style={{ border: "none", width: "100%", minHeight: "60px", display: "block" }}
    />
  );
}

function EmailMessageBlock({
  email,
  idx,
  total,
  connectedEmail,
}: {
  email: SerializedEmail;
  idx: number;
  total: number;
  connectedEmail: string | null;
}) {
  const { t } = useTranslation();
  const isLatest = idx === total - 1;
  const direction = getMessageDirection(email, connectedEmail);
  const body = normalizeEmailBody(email.bodyText);
  const PREVIEW_LENGTH = 300;

  const cidMap = buildCidMap(email.incomingAttachments);
  const sanitizedHtml = email.bodyHtml ? sanitizeEmailHtml(email.bodyHtml, cidMap) : null;
  const hasHtmlBody = !!sanitizedHtml;

  const needsToggle = hasHtmlBody || body.length > PREVIEW_LENGTH;
  const [expanded, setExpanded] = useState(false);

  // Auto-refresh HTML body and attachments for emails synced before this feature.
  // Fires on mount; module-level Set prevents re-fetching the same email twice per session.
  const refreshFetcher = useFetcher();
  const refreshPending = refreshFetcher.state !== "idle";
  useEffect(() => {
    if (!email.bodyHtml && !_refreshedEmailIds.has(email.id) && refreshFetcher.state === "idle") {
      _refreshedEmailIds.add(email.id);
      refreshFetcher.submit(
        { _action: "refresh_email_html", emailId: email.id },
        { method: "post" },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-expand when bodyHtml loads for the first time (transitions from empty to populated).
  const prevBodyHtmlRef = useRef(email.bodyHtml);
  useEffect(() => {
    if (email.bodyHtml && !prevBodyHtmlRef.current) {
      setExpanded(true);
    }
    prevBodyHtmlRef.current = email.bodyHtml;
  }, [email.bodyHtml]);

  const fileAttachments = email.incomingAttachments.filter((a) => a.disposition === "attachment");

  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <button
          type="button"
          onClick={() => needsToggle && setExpanded((v) => !v)}
          style={{
            all: "unset",
            display: "block",
            width: "100%",
            cursor: needsToggle ? "pointer" : "default",
          }}
        >
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>
              {email.fromName || email.fromAddress}
            </span>
            <span style={{ fontSize: "0.8125rem", color: "#6b7280" }}>
              {relativeTime(email.receivedAt, t)}
            </span>
            <span>
              <s-badge tone={direction === "outgoing" ? "neutral" : "info"}>
                {direction === "incoming" ? t("analysis.directionIncoming") : direction === "outgoing" ? t("analysis.directionOutgoing") : t("analysis.directionUnknown")}
              </s-badge>
            </span>
            {isLatest && total > 1 && <s-badge tone="info">{t("inbox.pillLatest")}</s-badge>}
            {refreshPending && (
              <span style={{ marginLeft: "auto", fontSize: "0.8125rem", color: "#6b7280" }}>⟳</span>
            )}
            {!refreshPending && needsToggle && (
              <span style={{ marginLeft: "auto", fontSize: "0.8125rem", color: "#6b7280" }}>
                {expanded ? t("inbox.collapse") : t("inbox.expand")}
              </span>
            )}
          </div>
        </button>

        {expanded ? (
          hasHtmlBody ? (
            <EmailHtmlBody html={sanitizedHtml!} />
          ) : (
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.875rem", lineHeight: "1.6" }}>
              {body}
            </div>
          )
        ) : (
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.875rem", lineHeight: "1.6" }}>
            {body.slice(0, PREVIEW_LENGTH) + (needsToggle ? "…" : "")}
          </div>
        )}

        {fileAttachments.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px" }}>
            {fileAttachments.map((att) => (
              <a
                key={att.id}
                href={`/api/incoming-attachment?id=${att.id}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "4px 10px",
                  fontSize: "12px",
                  fontWeight: 500,
                  borderRadius: "9999px",
                  border: "1px solid var(--ui-slate-200)",
                  background: "var(--ui-slate-100)",
                  color: "var(--ui-slate-700)",
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                📎 {att.fileName}
                <span style={{ color: "var(--ui-slate-400)", fontSize: "11px" }}>
                  {formatBytes(att.sizeBytes)}
                </span>
              </a>
            ))}
          </div>
        )}
      </s-stack>
    </s-box>
  );
}

function ThreadCard({
  thread,
  threadState,
  isSelected,
  connectedEmail,
  previousContact,
  onSelect,
  onOrderClick,
  onFilterClick,
  onBucketClick,
}: {
  thread: EmailThread;
  threadState: SerializedThreadState | null;
  isSelected: boolean;
  connectedEmail: string | null;
  /** Cross-thread: have we already sent an outgoing to this address/order in another thread? */
  previousContact: { byAddress: boolean; byOrder: boolean; recentReply: boolean; matchedAddress: string | null };
  onSelect: () => void;
  onOrderClick: (orderNumber: string) => void;
  onFilterClick: (patch: Partial<InboxFilters>) => void;
  onBucketClick: (bucket: OpsBucket | "to_handle") => void;
}) {
  const { t } = useTranslation();
  const { latest, emails } = thread;
  const cls = getThreadClassification(thread);
  const reason = filterReason(latest);
  const messageCount = emails.length;
  const latestDirection = getMessageDirection(latest, connectedEmail);
  const noReplyNeeded = latest.analysisResult?.conversation?.noReplyNeeded === true;
  const requiresReply = threadNeedsReply(thread, connectedEmail);
  const bucket = getOpsBucket(thread, threadState, connectedEmail);
  const reanalyzeFetcher = useFetcher();
  const isGenerating = reanalyzeFetcher.state !== "idle";
  const [showSignals, setShowSignals] = useState(false);
  const hasSignals =
    (bucket === "to_process" || bucket === "waiting_merchant" || bucket === "waiting_customer") &&
    (previousContact.recentReply || previousContact.byAddress || previousContact.byOrder);

  // The "latest" email may be a new unanalyzed follow-up (e.g. waiting_merchant
  // after a customer reply). Find the most recent email that actually has
  // an analysisResult so we can still show the LLM context and the draft.
  const analysisEmail = [...emails].reverse().find((e) => e.analysisResult) ?? null;
  // For draft display, prefer the latest email's draft (freshly generated),
  // fall back to the analysisEmail's draft if latest has none yet.
  const draftEmail = latest.draftReply ? latest : (analysisEmail?.draftReply ? analysisEmail : null);

  const borderColor =
    cls === "support" ? "success" : cls === "uncertain" ? "warning" : undefined;

  return (
    <div
      onClick={onSelect}
      className={["ui-card ui-card--compact", isSelected ? "ui-card--selected" : ""].join(" ")}
      style={{ cursor: "pointer" }}
    >
      {/* Row 1 : badges */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", marginBottom: "10px" }}>
        {cls === "uncertain" && <span className="ui-pill ui-pill--warning ui-pill--clickable" onClick={(e) => { e.stopPropagation(); onFilterClick({ nature: "uncertain" }); }}>{t("inbox.pillUncertain")}</span>}
        {cls === "filtered" && <span className="ui-pill ui-pill--clickable" onClick={(e) => { e.stopPropagation(); onFilterClick({ nature: "filtered" }); }}>{t("inbox.filterFiltered")}</span>}
        {cls === "non_support" && <span className="ui-pill ui-pill--clickable" onClick={(e) => { e.stopPropagation(); onFilterClick({ nature: "non_support" }); }}>{t("inbox.pillNonSupport")}</span>}

        {bucket === "to_process" ? (
          <span className="ui-pill ui-pill--warning ui-pill--clickable" onClick={(e) => { e.stopPropagation(); onBucketClick("to_handle"); }}>{t("inbox.stateWaitingMerchant")}</span>
        ) : bucket === "waiting_merchant" ? (
          <span className="ui-pill ui-pill--warning ui-pill--clickable" onClick={(e) => { e.stopPropagation(); onBucketClick("to_handle"); }}>{t("inbox.stateWaitingMerchant")}</span>
        ) : bucket === "waiting_customer" ? (
          <span className="ui-pill ui-pill--info ui-pill--clickable" onClick={(e) => { e.stopPropagation(); onBucketClick("waiting_customer"); }}>{t("inbox.stateWaitingCustomer")}</span>
        ) : bucket === "resolved" ? (
          <span className="ui-pill ui-pill--success ui-pill--clickable" onClick={(e) => { e.stopPropagation(); onBucketClick("resolved"); }}>{t("inbox.stateResolved")}</span>
        ) : noReplyNeeded ? (
          <span className="ui-pill ui-pill--success">{t("inbox.stateNoReplyNeeded")}</span>
        ) : null}

        {threadState?.resolvedOrderNumber && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOrderClick(threadState.resolvedOrderNumber!); }}
            style={{ background: "none", border: "none", padding: 0, margin: 0, cursor: "pointer" }}
          >
            <span className="ui-pill ui-pill--info ui-pill--clickable">#{threadState.resolvedOrderNumber}</span>
          </button>
        )}

        {(() => {
          const intent = analysisEmail?.analysisResult?.intent;
          if (!intent) return null;
          const key = `analysis.intent_${intent}` as const;
          return (
            <span
              className="ui-pill ui-pill--clickable"
              onClick={(e) => { e.stopPropagation(); onFilterClick({ intent }); }}
            >
              {t(key, { defaultValue: intent })}
            </span>
          );
        })()}
        {threadState?.historyStatus === "partial" && <span className="ui-pill ui-pill--warning">{t("inbox.pillPartialHistory")}</span>}
        {latest.processingStatus === "error" && <span className="ui-pill ui-pill--danger">{t("inbox.pillError")}</span>}

        {hasSignals && (
          <span
            style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
            onMouseEnter={(e) => { e.stopPropagation(); setShowSignals(true); }}
            onMouseLeave={() => setShowSignals(false)}
            onClick={(e) => e.stopPropagation()}
          >
            <span style={{ color: "var(--ui-amber-700)", fontSize: "14px", cursor: "help" }}>⚠</span>
            {showSignals && (
              <div style={{
                position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                background: "#fff", border: "1px solid var(--ui-slate-200)",
                borderRadius: "8px", padding: "8px 12px",
                boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
                zIndex: 10, minWidth: "210px",
                display: "flex", flexDirection: "column", gap: "4px",
                fontSize: "12px", color: "var(--ui-slate-700)", fontWeight: 400,
              }}>
                {previousContact.recentReply && <span>↩ {t("inbox.signalRepliedElsewhere")}</span>}
                {previousContact.byAddress && previousContact.byOrder && <span>◎ {t("inbox.signalPriorContactBoth")}</span>}
                {previousContact.byOrder && !previousContact.byAddress && <span>◎ {t("inbox.signalPriorContactOrder")}</span>}
                {previousContact.byAddress && !previousContact.byOrder && <span>◎ {t("inbox.signalPriorContactAddress")}</span>}
              </div>
            )}
          </span>
        )}
      </div>

      {/* Row 2 : sender + time */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px", marginBottom: "4px" }}>
        <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <span style={{ fontWeight: 600, fontSize: "0.9375rem", color: "var(--ui-slate-900)" }}>
            {latest.fromName || latest.fromAddress}
          </span>
          {latest.fromName && (
            <span style={{ fontWeight: 400, fontSize: "0.8125rem", color: "var(--ui-slate-500)", marginLeft: "6px" }}>
              {latest.fromAddress}
            </span>
          )}
        </div>
        <span style={{ flexShrink: 0, fontSize: "0.8125rem", color: "var(--ui-slate-500)" }}>
          {messageCount > 1 && `${messageCount} msg · `}
          {latestDirection === "incoming" ? "↓" : latestDirection === "outgoing" ? "↑" : "·"}{" "}
          {relativeTime(latest.receivedAt, t)}
        </span>
      </div>

      {/* Row 3 : subject */}
      <div style={{
        fontWeight: 600,
        fontSize: "0.9375rem",
        color: "var(--ui-slate-800)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        marginBottom: "4px",
      }}>
        {latest.subject}
      </div>

      {/* Row 4 : snippet (only when not selected) */}
      {!isSelected && (
        <div style={{
          fontSize: "0.8125rem",
          color: "var(--ui-slate-500)",
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          marginBottom: "10px",
        }}>
          {reason || latest.snippet.slice(0, 140)}
          {!reason && latest.snippet.length > 140 ? "…" : ""}
        </div>
      )}

      {/* Row 5 : actions (stop propagation so clicks don't re-select) */}
      <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "6px" }}>
        {latest.canonicalThreadId && (
          <MoveThreadControl
            canonicalThreadId={latest.canonicalThreadId}
            bucket={bucket}
            previousOperationalState={threadState?.previousOperationalState ?? null}
          />
        )}
        {(bucket === "to_process" || bucket === "waiting_merchant") &&
          !latest.draftReply &&
          !noReplyNeeded &&
          !latest.tier1Result?.startsWith("filtered:") &&
          latest.tier2Result !== "probable_non_client" && (
          <reanalyzeFetcher.Form method="post">
            <input type="hidden" name="_action" value="reanalyze" />
            <input type="hidden" name="emailId" value={latest.id} />
            <s-button type="submit" variant="primary" {...(isGenerating ? { loading: true } : {})}>
              {latest.processingStatus === "error" ? t("inbox.retryAnalysis") : t("inbox.generateDraft")}
            </s-button>
          </reanalyzeFetcher.Form>
        )}
      </div>

      {/* Row 6 : Draft generated */}
      {latest.draftReply && (
        <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px solid var(--ui-slate-100)" }}>
          <span className="ui-pill ui-pill--success" style={{ fontSize: "11px", padding: "2px 8px" }}>{t("inbox.pillDraftGenerated")}</span>
        </div>
      )}
    </div>
  );
}

function DraftBlock({ email, threadSenderEmail }: {
  email: SerializedEmail;
  threadSenderEmail: string;
}) {
  const { t } = useTranslation();
  const allVersions = [...email.draftHistory, email.draftReply!];
  const [versionIndex, setVersionIndex] = useState(allVersions.length - 1);
  const currentVersion = allVersions[versionIndex] ?? email.draftReply!;
  const isLatest = versionIndex === allVersions.length - 1;
  const total = allVersions.length;

  // Local editable body state (only applies to the latest version)
  const [bodyText, setBodyText] = useState(currentVersion);
  // Sync bodyText when switching versions or when a new draft arrives
  useEffect(() => { setBodyText(currentVersion); }, [currentVersion]);

  // Auto-save debounce for body text
  const bodySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveBody = (text: string) => {
    if (bodySaveTimer.current) clearTimeout(bodySaveTimer.current);
    bodySaveTimer.current = setTimeout(async () => {
      await fetch("/api/reply-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailId: email.id, draftBody: text }),
      });
    }, 800);
  };

  // Ref for the s-text-area web component (captures native input/change events)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textareaRef = useRef<any>(null);

  // Compose field state
  const [subject, setSubject] = useState(
    email.draftSubject ?? buildReplySubject(email.subject)
  );
  const [cc, setCC] = useState(email.draftCC ?? "");
  const [bcc, setBCC] = useState(email.draftBCC ?? "");
  const [showBCC, setShowBCC] = useState(!!email.draftBCC);
  const [attachments, setAttachments] = useState(email.draftAttachments);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-save debounce for metadata fields
  const metaSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveMeta = (patch: Record<string, string>) => {
    if (metaSaveTimer.current) clearTimeout(metaSaveTimer.current);
    metaSaveTimer.current = setTimeout(async () => {
      await fetch("/api/reply-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailId: email.id, ...patch }),
      });
    }, 800);
  };

  // Clear pending debounce timers on unmount
  useEffect(() => () => {
    if (metaSaveTimer.current) clearTimeout(metaSaveTimer.current);
    if (bodySaveTimer.current) clearTimeout(bodySaveTimer.current);
  }, []);

  // Attach input listener to the s-text-area web component
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const textarea = (e.target as HTMLElement).shadowRoot?.querySelector("textarea") ??
        (el.shadowRoot?.querySelector("textarea"));
      const value = textarea?.value ?? (e as InputEvent).data ?? "";
      // Fallback: read from the inner textarea if event.target is the wrapper
      const inner = el.querySelector("textarea") ?? el.shadowRoot?.querySelector("textarea");
      const text = inner?.value ?? value;
      setBodyText(text);
      saveBody(text);
    };
    el.addEventListener("input", handler);
    return () => el.removeEventListener("input", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Jump to latest version when a new draft arrives
  useEffect(() => {
    setVersionIndex(allVersions.length - 1);
  }, [allVersions.length]);

  const refineFetcher = useFetcher();
  const regenerateFetcher = useFetcher();
  const redraftFetcher = useFetcher();
  const refining = refineFetcher.state !== "idle";
  const regenerating = regenerateFetcher.state !== "idle";
  const redrafting = redraftFetcher.state !== "idle";

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("emailId", email.id);
    formData.append("file", file);
    setAttachError(null);
    const res = await fetch("/api/draft-attachment", { method: "POST", body: formData });
    if (res.ok) {
      const att = await res.json() as typeof email.draftAttachments[number];
      setAttachments((prev) => [...prev, att]);
    } else {
      const body = await res.json().catch(() => ({})) as { error?: string };
      setAttachError(body.error ?? t("inbox.uploadFailed"));
    }
    e.target.value = "";
  }

  async function handleRemoveAttachment(attId: string) {
    const res = await fetch(`/api/draft-attachment?id=${attId}`, { method: "DELETE" });
    if (res.ok) setAttachments((prev) => prev.filter((a) => a.id !== attId));
  }

  const labelStyle: React.CSSProperties = { fontSize: "12px", color: "var(--p-color-text-subdued)", minWidth: "52px" };
  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "8px" };

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">

        {/* Compose header */}
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <div style={rowStyle}>
            <span style={labelStyle}>À</span>
            <span style={{ fontSize: "13px", color: "var(--p-color-text-subdued)" }}>{threadSenderEmail}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Objet</span>
            <input
              style={{ flex: 1, border: "none", borderBottom: "1px solid var(--p-color-border)", padding: "2px 0", fontSize: "13px", background: "transparent", outline: "none" }}
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                saveMeta({ subject: e.target.value });
              }}
            />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>CC</span>
            <input
              style={{ flex: 1, border: "none", borderBottom: "1px solid var(--p-color-border)", padding: "2px 0", fontSize: "13px", background: "transparent", outline: "none" }}
              placeholder="email@exemple.com"
              value={cc}
              onChange={(e) => {
                setCC(e.target.value);
                saveMeta({ cc: e.target.value });
              }}
            />
            {!showBCC && (
              <button
                onClick={() => setShowBCC(true)}
                style={{ fontSize: "11px", color: "var(--p-color-text-subdued)", background: "none", border: "none", cursor: "pointer", whiteSpace: "nowrap" }}
              >
                + BCC
              </button>
            )}
          </div>
          {showBCC && (
            <div style={rowStyle}>
              <span style={labelStyle}>BCC</span>
              <input
                style={{ flex: 1, border: "none", borderBottom: "1px solid var(--p-color-border)", padding: "2px 0", fontSize: "13px", background: "transparent", outline: "none" }}
                placeholder="email@exemple.com"
                value={bcc}
                onChange={(e) => {
                  setBCC(e.target.value);
                  saveMeta({ bcc: e.target.value });
                }}
              />
            </div>
          )}

          {/* Attachments */}
          <div style={{ marginTop: "4px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
              {attachments.map((att) => (
                <span
                  key={att.id}
                  style={{ fontSize: "12px", background: "var(--p-color-bg-surface-secondary)", borderRadius: "4px", padding: "2px 8px", display: "flex", alignItems: "center", gap: "4px" }}
                >
                  📎 {att.fileName}
                  <button
                    onClick={() => handleRemoveAttachment(att.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--p-color-text-subdued)", padding: "0 2px", fontSize: "12px" }}
                  >
                    ×
                  </button>
                </span>
              ))}
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{ fontSize: "12px", color: "var(--p-color-text-subdued)", background: "none", border: "none", cursor: "pointer" }}
                title={t("inbox.filesKept")}
              >
                + Ajouter une PJ
              </button>
              <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleFileSelect} />
            </div>
            {attachError && (
              <p data-testid="attachment-error" style={{ fontSize: "12px", color: "var(--p-color-text-critical)", marginTop: "4px" }}>
                {attachError}
              </p>
            )}
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--p-color-border)" }} />

        {/* Draft body */}
        <s-stack direction="inline" gap="small-300" blockAlign="center">
          <s-text variant="headingSm">Draft reply</s-text>
          {total > 1 && (
            <s-stack direction="inline" gap="small-200" blockAlign="center">
              <s-button variant="plain" size="small" disabled={versionIndex === 0}
                onClick={() => setVersionIndex(Math.max(0, versionIndex - 1))}>←</s-button>
              <s-text variant="bodySm" tone="subdued">v{versionIndex + 1}/{total}{isLatest ? "" : " (old)"}</s-text>
              <s-button variant="plain" size="small" disabled={isLatest}
                onClick={() => setVersionIndex(Math.min(total - 1, versionIndex + 1))}>→</s-button>
            </s-stack>
          )}
        </s-stack>

        <s-text-area
          ref={textareaRef}
          label={isLatest ? t("inbox.editableDraft") : t("inbox.draftVersion", { n: versionIndex + 1 })}
          rows={10}
          value={isLatest ? bodyText : currentVersion}
          readOnly={!isLatest}
        />

        {isLatest && (
          <refineFetcher.Form method="post">
            <input type="hidden" name="_action" value="refine" />
            <input type="hidden" name="emailId" value={email.id} />
            <input type="hidden" name="currentDraft" value={bodyText} />
            <s-stack direction="inline" gap="small-300" blockAlign="end">
              <div style={{ flex: 1 }}>
                <s-text-field label={t("inbox.adjustDraft")} name="instructions"
                  placeholder="e.g. Be more formal, mention refund policy, shorten…" />
              </div>
              <s-button type="submit" variant="secondary" disabled={refining || regenerating}>
                {refining ? t("inbox.refining") : t("inbox.refineWithAi")}
              </s-button>
            </s-stack>
          </refineFetcher.Form>
        )}

        <div style={{ display: "flex", gap: "8px", borderTop: "1px solid var(--p-color-border)", paddingTop: "8px" }}>
          <redraftFetcher.Form method="post">
            <input type="hidden" name="_action" value="redraft" />
            <input type="hidden" name="emailId" value={email.id} />
            <s-button type="submit" variant="secondary" size="slim" disabled={redrafting || regenerating || refining}>
              {redrafting ? t("inbox.regenerating") : t("inbox.regenerateDraft")}
            </s-button>
          </redraftFetcher.Form>
          <regenerateFetcher.Form method="post">
            <input type="hidden" name="_action" value="reanalyze" />
            <input type="hidden" name="emailId" value={email.id} />
            <s-button type="submit" variant="tertiary" size="slim" disabled={regenerating || redrafting || refining}>
              {regenerating ? t("inbox.refreshing") : t("inbox.updateTracking")}
            </s-button>
          </regenerateFetcher.Form>
        </div>

      </s-stack>
    </s-box>
  );
}

function DiagnosisView({ diagnosis }: { diagnosis: DiagnosisReport }) {
  return (
    <s-stack direction="block" gap="base">
      <s-paragraph>
        <strong>Provider:</strong> {diagnosis.provider} — <strong>Mailbox:</strong> {diagnosis.connectedEmail}
      </s-paragraph>

      <s-stack direction="block" gap="small-200">
        {diagnosis.steps.map((s, i) => (
          <s-box
            key={i}
            padding="small-300"
            borderWidth="base"
            borderRadius="base"
            {...(s.ok ? {} : { borderColor: "critical" })}
          >
            <s-stack direction="inline" gap="small-300" blockAlign="center">
              <s-badge tone={s.ok ? "success" : "critical"}>{s.ok ? "OK" : "FAIL"}</s-badge>
              <s-text variant="bodySm"><strong>{s.step}:</strong> {s.detail}</s-text>
            </s-stack>
          </s-box>
        ))}
      </s-stack>

      {diagnosis.zohoFolders && diagnosis.zohoFolders.length > 0 && (
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small-200">
            <s-text variant="headingSm">Zoho folders found</s-text>
            {diagnosis.zohoFolders.map((f) => (
              <s-text key={f.folderId} variant="bodySm">
                <strong>{f.folderName}</strong> — type=<code>{f.folderType || "(empty)"}</code> id={f.folderId}
              </s-text>
            ))}
          </s-stack>
        </s-box>
      )}

      {diagnosis.sampleMessages && diagnosis.sampleMessages.length > 0 && (
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small-200">
            <s-text variant="headingSm">Sample messages (first 10)</s-text>
            {diagnosis.sampleMessages.map((m) => (
              <s-box
                key={m.id}
                padding="small-200"
                borderWidth="base"
                borderRadius="base"
                {...(m.detectedOutgoing ? { borderColor: "success" } : {})}
              >
                <s-stack direction="block" gap="small-100">
                  <s-stack direction="inline" gap="small-200" blockAlign="center">
                    <s-badge tone={m.detectedOutgoing ? "success" : "read-only"}>
                      {m.detectedOutgoing ? "OUTGOING" : "incoming"}
                    </s-badge>
                    <s-text variant="bodySm"><strong>from:</strong> {m.from}</s-text>
                  </s-stack>
                  <s-text variant="bodySm">labels: [{m.labelIds.join(", ") || "none"}]</s-text>
                  <s-text variant="bodySm" tone="subdued">{m.subject}</s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-box>
      )}
    </s-stack>
  );
}

// ---------------------------------------------------------------------------
// Thread detail panel (right side of split layout)
// ---------------------------------------------------------------------------

function ThreadDetailPanel({
  thread,
  threadState,
  connectedEmail,
  bucket,
  previousContact,
  onClose,
}: {
  thread: EmailThread;
  threadState: SerializedThreadState | null;
  connectedEmail: string | null;
  bucket: OpsBucket | "all";
  previousContact: { byAddress: boolean; byOrder: boolean; recentReply: boolean };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { latest, emails } = thread;
  const noReplyNeeded = latest.analysisResult?.conversation?.noReplyNeeded === true;
  const reanalyzeFetcher = useFetcher();
  const isGenerating = reanalyzeFetcher.state !== "idle";
  const [showThread, setShowThread] = useState(false);
  const [showSignals, setShowSignals] = useState(false);
  const hasSignals =
    (bucket === "to_process" || bucket === "waiting_merchant" || bucket === "waiting_customer") &&
    (previousContact.recentReply || previousContact.byAddress || previousContact.byOrder);

  const analysisEmail = [...emails].reverse().find((e) => e.analysisResult) ?? null;
  const draftEmail = latest.draftReply ? latest : (analysisEmail?.draftReply ? analysisEmail : null);
  const order = analysisEmail?.analysisResult?.order;
  const intent = analysisEmail?.analysisResult?.intent;

  const bucketPill =
    bucket === "to_process" ? <span className="ui-pill ui-pill--warning">{t("inbox.stateWaitingMerchant")}</span>
    : bucket === "waiting_merchant" ? <span className="ui-pill ui-pill--warning">{t("inbox.stateWaitingMerchant")}</span>
    : bucket === "waiting_customer" ? <span className="ui-pill ui-pill--info">{t("inbox.stateWaitingCustomer")}</span>
    : bucket === "resolved" ? <span className="ui-pill ui-pill--success">{t("inbox.stateResolved")}</span>
    : null;

  const sectionLabel: React.CSSProperties = {
    fontSize: "10px", fontWeight: 700, textTransform: "uppercase",
    letterSpacing: "0.07em", color: "var(--ui-slate-400)", marginBottom: "12px",
  };

  const kvLabel: React.CSSProperties = {
    margin: 0, fontSize: "10px", fontWeight: 600, color: "var(--ui-slate-400)",
    textTransform: "uppercase", letterSpacing: "0.05em",
  };
  const kvValue: React.CSSProperties = {
    margin: 0, fontSize: "0.875rem", color: "var(--ui-slate-800)", fontWeight: 500,
  };

  return (
    <div className="ui-card" style={{ padding: 0, display: "flex", flexDirection: "column" }}>

      {/* ── Sticky header ── */}
      <div style={{
        position: "sticky", top: 0, background: "#fff", zIndex: 2,
        borderBottom: "1px solid var(--ui-slate-200)",
        borderRadius: "var(--ui-radius-2xl) var(--ui-radius-2xl) 0 0",
        padding: "14px 18px 12px",
      }}>
        {/* Row 1 : badges */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "10px" }}>
          {bucketPill}
          {threadState?.resolvedOrderNumber && (
            <span className="ui-pill ui-pill--info">#{threadState.resolvedOrderNumber}</span>
          )}
          {intent && (
            <span className="ui-pill">
              {t(`analysis.intent_${intent}`, { defaultValue: intent.replace(/_/g, " ") })}
            </span>
          )}
          {hasSignals && (
            <span
              style={{ position: "relative", display: "inline-flex", alignItems: "center", marginLeft: "auto" }}
              onMouseEnter={() => setShowSignals(true)}
              onMouseLeave={() => setShowSignals(false)}
            >
              <span style={{ color: "var(--ui-amber-700)", fontSize: "14px", cursor: "help" }}>⚠</span>
              {showSignals && (
                <div style={{
                  position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                  background: "#fff", border: "1px solid var(--ui-slate-200)",
                  borderRadius: "8px", padding: "8px 12px",
                  boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
                  zIndex: 10, minWidth: "210px",
                  display: "flex", flexDirection: "column", gap: "4px",
                  fontSize: "12px", color: "var(--ui-slate-700)", fontWeight: 400,
                }}>
                  {previousContact.recentReply && <span>↩ {t("inbox.signalRepliedElsewhere")}</span>}
                  {previousContact.byAddress && previousContact.byOrder && <span>◎ {t("inbox.signalPriorContactBoth")}</span>}
                  {previousContact.byOrder && !previousContact.byAddress && <span>◎ {t("inbox.signalPriorContactOrder")}</span>}
                  {previousContact.byAddress && !previousContact.byOrder && <span>◎ {t("inbox.signalPriorContactAddress")}</span>}
                </div>
              )}
            </span>
          )}
        </div>

        {/* Row 2 : sender + collapse button */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", marginBottom: "4px" }}>
          <div style={{ minWidth: 0, overflow: "hidden" }}>
            <span style={{ fontWeight: 700, fontSize: "0.9375rem", color: "var(--ui-slate-900)" }}>
              {latest.fromName || latest.fromAddress}
            </span>
            {latest.fromName && (
              <span style={{ fontWeight: 400, fontSize: "0.8125rem", color: "var(--ui-slate-500)", marginLeft: "8px" }}>
                {latest.fromAddress}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              flexShrink: 0, background: "none",
              border: "1px solid var(--ui-slate-200)", borderRadius: "6px",
              padding: "3px 10px", fontSize: "0.8125rem",
              color: "var(--ui-slate-600)", cursor: "pointer",
              display: "flex", alignItems: "center", gap: "4px", whiteSpace: "nowrap",
            }}
          >
            {t("inbox.collapse")}
          </button>
        </div>

        {/* Row 3 : subject */}
        <div style={{
          fontSize: "0.875rem", fontWeight: 600, color: "var(--ui-slate-700)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          marginBottom: "12px",
        }}>
          {latest.subject}
        </div>

        {/* Row 4 : action buttons */}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {latest.canonicalThreadId && bucket !== "all" && (
            <MoveThreadControl
              canonicalThreadId={latest.canonicalThreadId}
              bucket={bucket}
              previousOperationalState={threadState?.previousOperationalState ?? null}
            />
          )}
          {!noReplyNeeded &&
            !latest.tier1Result?.startsWith("filtered:") &&
            latest.tier2Result !== "probable_non_client" && (
            <reanalyzeFetcher.Form method="post">
              <input type="hidden" name="_action" value="reanalyze" />
              <input type="hidden" name="emailId" value={latest.id} />
              <s-button type="submit" variant="primary" {...(isGenerating ? { loading: true } : {})}>
                {latest.draftReply ? t("inbox.regenerateDraft") : latest.processingStatus === "error" ? t("inbox.retryAnalysis") : t("inbox.generateDraft")}
              </s-button>
            </reanalyzeFetcher.Form>
          )}
          {isGenerating && <span style={{ fontSize: "0.8125rem", color: "var(--ui-slate-500)", alignSelf: "center" }}>{t("inbox.generating")}</span>}
        </div>
      </div>

      {/* ── Latest message ── */}
      <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--ui-slate-100)" }}>
        <div style={sectionLabel}>{t("inbox.sectionLatestMessage")}</div>
        <EmailMessageBlock
          email={latest}
          idx={emails.length - 1}
          total={emails.length}
          connectedEmail={connectedEmail}
        />
      </div>

      {/* ── 2-column body : order context | draft ── */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(160px, 220px) minmax(0, 1fr)",
        borderBottom: "1px solid var(--ui-slate-100)",
      }}>
        {/* Left : order context */}
        <div style={{ padding: "16px 18px", borderRight: "1px solid var(--ui-slate-100)" }}>
          <div style={sectionLabel}>{t("inbox.sectionOrderContext")}</div>
          {order ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {([
                [t("inbox.orderCustomer"), order.customerName ?? "—"],
                [t("inbox.orderName"),    order.name],
                [t("inbox.orderItems"),    `${order.lineItems.length} item${order.lineItems.length !== 1 ? "s" : ""}`],
                [t("inbox.orderStatus"),   order.displayFulfillmentStatus ?? "—"],
              ] as [string, string][]).map(([label, value]) => (
                <div key={label}>
                  <div style={kvLabel}>{label}</div>
                  <div style={kvValue}>{value}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: "0.8125rem", color: "var(--ui-slate-400)", fontStyle: "italic" }}>
              {t("inbox.noOrderFound")}
            </div>
          )}
        </div>

        {/* Right : draft */}
        <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <div>
            <div style={sectionLabel}>{t("inbox.sectionSuggestedDraft")}</div>
            {draftEmail && !noReplyNeeded ? (
              <DraftBlock email={draftEmail} threadSenderEmail={latest.fromAddress} />
            ) : noReplyNeeded ? (
              <div style={{ fontSize: "0.8125rem", color: "var(--ui-slate-500)", fontStyle: "italic" }}>
                {t("inbox.noReplyNeededMsg")}
              </div>
            ) : (
              <div style={{ fontSize: "0.8125rem", color: "var(--ui-slate-500)", fontStyle: "italic" }}>
                {t("inbox.noDraftYet")}
              </div>
            )}
          </div>

          {/* Analysis — below draft, in the right column */}
          {analysisEmail?.analysisResult && (
            <div>
              <div style={{ ...sectionLabel, display: "flex", gap: "8px", alignItems: "center", marginBottom: "14px" }}>
                {t("inbox.sectionAnalysis")}
                {analysisEmail !== latest && (
                  <span className="ui-pill ui-pill--warning" style={{ fontSize: "10px" }}>{t("inbox.pillBasedOnPrevious")}</span>
                )}
              </div>
              <AnalysisDisplay analysis={analysisEmail.analysisResult} />
            </div>
          )}
        </div>
      </div>

      {/* ── Thread complet (repliable) ── */}
      <div>
        <button
          type="button"
          onClick={() => setShowThread((v) => !v)}
          style={{
            width: "100%", background: "none", border: "none",
            padding: "10px 18px", display: "flex", alignItems: "center", gap: "8px",
            fontSize: "0.8125rem", fontWeight: 600, color: "var(--ui-slate-500)",
            cursor: "pointer", textAlign: "left",
          }}
        >
          <span>{showThread ? "▲" : "▼"}</span>
          {t("inbox.sectionThread", { count: emails.length })}
        </button>

        {showThread && (
          <div style={{ padding: "0 18px 20px", display: "flex", flexDirection: "column", gap: "12px" }}>
            {emails.map((email, idx) => (
              <EmailMessageBlock
                key={email.id}
                email={email}
                idx={idx}
                total={emails.length}
                connectedEmail={connectedEmail}
              />
            ))}

            {latest.canonicalThreadId && (
              <ThreadIdentifiersEditor
                canonicalThreadId={latest.canonicalThreadId}
                threadState={threadState}
              />
            )}

            {latest.errorMessage && (
              <s-banner tone="critical">{latest.errorMessage}</s-banner>
            )}

            {(latest.tier2Result === "incertain" || latest.tier2Result === "probable_non_client") && (
              <Form method="post">
                <input type="hidden" name="_action" value="reanalyze" />
                <input type="hidden" name="emailId" value={latest.id} />
                <s-button type="submit">Analyze as support email</s-button>
              </Form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InboxPage() {
  const { t } = useTranslation();
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isSyncing =
    navigation.state === "submitting" &&
    (navigation.formData?.get("_action") === "sync" ||
      navigation.formData?.get("_action") === "resync" ||
      navigation.formData?.get("_action") === "backfill");

  const syncCompleted = (actionData as { syncCompleted?: boolean } | null)?.syncCompleted === true;
  const syncStopped = (actionData as { stopped?: boolean } | null)?.stopped === true;
  // bgSyncActive: either the loader detected an active job in DB, or the user just
  // triggered one (syncStarted from action). Cleared only when loader revalidates with
  // no active job.
  const syncStarted = (actionData as { syncStarted?: boolean } | null)?.syncStarted === true;
  const bgSyncActive = loaderData.syncInProgress || syncStarted;

  // Passive revalidation — picks up emails ingested by the background auto-sync loop.
  // Poll every 10s while a heavy job is running, otherwise every 60s.
  useEffect(() => {
    const interval = bgSyncActive ? 10_000 : 60_000;
    const poll = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, interval);
    return () => clearInterval(poll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgSyncActive]);

  const [activeBucket, setActiveBucket] = useState<OpsBucket | "all" | "to_handle">("to_handle");
  const [filters, setFilters] = useState<InboxFilters>({
    search: "",
    orderLinked: "any",
    nature: "all",
    intent: "",
  });
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);

  const emails: SerializedEmail[] =
    (actionData as { emails?: SerializedEmail[] })?.emails ?? loaderData.emails;

  const reanalyzed = actionData?.reanalyzed;
  const refined = (actionData as { refined?: { emailId: string; newDraft: string; draftHistory?: string[] } | null })?.refined;
  const displayEmails = emails.map((e) => {
    if (reanalyzed && e.id === reanalyzed.emailId) {
      return {
        ...e,
        processingStatus: "analyzed",
        tier2Result: "support_client",
        analysisResult: reanalyzed.analysis as SupportAnalysisExtended,
        draftReply: reanalyzed.analysis?.draftReply ?? e.draftReply,
      };
    }
    if (refined && e.id === refined.emailId) {
      return { ...e, draftReply: refined.newDraft, draftHistory: refined.draftHistory ?? e.draftHistory };
    }
    return e;
  });

  const threads = groupByThread(displayEmails);

  // Precompute each thread's bucket + classification once for reuse in
  // counts and filtering. Cheaper than calling the helpers repeatedly.
  const threadMeta = threads.map((t) => {
    const state =
      (t.latest.canonicalThreadId &&
        loaderData.threadStates?.[t.latest.canonicalThreadId]) ||
      null;
    const pc = (t.latest.canonicalThreadId && loaderData.priorContact?.[t.latest.canonicalThreadId]) || null;
    return {
      thread: t,
      state,
      bucket: getOpsBucket(t, state, loaderData.connectedEmail),
      nature: getThreadClassification(t),
      linkedOrder: hasLinkedOrder(state),
      previousContact: {
        byAddress: pc?.byAddress ?? false,
        byOrder: pc?.byOrder ?? false,
        recentReply: (pc as { recentReply?: boolean } | null)?.recentReply ?? false,
        matchedAddress: (pc as { matchedAddress?: string | null } | null)?.matchedAddress ?? null,
      },
    };
  });

  const bucketCounts: Record<OpsBucket | "all" | "to_handle", number> = {
    all: threadMeta.length,
    to_handle: threadMeta.filter((m) => m.bucket === "to_process" || m.bucket === "waiting_merchant").length,
    to_process: threadMeta.filter((m) => m.bucket === "to_process").length,
    waiting_customer: threadMeta.filter((m) => m.bucket === "waiting_customer").length,
    waiting_merchant: threadMeta.filter((m) => m.bucket === "waiting_merchant").length,
    resolved: threadMeta.filter((m) => m.bucket === "resolved").length,
    other: threadMeta.filter((m) => m.bucket === "other").length,
  };

  // Selected thread for the right-side detail panel (searched across ALL threads,
  // not just filtered, so the panel stays open when filters change).
  const selectedThreadMeta = expandedThreadId
    ? threadMeta.find((m) => m.thread.threadId === expandedThreadId) ?? null
    : null;

  const matchesFilters = (m: (typeof threadMeta)[number]): boolean => {
    if (filters.intent !== "") {
      const threadIntent = [...m.thread.emails].reverse().find(e => e.analysisResult)?.analysisResult?.intent;
      if (threadIntent !== filters.intent) return false;
    }
    if (filters.orderLinked === "yes" && !m.linkedOrder) return false;
    if (filters.orderLinked === "no" && m.linkedOrder) return false;
    if (filters.nature !== "all" && m.nature !== filters.nature) return false;
    if (filters.search.trim()) {
      const q = filters.search.trim().toLowerCase();
      const e = m.thread.latest;
      const orderNum = m.state?.resolvedOrderNumber ?? "";
      const hay = `${e.subject} ${e.fromName} ${e.fromAddress} ${e.snippet} ${orderNum}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };

  const availableIntents = [...new Set(
    threadMeta.flatMap((m) => {
      const intent = [...m.thread.emails].reverse().find(e => e.analysisResult)?.analysisResult?.intent;
      return intent ? [intent] : [];
    })
  )].sort();

  const filteredThreadMeta = threadMeta
    .filter((m) =>
      activeBucket === "all" ||
      (activeBucket === "to_handle" ? m.bucket === "to_process" || m.bucket === "waiting_merchant" : m.bucket === activeBucket)
    )
    .filter(matchesFilters);

  const report = actionData?.report as ProcessingReport | null;

  if (actionData?.disconnected) {
    return (
      <div className="ui-inbox-root">
        <div className="ui-inbox-heading"><h1>Email inbox</h1></div>
        <s-section>
          <s-banner tone="success">
            Email disconnected. Refresh the page to reconnect.
          </s-banner>
        </s-section>
      </div>
    );
  }

  return (
    <div className="ui-inbox-root">
      <div className="ui-inbox-heading"><h1>Email inbox</h1></div>

      {/* Connection */}
      <div className="ui-inbox-section">
        <ConnectionCard
          connected={loaderData.connected}
          provider={loaderData.provider}
          connectedEmail={loaderData.connectedEmail}
          lastSyncAt={loaderData.lastSyncAt}
          gmailAuthUrl={loaderData.gmailAuthUrl}
          zohoAuthUrl={loaderData.zohoAuthUrl}
          isSyncing={isSyncing}
          autoSyncEnabled={loaderData.autoSyncEnabled}
          autoSyncIntervalMinutes={loaderData.autoSyncIntervalMinutes}
        />
      </div>

      {/* Sync in progress banner */}
      {bgSyncActive && (
        <div className="ui-inbox-section">
          <s-banner tone="info">
            <s-stack direction="block" gap="small-200">
              <s-text>Synchronisation en cours…</s-text>
              <s-text>Le traitement des emails et la mise à jour des badges peuvent prendre quelques minutes. La page se rafraîchit automatiquement toutes les 60 secondes.</s-text>
            </s-stack>
          </s-banner>
        </div>
      )}

      {/* Sync error */}
      {loaderData.lastSyncError && !bgSyncActive && (
        <div className="ui-inbox-section">
          <s-banner tone="critical">
            <s-stack direction="block" gap="small-200">
              <s-text variant="headingSm">Erreur de synchronisation</s-text>
              <s-text variant="bodySm">{loaderData.lastSyncError}</s-text>
            </s-stack>
          </s-banner>
        </div>
      )}

      {/* Diagnosis report */}
      {(actionData as { diagnosis?: DiagnosisReport })?.diagnosis && (
        <div className="ui-inbox-section">
          <p style={{ fontWeight: 600, marginBottom: 8 }}>Diagnosis</p>
          <DiagnosisView diagnosis={(actionData as { diagnosis: DiagnosisReport }).diagnosis} />
        </div>
      )}

      {/* Sync cancelled */}
      {syncStopped && (
        <div className="ui-inbox-section">
          <s-banner tone="warning">Sync annulé.</s-banner>
        </div>
      )}

      {/* Sync report */}
      {report && (
        <div className="ui-inbox-section">
          <s-banner tone="success">
            {t("inbox.syncReport", {
              total: report.total,
              support: report.supportClient,
              uncertain: report.uncertain,
              filtered: report.filtered + report.nonClient,
              errors: report.errors > 0 ? t("inbox.syncErrors", { n: report.errors }) : t("inbox.syncNoErrors"),
            })}
          </s-banner>
        </div>
      )}

      {/* Email list */}
      {loaderData.connected && (
        <>
          {/* Pipeline stats — KPI tiles */}
          <div className="ui-inbox-section">
            <PipelineStats emails={displayEmails} />
          </div>

          <div className="ui-inbox-section">
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {/* Primary tabs */}
              <SegmentedTabs
                tabs={[
                  { key: "to_handle", label: t("inbox.bucketToHandle"), count: bucketCounts.to_handle },
                  { key: "waiting_customer", label: t("inbox.bucketWaitingCustomer"), count: bucketCounts.waiting_customer },
                  { key: "resolved", label: t("inbox.bucketResolved"), count: bucketCounts.resolved },
                  { key: "other", label: t("inbox.bucketOther"), count: bucketCounts.other },
                  { key: "all", label: t("inbox.bucketAll"), count: bucketCounts.all },
                ]}
                active={activeBucket}
                onChange={(k) => setActiveBucket(k)}
              />

              {/* Secondary filters */}
              <FiltersBar
                filters={filters}
                onChange={setFilters}
                intentOptions={availableIntents}
                onReset={() =>
                  setFilters({
                    search: "",
                    orderLinked: "any",
                    nature: "all",
                    intent: "",
                  })
                }
              />

              {/* Thread list + detail split */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: selectedThreadMeta ? "minmax(0, 1fr) minmax(0, 2fr)" : "1fr",
                  gap: "16px",
                  alignItems: "start",
                }}
              >
                {/* Left: compact thread list */}
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {filteredThreadMeta.length === 0 && (
                    <s-box padding="large-500" background="subdued" borderRadius="base">
                      <s-paragraph>{t("inbox.noEmailsMatch")}</s-paragraph>
                    </s-box>
                  )}
                  {filteredThreadMeta.map(({ thread, state, previousContact }) => (
                    <ThreadCard
                      key={thread.threadId}
                      thread={thread}
                      threadState={state}
                      isSelected={expandedThreadId === thread.threadId}
                      connectedEmail={loaderData.connectedEmail}
                      previousContact={previousContact}
                      onSelect={() =>
                        setExpandedThreadId(
                          expandedThreadId === thread.threadId ? null : thread.threadId,
                        )
                      }
                      onOrderClick={(orderNumber) =>
                        setFilters((prev) => ({ ...prev, search: orderNumber }))
                      }
                      onFilterClick={(patch) =>
                        setFilters((prev) => ({ ...prev, ...patch }))
                      }
                      onBucketClick={(bucket) => setActiveBucket(bucket)}
                    />
                  ))}
                </div>

                {/* Right: thread detail panel (sticky) */}
                {selectedThreadMeta && (
                  <div style={{ position: "sticky", top: "16px", maxHeight: "calc(100vh - 120px)", overflowY: "auto", borderRadius: "var(--ui-radius-2xl)" }}>
                    <ThreadDetailPanel
                      thread={selectedThreadMeta.thread}
                      threadState={selectedThreadMeta.state}
                      connectedEmail={loaderData.connectedEmail}
                      bucket={selectedThreadMeta.bucket}
                      previousContact={selectedThreadMeta.previousContact}
                      onClose={() => setExpandedThreadId(null)}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
