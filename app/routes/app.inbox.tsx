import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useFetcher, useLoaderData, useNavigation, useRevalidator } from "react-router";

import { authenticate } from "../shopify.server";
import { getAuthUrl as getGmailAuthUrl, getConnection, deleteConnection } from "../lib/gmail/auth";
import { getZohoAuthUrl } from "../lib/zoho/auth";
import { reanalyzeEmail, redraftEmail, processNewEmails, type ProcessingReport } from "../lib/gmail/pipeline";
import { refineDraft } from "../lib/gmail/refine-draft";
import { runDiagnosis, type DiagnosisReport } from "../lib/gmail/diagnose";
import { enqueueJob } from "../lib/mail/job-queue";
import { AnalysisDisplay } from "../components/SupportAnalysisDisplay";
import type { SupportAnalysisExtended } from "../lib/support/orchestrator";
import type { MailProvider } from "../lib/mail/types";
import { decodeHtmlEntities } from "../lib/gmail/client";
import prisma from "../db.server";

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
      kind: { in: ["resync", "backfill", "recompute"] },
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

  if (intent === "sync") {
    // Run inline — incremental sync with cursor is fast (seconds, not minutes).
    // enqueueJob is reserved for heavy backfill/resync operations.
    const report = await processNewEmails(session.shop, admin.graphql);
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
  receivedAt: Date;
  tier1Result: string | null;
  tier2Result: string | null;
  isKnownCustomer: boolean;
  processingStatus: string;
  analysisResult: string | null;
  draftReply: string | null;
  draftHistory: string;
  errorMessage: string | null;
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

function getThreadConfidence(thread: EmailThread): "high" | "medium" | "low" | null {
  const c = thread.latest.analysisResult?.confidence;
  if (c === "high" || c === "medium" || c === "low") return c;
  return null;
}

function hasLinkedOrder(state: SerializedThreadState | null): boolean {
  return !!state?.resolvedOrderNumber;
}

function filterReason(email: SerializedEmail): string | null {
  if (!email.tier1Result?.startsWith("filtered:")) return null;
  return email.tier1Result.replace("filtered:", "");
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
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
  const [showAdvanced, setShowAdvanced] = useState(false);

  if (!connected) {
    return (
      <s-box padding="large-500" borderWidth="base" borderRadius="large-200" background="subdued">
        <s-stack direction="block" gap="base" align="center">
          <s-heading>Connect your email</s-heading>
          <s-paragraph>
            Automatically scan your inbox for customer support emails, classify them, and generate draft replies.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            {gmailAuthUrl && (
              <s-link href={gmailAuthUrl}>
                <s-button variant="primary">Connect Gmail</s-button>
              </s-link>
            )}
            {zohoAuthUrl && (
              <s-link href={zohoAuthUrl}>
                <s-button variant="secondary">Connect Zoho Mail</s-button>
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
              Last sync: {relativeTime(lastSyncAt)}
              {" · "}
              Auto-sync: {autoSyncEnabled ? `every ${autoSyncIntervalMinutes}m` : "off"}
            </s-text>
          )}
        </s-stack>

        {/* Primary actions: what a merchant uses day-to-day. */}
        <s-stack direction="inline" gap="small-300">
          <Form method="post">
            <input type="hidden" name="_action" value="sync" />
            <s-button variant="primary" type="submit" {...(isSyncing ? { loading: true } : {})}>
              {isSyncing ? "Syncing…" : "Sync now"}
            </s-button>
          </Form>
          <Form method="post">
            <input type="hidden" name="_action" value="toggleAutoSync" />
            <input type="hidden" name="enable" value={autoSyncEnabled ? "0" : "1"} />
            <s-button variant="tertiary" type="submit">
              {autoSyncEnabled ? "Pause auto-sync" : "Resume auto-sync"}
            </s-button>
          </Form>
          <s-button variant="plain" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? "Hide advanced" : "Advanced"}
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
                Backfill 60 days
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="_action" value="resync" />
              <s-button variant="tertiary" type="submit" {...(isSyncing ? { loading: true } : {})}>
                Re-sync all
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="_action" value="diagnose" />
              <s-button variant="tertiary" type="submit">
                Diagnose
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="_action" value="disconnect" />
              <s-button tone="critical" variant="plain" type="submit">
                Disconnect
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
  confidence: "all" | "high" | "medium" | "low";
  orderLinked: "any" | "yes" | "no";
  nature: NatureFilter;
}

function FiltersBar({
  filters,
  onChange,
  onReset,
}: {
  filters: InboxFilters;
  onChange: (next: InboxFilters) => void;
  onReset: () => void;
}) {
  const isDefault =
    filters.search === "" &&
    filters.confidence === "all" &&
    filters.orderLinked === "any" &&
    filters.nature === "all";

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
        Search
        <input
          type="search"
          placeholder="Subject, sender, snippet…"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          style={inputStyle}
        />
      </label>
      <label style={labelStyle}>
        Confidence
        <select
          value={filters.confidence}
          onChange={(e) =>
            onChange({
              ...filters,
              confidence: e.target.value as InboxFilters["confidence"],
            })
          }
          style={selectStyle}
        >
          <option value="all">All</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </label>
      <label style={labelStyle}>
        Order linked
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
          <option value="any">Any</option>
          <option value="yes">Linked</option>
          <option value="no">Not linked</option>
        </select>
      </label>
      <label style={labelStyle}>
        Classification
        <select
          value={filters.nature}
          onChange={(e) =>
            onChange({ ...filters, nature: e.target.value as NatureFilter })
          }
          style={selectStyle}
        >
          <option value="all">All</option>
          <option value="support">Support</option>
          <option value="uncertain">Uncertain</option>
          <option value="non_support">Non-support</option>
          <option value="filtered">Filtered (Tier 1)</option>
        </select>
      </label>
      {!isDefault && (
        <s-button variant="plain" onClick={onReset}>
          Reset
        </s-button>
      )}
    </div>
  );
}

function PipelineStats({ emails }: { emails: SerializedEmail[] }) {
  if (emails.length === 0) return null;
  const tier1 = emails.filter((e) => e.tier1Result?.startsWith("filtered:")).length;
  const tier2 = emails.filter((e) => e.tier1Result === "passed" && e.tier2Result).length;
  const tier3 = emails.filter((e) => e.processingStatus === "analyzed").length;

  return (
    <s-stack direction="inline" gap="large-500">
      <s-stack direction="block" gap="small-100" align="center">
        <s-text variant="headingLg">{tier1}</s-text>
        <s-text variant="bodySm" tone="subdued">Tier 1 (free)</s-text>
      </s-stack>
      <s-stack direction="block" gap="small-100" align="center">
        <s-text variant="headingLg">{tier2}</s-text>
        <s-text variant="bodySm" tone="subdued">Tier 2 (LLM)</s-text>
      </s-stack>
      <s-stack direction="block" gap="small-100" align="center">
        <s-text variant="headingLg">{tier3}</s-text>
        <s-text variant="bodySm" tone="subdued">Tier 3 (full)</s-text>
      </s-stack>
      <s-stack direction="block" gap="small-100" align="center">
        <s-text variant="headingLg">{emails.length}</s-text>
        <s-text variant="bodySm" tone="subdued">Total</s-text>
      </s-stack>
    </s-stack>
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
        {isResolved ? "Reopen" : "Mark as resolved"}
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
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher();
  const submitting = fetcher.state !== "idle";
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-stack direction="inline" gap="small-300" blockAlign="center">
          <s-text variant="headingSm">Parsed identifiers</s-text>
          <s-button variant="plain" size="slim" onClick={() => setOpen((v) => !v)}>
            {open ? "Cancel" : "Edit"}
          </s-button>
        </s-stack>
        {!open ? (
          <s-stack direction="block" gap="small-100">
            <s-text variant="bodySm">
              <strong>Order:</strong>{" "}
              {threadState?.resolvedOrderNumber ? `#${threadState.resolvedOrderNumber}` : "—"}
            </s-text>
            <s-text variant="bodySm">
              <strong>Tracking:</strong> {threadState?.resolvedTrackingNumber ?? "—"}
            </s-text>
            <s-text variant="bodySm">
              <strong>Customer email:</strong> {threadState?.resolvedEmail ?? "—"}
            </s-text>
            <s-text variant="bodySm">
              <strong>Customer name:</strong> {threadState?.resolvedCustomerName ?? "—"}
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
                label="Order number"
                name="resolvedOrderNumber"
                defaultValue={threadState?.resolvedOrderNumber ?? ""}
                placeholder="e.g. 257371239"
              />
              <s-text-field
                label="Tracking number"
                name="resolvedTrackingNumber"
                defaultValue={threadState?.resolvedTrackingNumber ?? ""}
              />
              <s-text-field
                label="Customer email"
                name="resolvedEmail"
                defaultValue={threadState?.resolvedEmail ?? ""}
              />
              <s-text-field
                label="Customer name"
                name="resolvedCustomerName"
                defaultValue={threadState?.resolvedCustomerName ?? ""}
              />
              <s-stack direction="inline" gap="small-300">
                <s-button type="submit" variant="primary" disabled={submitting}>
                  {submitting ? "Saving…" : "Save"}
                </s-button>
                <s-button type="button" variant="plain" onClick={() => setOpen(false)}>
                  Cancel
                </s-button>
              </s-stack>
            </s-stack>
          </fetcher.Form>
        )}
      </s-stack>
    </s-box>
  );
}

function ThreadCard({
  thread,
  threadState,
  isExpanded,
  connectedEmail,
  previousContact,
  onToggle,
  onOrderClick,
}: {
  thread: EmailThread;
  threadState: SerializedThreadState | null;
  isExpanded: boolean;
  connectedEmail: string | null;
  /** Cross-thread: have we already sent an outgoing to this address/order in another thread? */
  previousContact: { byAddress: boolean; byOrder: boolean; recentReply: boolean; matchedAddress: string | null };
  onToggle: () => void;
  onOrderClick: (orderNumber: string) => void;
}) {
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
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      {...(borderColor ? { borderColor } : {})}
    >
      <s-stack direction="block" gap="small-300">
        {/* Row 1: badges — concis */}
        <s-stack direction="inline" gap="small-200">
          {/* Classification — uniquement quand non déduit de la bordure */}
          {cls === "uncertain" && <s-badge tone="warning">Uncertain</s-badge>}
          {cls === "filtered" && <s-badge tone="read-only">Filtered</s-badge>}
          {cls === "non_support" && <s-badge tone="read-only">Non-support</s-badge>}

          {/* État actionnable — un seul badge, par priorité décroissante */}
          {bucket === "to_process" ? (
            <s-badge tone="critical">To review</s-badge>
          ) : bucket === "waiting_merchant" ? (
            <s-badge tone="critical">Waiting merchant</s-badge>
          ) : bucket === "waiting_customer" ? (
            <s-badge tone="info">Waiting customer</s-badge>
          ) : bucket === "resolved" ? (
            <s-badge tone="success">Resolved</s-badge>
          ) : noReplyNeeded ? (
            <s-badge tone="success">No reply needed</s-badge>
          ) : null}

          {/* Numéro de commande — clickable to filter the search bar */}
          {threadState?.resolvedOrderNumber && (
            <button
              type="button"
              onClick={() => onOrderClick(threadState.resolvedOrderNumber!)}
              title="Filter by this order number"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                margin: 0,
                cursor: "pointer",
                font: "inherit",
              }}
            >
              <s-badge tone="info">#{threadState.resolvedOrderNumber}</s-badge>
            </button>
          )}

          {/* Nombre de messages */}
          {messageCount > 1 && <s-badge>{messageCount} msg</s-badge>}

          {/* Alertes secondaires */}
          {threadState?.historyStatus === "partial" && (
            <s-badge tone="warning">Partial history</s-badge>
          )}
          {latest.processingStatus === "error" && <s-badge tone="critical">Error</s-badge>}

          {/* Cross-thread: prior contact indicator — shown on actionable buckets
               only (to_process / waiting_merchant / waiting_customer). Excluded
               on "resolved" (already handled) and "other" (pure notification
               threads like billing / Trustpilot). This keeps legitimate customer
               messages forwarded via mailer@shopify.com covered. */}
          {(bucket === "to_process" || bucket === "waiting_merchant" || bucket === "waiting_customer") && (previousContact.byAddress || previousContact.byOrder) && (
            <s-badge tone="warning" title={
              previousContact.byAddress && previousContact.matchedAddress
                ? `Known sender: ${previousContact.matchedAddress}`
                : undefined
            }>
              {previousContact.byOrder && previousContact.byAddress
                ? "Prior contact (address + order)"
                : previousContact.byOrder
                ? "Prior contact (same order)"
                : "Prior contact (same address)"}
            </s-badge>
          )}
          {/* Another thread has replied to this contact AFTER the latest incoming
               of this thread. Same scoping as above. */}
          {(bucket === "to_process" || bucket === "waiting_merchant" || bucket === "waiting_customer") && previousContact.recentReply && (
            <s-badge tone="warning">Replied elsewhere recently</s-badge>
          )}
        </s-stack>

        {/* Row 2: expéditeur + direction + heure */}
        <s-stack direction="inline" gap="small-300" blockAlign="center">
          <s-paragraph>
            <strong>{latest.fromName || latest.fromAddress}</strong>
            {latest.fromName && (
              <s-text tone="subdued"> {latest.fromAddress}</s-text>
            )}
          </s-paragraph>
          <s-text variant="bodySm" tone="subdued">
            {latestDirection === "incoming" ? "↓" : latestDirection === "outgoing" ? "↑" : "·"}{" "}
            {relativeTime(latest.receivedAt)}
          </s-text>
        </s-stack>

        {/* Row 3: subject + snippet */}
        <s-paragraph>
          <strong>{latest.subject}</strong>
        </s-paragraph>
        {!isExpanded && (
          <s-text variant="bodySm" tone="subdued">
            {latest.snippet.slice(0, 120)}{latest.snippet.length > 120 ? "…" : ""}
          </s-text>
        )}

        {reason && !isExpanded && (
          <s-text variant="bodySm" tone="subdued">
            {reason}
          </s-text>
        )}

        <s-stack direction="inline" gap="small-300" blockAlign="center">
          <s-button variant="plain" onClick={onToggle}>
            {isExpanded ? "Collapse" : "Details"}
          </s-button>
          {latest.canonicalThreadId && (
            <MoveThreadControl
              canonicalThreadId={latest.canonicalThreadId}
              bucket={bucket}
              previousOperationalState={threadState?.previousOperationalState ?? null}
            />
          )}
          {/* Generate draft — always visible for waiting_merchant threads without a draft */}
          {bucket === "waiting_merchant" &&
            !latest.draftReply &&
            !noReplyNeeded &&
            !latest.tier1Result?.startsWith("filtered:") &&
            latest.tier2Result !== "probable_non_client" && (
            <s-stack direction="inline" gap="small-300" blockAlign="center">
              <reanalyzeFetcher.Form method="post">
                <input type="hidden" name="_action" value="reanalyze" />
                <input type="hidden" name="emailId" value={latest.id} />
                <s-button type="submit" variant="primary" title="Once generated, the thread will move to &quot;To review&quot;" {...(isGenerating ? { loading: true } : {})}>
                  {latest.processingStatus === "error" ? "Retry analysis" : "Generate draft"}
                </s-button>
              </reanalyzeFetcher.Form>
              {isGenerating && (
                <s-text variant="bodySm" tone="subdued">Le brouillon sera disponible dans "À traiter"</s-text>
              )}
            </s-stack>
          )}
        </s-stack>

        {/* Expanded content */}
        {isExpanded && (
          <s-stack direction="block" gap="base">
            {/* Thread messages */}
            {emails.map((email, idx) => (
              <s-box key={email.id} padding="base" background="subdued" borderRadius="base">
                <s-stack direction="block" gap="small-300">
                  <s-stack direction="inline" gap="small-300" blockAlign="center">
                    <s-text variant="headingSm">
                      {email.fromName || email.fromAddress}
                    </s-text>
                    <s-text variant="bodySm" tone="subdued">
                      {relativeTime(email.receivedAt)}
                    </s-text>
                    <s-badge tone={getMessageDirection(email, connectedEmail) === "outgoing" ? "read-only" : "info"}>
                      {getMessageDirection(email, connectedEmail)}
                    </s-badge>
                    {idx === emails.length - 1 && messageCount > 1 && (
                      <s-badge tone="info">Latest</s-badge>
                    )}
                  </s-stack>
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "var(--p-font-size-300)", lineHeight: "var(--p-font-line-height-2)" }}>
                    {(() => {
                      const text = email.bodyText
                        .replace(/\r\n/g, "\n")   // normalize CRLF
                        .replace(/\r/g, "\n")     // normalize stray CR
                        .replace(/\n[ \t]*(\n[ \t]*){2,}/g, "\n\n")  // collapse blank lines
                        .trimEnd();
                      return text.length > 1500 ? text.slice(0, 1500) + "…" : text;
                    })()}
                  </div>
                </s-stack>
              </s-box>
            ))}

            {reason && (
              <s-banner tone="info">
                Filtered by: {reason}
              </s-banner>
            )}

            {/* Edit parsed identifiers — merchant can correct order/tracking/email/name */}
            {latest.canonicalThreadId && (
              <ThreadIdentifiersEditor
                canonicalThreadId={latest.canonicalThreadId}
                threadState={threadState}
              />
            )}

            {/* Analysis (from the most recently analyzed email in the thread) */}
            {analysisEmail?.analysisResult && (
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="small-300" blockAlign="center">
                    <s-text variant="headingSm">Analysis</s-text>
                    {analysisEmail !== latest && (
                      <s-badge tone="warning">Based on previous message</s-badge>
                    )}
                  </s-stack>
                  <AnalysisDisplay analysis={analysisEmail.analysisResult} />
                </s-stack>
              </s-box>
            )}

            {/* Draft (prefer latest draft, fallback to previous analyzed email's draft) */}
            {draftEmail && !noReplyNeeded && <DraftBlock email={draftEmail} />}

            {noReplyNeeded && (
              <s-banner tone="info">
                No draft generated: latest customer message appears to close the loop.
              </s-banner>
            )}

            {/* Error */}
            {latest.errorMessage && (
              <s-banner tone="critical">{latest.errorMessage}</s-banner>
            )}

            {/* Generate draft — shown when latest has no draft yet and the email is actionable */}
            {!latest.draftReply &&
              !noReplyNeeded &&
              !latest.tier1Result?.startsWith("filtered:") &&
              latest.tier2Result !== "probable_non_client" && (
              <s-stack direction="inline" gap="small-300" blockAlign="center">
                <reanalyzeFetcher.Form method="post">
                  <input type="hidden" name="_action" value="reanalyze" />
                  <input type="hidden" name="emailId" value={latest.id} />
                  <s-button type="submit" variant="primary" title="Once generated, the thread will move to &quot;To review&quot;" {...(isGenerating ? { loading: true } : {})}>
                    {latest.processingStatus === "error" ? "Retry analysis" : "Generate draft"}
                  </s-button>
                </reanalyzeFetcher.Form>
                {isGenerating && (
                  <s-text variant="bodySm" tone="subdued">Le brouillon sera disponible dans "À traiter"</s-text>
                )}
              </s-stack>
            )}

            {/* Re-analyze — shown for misclassified or uncertain emails (even if they already have a draft) */}
            {(latest.tier2Result === "incertain" ||
              latest.tier2Result === "probable_non_client") && (
              <Form method="post">
                <input type="hidden" name="_action" value="reanalyze" />
                <input type="hidden" name="emailId" value={latest.id} />
                <s-button type="submit">Analyze as support email</s-button>
              </Form>
            )}
          </s-stack>
        )}
      </s-stack>
    </s-box>
  );
}

function DraftBlock({ email }: { email: SerializedEmail }) {
  const allVersions = [...email.draftHistory, email.draftReply!];
  const [versionIndex, setVersionIndex] = useState(allVersions.length - 1);
  const currentVersion = allVersions[versionIndex] ?? email.draftReply!;
  const isLatest = versionIndex === allVersions.length - 1;
  const total = allVersions.length;

  // Jump to latest version automatically when a new draft is added (e.g. after AI refinement)
  useEffect(() => {
    setVersionIndex(allVersions.length - 1);
  }, [allVersions.length]);
  const refineFetcher = useFetcher();
  const regenerateFetcher = useFetcher();
  const redraftFetcher = useFetcher();
  const refining = refineFetcher.state !== "idle";
  const regenerating = regenerateFetcher.state !== "idle";
  const redrafting = redraftFetcher.state !== "idle";

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-300" blockAlign="center">
          <s-text variant="headingSm">Draft reply</s-text>
          {total > 1 && (
            <s-stack direction="inline" gap="small-200" blockAlign="center">
              <s-button
                variant="plain"
                size="small"
                disabled={versionIndex === 0}
                onClick={() => setVersionIndex(Math.max(0, versionIndex - 1))}
              >
                ←
              </s-button>
              <s-text variant="bodySm" tone="subdued">
                v{versionIndex + 1}/{total}{isLatest ? "" : " (old)"}
              </s-text>
              <s-button
                variant="plain"
                size="small"
                disabled={isLatest}
                onClick={() => setVersionIndex(Math.min(total - 1, versionIndex + 1))}
              >
                →
              </s-button>
            </s-stack>
          )}
        </s-stack>

        <s-text-area
          label={isLatest ? "Editable draft" : `Version ${versionIndex + 1} (read-only)`}
          rows={10}
          value={currentVersion}
          readOnly={!isLatest}
        />

        {isLatest && (
          <refineFetcher.Form method="post">
            <input type="hidden" name="_action" value="refine" />
            <input type="hidden" name="emailId" value={email.id} />
            <input type="hidden" name="currentDraft" value={currentVersion} />
            <s-stack direction="inline" gap="small-300" blockAlign="end">
              <div style={{ flex: 1 }}>
                <s-text-field
                  label="Refinement instructions"
                  name="instructions"
                  placeholder="e.g. Be more formal, mention refund policy, shorten…"
                />
              </div>
              <s-button type="submit" variant="secondary" disabled={refining || regenerating}>
                {refining ? "Refining…" : "Refine with AI"}
              </s-button>
            </s-stack>
          </refineFetcher.Form>
        )}

        {/* Regenerate draft + Refresh context — inline, separated from Refine */}
        <div style={{ display: "flex", gap: "8px", borderTop: "1px solid var(--p-color-border)", paddingTop: "8px" }}>
          <redraftFetcher.Form method="post">
            <input type="hidden" name="_action" value="redraft" />
            <input type="hidden" name="emailId" value={email.id} />
            <s-button type="submit" variant="secondary" size="slim" disabled={redrafting || regenerating || refining}>
              {redrafting ? "Regenerating…" : "Regenerate draft"}
            </s-button>
          </redraftFetcher.Form>

          <regenerateFetcher.Form method="post">
            <input type="hidden" name="_action" value="reanalyze" />
            <input type="hidden" name="emailId" value={email.id} />
            <s-button type="submit" variant="tertiary" size="slim" disabled={regenerating || redrafting || refining}>
              {regenerating ? "Refreshing…" : "Refresh context"}
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
// Page
// ---------------------------------------------------------------------------

export default function InboxPage() {
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

  const [activeBucket, setActiveBucket] = useState<OpsBucket | "all">("to_process");
  const [filters, setFilters] = useState<InboxFilters>({
    search: "",
    confidence: "all",
    orderLinked: "any",
    nature: "all",
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
      confidence: getThreadConfidence(t),
      linkedOrder: hasLinkedOrder(state),
      previousContact: pc ?? { byAddress: false, byOrder: false, recentReply: false, matchedAddress: null },
    };
  });

  const bucketCounts: Record<OpsBucket | "all", number> = {
    all: threadMeta.length,
    to_process: threadMeta.filter((m) => m.bucket === "to_process").length,
    waiting_customer: threadMeta.filter((m) => m.bucket === "waiting_customer").length,
    waiting_merchant: threadMeta.filter((m) => m.bucket === "waiting_merchant").length,
    resolved: threadMeta.filter((m) => m.bucket === "resolved").length,
    other: threadMeta.filter((m) => m.bucket === "other").length,
  };

  const matchesFilters = (m: (typeof threadMeta)[number]): boolean => {
    if (filters.confidence !== "all" && m.confidence !== filters.confidence) return false;
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

  const filteredThreadMeta = threadMeta
    .filter((m) => activeBucket === "all" || m.bucket === activeBucket)
    .filter(matchesFilters);

  const report = actionData?.report as ProcessingReport | null;

  if (actionData?.disconnected) {
    return (
      <s-page heading="Email inbox">
        <s-section>
          <s-banner tone="success">
            Email disconnected. Refresh the page to reconnect.
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Email inbox">
      {/* Connection */}
      <s-section>
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
      </s-section>

      {/* Sync in progress banner — shown when a resync/backfill job is queued or running */}
      {bgSyncActive && (
        <s-section>
          <s-banner tone="info">
            <s-stack direction="block" gap="small-200">
              <s-text>Synchronisation en cours…</s-text>
              <s-text>Le traitement des emails et la mise à jour des badges peuvent prendre quelques minutes. La page se rafraîchit automatiquement toutes les 60 secondes.</s-text>
            </s-stack>
          </s-banner>
        </s-section>
      )}

      {/* Sync error — persisted in DB, visible after page revalidation */}
      {loaderData.lastSyncError && !bgSyncActive && (
        <s-section>
          <s-banner tone="critical">
            <s-stack direction="block" gap="small-200">
              <s-text variant="headingSm">Erreur de synchronisation</s-text>
              <s-text variant="bodySm">{loaderData.lastSyncError}</s-text>
            </s-stack>
          </s-banner>
        </s-section>
      )}

      {/* Diagnosis report */}
      {(actionData as { diagnosis?: DiagnosisReport })?.diagnosis && (
        <s-section heading="Diagnosis">
          <DiagnosisView diagnosis={(actionData as { diagnosis: DiagnosisReport }).diagnosis} />
        </s-section>
      )}

      {/* Sync cancelled banner */}
      {syncStopped && (
        <s-section>
          <s-banner tone="warning">
            Sync annulé.
          </s-banner>
        </s-section>
      )}
      {report && (
        <s-section>
          <s-banner tone="info">
            Synced {report.total} emails: {report.supportClient} support, {report.uncertain} uncertain,{" "}
            {report.filtered + report.nonClient} filtered, {report.errors > 0 ? `${report.errors} errors` : "no errors"}.
          </s-banner>
        </s-section>
      )}

      {/* Email list */}
      {loaderData.connected && (
        <>
          {/* Pipeline stats */}
          <s-section heading="Pipeline overview">
            <PipelineStats emails={displayEmails} />
          </s-section>

          <s-section>
            <s-stack direction="block" gap="base">
              {/* Primary tabs: where the merchant needs to focus attention. */}
              <s-stack direction="inline" gap="small-300">
                {(
                  [
                    { key: "to_process", label: "To review" },
                    { key: "waiting_customer", label: "Waiting customer" },
                    { key: "waiting_merchant", label: "Waiting us" },
                    { key: "resolved", label: "Resolved" },
                    { key: "other", label: "Other" },
                    { key: "all", label: "All" },
                  ] as const
                ).map((tab) => (
                  <s-button
                    key={tab.key}
                    variant={activeBucket === tab.key ? "primary" : "tertiary"}
                    onClick={() => setActiveBucket(tab.key)}
                  >
                    {tab.label} ({bucketCounts[tab.key]})
                  </s-button>
                ))}
              </s-stack>

              {/* Secondary filters */}
              <FiltersBar
                filters={filters}
                onChange={setFilters}
                onReset={() =>
                  setFilters({
                    search: "",
                    confidence: "all",
                    orderLinked: "any",
                    nature: "all",
                  })
                }
              />

              {/* Thread cards */}
              <s-stack direction="block" gap="small-300">
                {filteredThreadMeta.length === 0 && (
                  <s-box padding="large-500" background="subdued" borderRadius="base">
                    <s-paragraph>No emails match the current filters.</s-paragraph>
                  </s-box>
                )}
                {filteredThreadMeta.map(({ thread, state, previousContact }) => (
                  <ThreadCard
                    key={thread.threadId}
                    thread={thread}
                    threadState={state}
                    isExpanded={expandedThreadId === thread.threadId}
                    connectedEmail={loaderData.connectedEmail}
                    previousContact={previousContact}
                    onToggle={() =>
                      setExpandedThreadId(
                        expandedThreadId === thread.threadId ? null : thread.threadId,
                      )
                    }
                    onOrderClick={(orderNumber) =>
                      setFilters((prev) => ({ ...prev, search: orderNumber }))
                    }
                  />
                ))}
              </s-stack>
            </s-stack>
          </s-section>
        </>
      )}
    </s-page>
  );
}
