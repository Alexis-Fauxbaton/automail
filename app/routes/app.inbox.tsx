import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ActionFunctionArgs, LoaderFunctionArgs, ShouldRevalidateFunctionArgs } from "react-router";
import { Form, Link, useActionData, useFetcher, useLoaderData, useNavigation, useRevalidator, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useMobile } from "../hooks/useMobile";

import { authenticate } from "../shopify.server";
import { requireOnboardingComplete } from "../lib/onboarding/guard";
import {
  hasGeneratedAnyDraft,
  hasCustomizedSupportSettings,
  getShopFlag,
  markChecklistDismissed,
} from "../lib/onboarding/repo";
import { deriveChecklistState, isChecklistDismissed } from "../lib/onboarding/state";
import { OnboardingChecklist } from "../components/onboarding/OnboardingChecklist";
import { getAuthUrl as getGmailAuthUrl } from "../lib/gmail/auth";
import { getZohoAuthUrl } from "../lib/zoho/auth";
import { getAuthUrl as getOutlookAuthUrl } from "../lib/outlook/auth";
import type { ProcessingReport } from "../lib/gmail/pipeline";
import type { DiagnosisReport } from "../lib/gmail/diagnose";
import { AnalysisDisplay, PencilButton } from "../components/SupportAnalysisDisplay";
import { ClassificationEditModal, type ClassificationEditSubmit } from "../components/ClassificationEditModal";
import type { SupportAnalysisExtended } from "../lib/support/orchestrator";
import type { MailProvider } from "../lib/mail/types";
import { decodeHtmlEntities } from "../lib/gmail/client";
import { sanitizeEmailHtml, buildCidMap } from "../lib/mail/sanitize-html";
import { buildReplySubject } from "../lib/support/draft-subject";
import {
  type OpsBucket,
  getThreadOpsBucket,
  getMessageDirection as libGetMessageDirection,
} from "../lib/support/thread-bucket";
import { RichDraftEditor } from "../components/RichDraftEditor";
import { QuotaExceededModal } from "../components/billing/QuotaExceededModal";
import { useEntitlements } from "../lib/billing/entitlements-context";
import prisma from "../db.server";
import { computePriorContact } from "../lib/support/prior-contact";
import {
  handleDisconnect,
  handleStop,
  handleResync,
  handleReclassify,
  handleSync,
  handleBackfill,
  handleToggleAutoSync,
  handleDiagnose,
  handleReanalyze,
  handleGenerateDraft,
  handleRedraft,
  handleRefreshEmailHtml,
  handleRefine,
  handleMoveThread,
  handleEditThreadIdentifiers,
  handleUpdateClassification,
  handleDismissAnalyzeQueue,
  handleDismissThreadFromAnalyze,
  handleSendDraft,
} from "../lib/support/inbox-actions";
import type { ClassificationEdit } from "../lib/support/manual-classification";
import {
  MetricCard,
  SegmentedTabs,
  Card,
  InboxIcon,
  SparklesIcon,
  CheckCircleIcon,
  MailIcon,
} from "../components/ui";
import MailboxBadge from "../components/inbox/MailboxBadge";
import MailboxFilter from "../components/inbox/MailboxFilter";
import MailboxIndicator from "../components/inbox/MailboxIndicator";
import SendButton from "../components/inbox/SendButton";
import { canSend } from "../lib/mail/scopes";

// Tracks email IDs for which an HTML body refresh was already submitted
// this browser session, so we don't re-fetch on every remount.
const _refreshedEmailIds = new Set<string>();

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  await requireOnboardingComplete(session.shop, request);
  const shop = session.shop;
  const url = new URL(request.url);
  const mailConnectionId = url.searchParams.get("mailbox") || undefined;

  // Soft-pause: detect if the shop is over its plan's mailbox limit (can happen
  // after a scheduled downgrade kicks in) and disable auto-sync on all mailboxes.
  // Idempotent — safe to call on every request.
  {
    const { resolveEntitlements } = await import("../lib/billing/entitlements");
    const { applySoftPauseIfOverflow } = await import("../lib/billing/soft-pause");
    const ent = await resolveEntitlements({ shop, admin });
    if (ent.state === "paid_active" || ent.state === "trial_active") {
      if (ent.planId) {
        const paused = await applySoftPauseIfOverflow({ shop, activePlanId: ent.planId });
        if (paused > 0) {
          console.warn(`[inbox] soft-paused ${paused} mailboxes for shop=${shop} (plan=${ent.planId})`);
        }
      }
    }
  }

  const onboardingFlag = await getShopFlag(shop);
  const shopFlagRaw = process.env.SEND_DISABLED_FOR_INTERNAL === "true"
    ? await prisma.shopFlag.findUnique({ where: { shop }, select: { isInternal: true } })
    : null;
  const sendDisabled = process.env.SEND_DISABLED_FOR_INTERNAL === "true" && shopFlagRaw?.isInternal === true;
  const checklistState = deriveChecklistState({
    hasDraft: await hasGeneratedAnyDraft(shop),
    hasCustomizedSettings: await hasCustomizedSupportSettings(shop),
  });
  let checklistDismissed = isChecklistDismissed(onboardingFlag);
  // Stickyness: once the checklist has been fully completed at least once,
  // persist the dismissal so that destructive ops like "Re-sync all" — which
  // wipe ReplyDraft rows and would otherwise un-tick "first draft" — can't
  // resurrect it for users who have clearly moved past onboarding.
  if (checklistState.allComplete && !checklistDismissed) {
    await markChecklistDismissed(shop);
    checklistDismissed = true;
  }
  const onboardingChecklist = {
    state: checklistState,
    dismissed: checklistDismissed,
  };
  // Check if ANY mailbox is connected — inbox only loads when at least one exists.
  // In multi-mailbox, findFirst is correct: we only need a truthy/falsy answer here.
  const connection = await prisma.mailConnection.findFirst({ where: { shop } });

  let emails: SerializedEmail[] = [];
  let threadStates: Record<string, SerializedThreadState> = {};
  let priorContact: Record<string, { byOrder: boolean; recentReply: boolean }> = {};
  if (connection) {
    const rows = await prisma.incomingEmail.findMany({
      where: { shop, ...(mailConnectionId ? { mailConnectionId } : {}) },
      orderBy: { receivedAt: "desc" },
      take: 500,
      // bodyHtml is the heaviest column (sanitized HTML bodies routinely top
      // 100 KB per message). The thread-detail view lazy-loads it via the
      // existing refresh_email_html action when the user opens a thread, so
      // omitting it from the list query saves ~30-50 MB on a fully-loaded
      // 500-mail inbox.
      omit: { bodyHtml: true },
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
          ...(mailConnectionId ? { mailConnectionId } : {}),
          canonicalThreadId: { in: canonicalIds },
          analysisResult: { not: null },
        },
        orderBy: { receivedAt: "desc" },
        distinct: ["canonicalThreadId"],
        // Hard cap as a defence-in-depth: distinct + canonicalIds already
        // bounds this to the page size, but a future refactor that drops
        // distinct shouldn't suddenly fetch the whole table.
        take: canonicalIds.length,
        omit: { bodyHtml: true },
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
          redactedAt: true,
          redactedReason: true,
          analyzedAt: true,
          dismissedFromAnalyzeAt: true,
        },
      });
      threadStates = Object.fromEntries(
        threads.map((t) => [t.id, serializeThreadState(t)]),
      );
      threadCreatedAt = new Map(threads.map((t) => [t.id, t.createdAt]));
    }

    // GDPR tombstones — threads whose content was wiped by customers/redact.
    // The Thread row is kept so the merchant inbox shows a placeholder; we
    // fetch the most recent tombstones (separate from the message-driven
    // canonicalIds query above because there are no IncomingEmail rows
    // pointing at them anymore).
    const tombstoneThreads = await prisma.thread.findMany({
      where: { shop, ...(mailConnectionId ? { mailConnectionId } : {}), redactedAt: { not: null } },
      orderBy: { redactedAt: "desc" },
      take: 200,
      select: {
        id: true,
        provider: true,
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
        redactedAt: true,
        redactedReason: true,
      },
    });
    for (const t of tombstoneThreads) {
      threadStates[t.id] = serializeThreadState(t);
      threadCreatedAt.set(t.id, t.createdAt);
      // Synthesize one placeholder "email" per tombstone so the existing
      // group-by-thread / filter / render pipeline works unchanged. The UI
      // detects threadState.redactedAt and swaps in a tombstone card.
      emails.push({
        id: `tombstone:${t.id}`,
        externalMessageId: "",
        threadId: "",
        canonicalThreadId: t.id,
        mailConnectionId: "",
        fromAddress: "",
        fromName: "",
        subject: "",
        snippet: "",
        bodyText: "",
        bodyHtml: "",
        incomingAttachments: [],
        receivedAt: (t.redactedAt ?? t.createdAt).toISOString(),
        tier1Result: null,
        tier2Result: null,
        isKnownCustomer: false,
        processingStatus: "redacted",
        analysisResult: null,
        lastAnalyzedAt: null,
        draftReply: null,
        draftHistory: [],
        draftCC: null,
        draftBCC: null,
        draftSubject: null,
        draftReplyMode: "thread",
        draftAttachments: [],
        replyDraftId: null,
        draftSentAt: null,
        errorMessage: null,
      });
    }

    // Prior-contact badge temporarily hidden — the signal computation is kept
    // available (computePriorContact + tests) so we can re-enable it once the
    // wording / UX framing is decided. Re-enable by removing the early empty
    // assignment below and uncommenting the call.
    priorContact = {};
    // priorContact = await computePriorContact(shop, canonicalIds, rows, threadStates, threadCreatedAt);
  }

  // Build auth URLs for both providers (only shown when not connected)
  let gmailAuthUrl: string | null = null;
  let zohoAuthUrl: string | null = null;
  let outlookAuthUrl: string | null = null;
  if (!connection) {
    try { gmailAuthUrl = getGmailAuthUrl(shop); } catch { /* credentials not configured */ }
    try { zohoAuthUrl = getZohoAuthUrl(shop); } catch { /* credentials not configured */ }
    try { outlookAuthUrl = getOutlookAuthUrl(shop); } catch { /* credentials not configured */ }
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

  // Per-mailbox metadata — consumed by the mailbox filter UI (Phase 8).
  const connections = await prisma.mailConnection.findMany({
    where: { shop },
    select: {
      id: true,
      email: true,
      provider: true,
      autoSyncEnabled: true,
      lastSyncError: true,
      lastSyncAt: true,
      grantedScopes: true,
    },
  });

  const threadCountsRaw = await prisma.thread.groupBy({
    by: ["mailConnectionId"],
    where: { shop, messages: { some: {} }, supportNature: { not: "non_support" } },
    _count: { _all: true },
  });
  const threadCountsByMailbox = Object.fromEntries(
    threadCountsRaw.map((r) => [r.mailConnectionId, r._count._all]),
  );

  return {
    connected: !!connection,
    connectionId: connection?.id ?? null,
    provider: (connection?.provider ?? null) as MailProvider | null,
    connectedEmail: connection?.email ?? null,
    lastSyncAt: connection?.lastSyncAt?.toISOString() ?? null,
    lastSyncError: connection?.lastSyncError ?? null,
    autoSyncEnabled: connection?.autoSyncEnabled ?? false,
    autoSyncIntervalMinutes: connection?.autoSyncIntervalMinutes ?? 5,
    gmailAuthUrl,
    zohoAuthUrl,
    outlookAuthUrl,
    emails,
    threadStates,
    priorContact,
    syncInProgress,
    onboardingChecklist,
    shop,
    connections: connections.map((c) => ({
      ...c,
      lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
      canSend: canSend(c),
    })),
    threadCountsByMailbox,
    mailConnectionId: mailConnectionId ?? null,
    sendDisabled,
  };
};

// Skip the (heavy) inbox loader when the user only opens/closes a thread —
// `?thread=<id>` is purely client-side state and fetching 500 emails again
// adds ~1s of perceived latency on every preview click.
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
  formMethod,
  actionResult,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod.toUpperCase() !== "GET") return true;
  if (actionResult) return true;
  if (currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  // Programmatic revalidations (useRevalidator polling for background sync)
  // arrive with currentUrl === nextUrl. Allow those — otherwise the inbox
  // never picks up emails ingested by auto-sync until a hard reload.
  if (currentUrl.search === nextUrl.search) return defaultShouldRevalidate;
  // Skip the (heavy) inbox loader when ONLY `?thread=` changed (opening/
  // closing a thread is purely client-side state).
  const a = new URLSearchParams(currentUrl.search);
  const b = new URLSearchParams(nextUrl.search);
  a.delete("thread");
  b.delete("thread");
  if (a.toString() === b.toString()) return false;
  return defaultShouldRevalidate;
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("_action") || formData.get("intent") || "");

  if (intent === "disconnect") {
    const mailConnectionId = String(formData.get("mailConnectionId") ?? "");
    if (!mailConnectionId)
      return { error: "missing_mailConnectionId", report: null, disconnected: false, reanalyzed: null, refined: null };
    return await handleDisconnect({ shop, mailConnectionId });
  }

  if (intent === "stop") {
    const mailConnectionId = String(formData.get("mailConnectionId") ?? "");
    if (!mailConnectionId)
      return { error: "missing_mailConnectionId", report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
    return handleStop({ shop, mailConnectionId });
  }

  if (intent === "resync") {
    const mailConnectionId = String(formData.get("mailConnectionId") ?? "");
    if (!mailConnectionId)
      return { error: "missing_mailConnectionId", report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
    return await handleResync({ shop, mailConnectionId });
  }

  if (intent === "reclassify") {
    return handleReclassify({ shop });
  }

  if (intent === "sync") {
    const syncMailConnectionId = formData.get("mailConnectionId") as string | null || undefined;
    return handleSync({ shop, admin, mailConnectionId: syncMailConnectionId });
  }

  if (intent === "backfill") {
    const days = Number(formData.get("days") ?? "60");
    const backfillMailConnectionId = formData.get("mailConnectionId") as string | null;
    if (!backfillMailConnectionId) {
      return { error: "missing_mailConnectionId", report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
    }
    return handleBackfill({ shop, mailConnectionId: backfillMailConnectionId, days });
  }

  if (intent === "toggleAutoSync") {
    const enable = formData.get("enable") === "1";
    const toggleMailConnectionId = formData.get("mailConnectionId") as string | null;
    if (!toggleMailConnectionId) {
      return { error: "missing_mailConnectionId", report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
    }
    return handleToggleAutoSync({ shop, mailConnectionId: toggleMailConnectionId, enable });
  }

  if (intent === "diagnose") {
    return handleDiagnose({ shop });
  }

  if (intent === "reanalyze") {
    const emailId = String(formData.get("emailId") ?? "");
    const skipDraft = formData.get("skipDraft") === "1";
    return handleReanalyze({ shop, admin, emailId, skipDraft });
  }

  if (intent === "generateDraft") {
    const emailId = String(formData.get("emailId") ?? "");
    const instructions = String(formData.get("instructions") ?? "");
    const currentDraft = String(formData.get("currentDraft") ?? "");
    return handleGenerateDraft({ shop, admin, emailId, instructions, currentDraft });
  }

  if (intent === "redraft") {
    const emailId = String(formData.get("emailId") ?? "");
    return handleRedraft({ shop, admin, emailId });
  }

  if (intent === "refresh_email_html") {
    const emailId = String(formData.get("emailId") ?? "");
    return handleRefreshEmailHtml({ shop, emailId });
  }

  if (intent === "refine") {
    const emailId = String(formData.get("emailId") ?? "");
    const instructions = String(formData.get("instructions") ?? "");
    const currentDraft = String(formData.get("currentDraft") ?? "");
    return handleRefine({ shop, admin, emailId, instructions, currentDraft });
  }

  if (intent === "moveThread") {
    const canonicalThreadId = String(formData.get("canonicalThreadId") ?? "");
    const target = String(formData.get("target") ?? "");
    return handleMoveThread({ shop, canonicalThreadId, target, admin });
  }

  if (intent === "dismissAnalyzeQueue") {
    return handleDismissAnalyzeQueue({ shop });
  }

  if (intent === "dismissThreadFromAnalyze") {
    const canonicalThreadId = String(formData.get("canonicalThreadId") ?? "");
    return handleDismissThreadFromAnalyze({ shop, canonicalThreadId });
  }

  if (intent === "editThreadIdentifiers") {
    const canonicalThreadId = String(formData.get("canonicalThreadId") ?? "");
    const norm = (v: FormDataEntryValue | null): string | null => {
      const s = (v == null ? "" : String(v)).trim();
      return s === "" ? null : s;
    };
    const orderRaw = norm(formData.get("resolvedOrderNumber"));
    const resolvedOrderNumber = orderRaw ? orderRaw.replace(/^#/, "").trim() || null : null;
    const resolvedTrackingNumber = norm(formData.get("resolvedTrackingNumber"));
    const resolvedEmail = norm(formData.get("resolvedEmail"))?.toLowerCase() ?? null;
    const resolvedCustomerName = norm(formData.get("resolvedCustomerName"));
    return handleEditThreadIdentifiers({ shop, admin, canonicalThreadId, resolvedOrderNumber, resolvedTrackingNumber, resolvedEmail, resolvedCustomerName });
  }

  if (intent === "updateClassification") {
    const threadId = String(formData.get("threadId") ?? "");
    if (!threadId) {
      return {
        classificationError: "missing_thread_id",
        report: null,
        disconnected: false,
        reanalyzed: null,
        refined: null,
      };
    }
    const rawIntents = formData.get("intents");
    const resetIntents = formData.get("resetIntents") === "1";
    const orderChangeType = String(formData.get("orderChangeType") ?? "");
    const edit: ClassificationEdit = {};
    if (resetIntents) {
      edit.resetIntents = true;
    } else if (typeof rawIntents === "string" && rawIntents.length > 0) {
      try {
        edit.intents = JSON.parse(rawIntents);
      } catch {
        return {
          classificationError: "invalid_intents_payload",
          report: null,
          disconnected: false,
          reanalyzed: null,
          refined: null,
        };
      }
    }
    const orderId = String(formData.get("orderId") ?? "");
    const candidateJson = String(formData.get("candidate") ?? "");
    const orderNumber = String(formData.get("orderNumber") ?? "");
    return handleUpdateClassification({ shop, admin, threadId, edit, orderChangeType, orderId, candidateJson, orderNumber });
  }

  if (intent === "send") {
    const mailConnectionId = String(formData.get("mailConnectionId") ?? "");
    const draftId = String(formData.get("draftId") ?? "");
    if (!mailConnectionId || !draftId) {
      return { error: "missing_params", report: null, disconnected: false, reanalyzed: null, refined: null };
    }
    return handleSendDraft({ shop, mailConnectionId, draftId });
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
  redactedAt: string | null;
  redactedReason: string | null;
  analyzedAt: string | null;
  dismissedFromAnalyzeAt: string | null;
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
  redactedAt?: Date | null;
  redactedReason?: string | null;
  analyzedAt?: Date | null;
  dismissedFromAnalyzeAt?: Date | null;
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
    redactedAt: t.redactedAt ? t.redactedAt.toISOString() : null,
    redactedReason: t.redactedReason ?? null,
    analyzedAt: t.analyzedAt ? t.analyzedAt.toISOString() : null,
    dismissedFromAnalyzeAt: t.dismissedFromAnalyzeAt ? t.dismissedFromAnalyzeAt.toISOString() : null,
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
  mailConnectionId: string;
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
  lastAnalyzedAt: string | null;
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
  draftSentAt: string | null;
  errorMessage: string | null;
}

function serializeEmail(row: {
  id: string;
  externalMessageId: string;
  threadId: string;
  canonicalThreadId: string | null;
  mailConnectionId: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  snippet: string;
  bodyText: string;
  // bodyHtml is omitted from the inbox list loader (heavy column lazy-loaded
  // by refresh_email_html on thread expand). Other callers that still
  // include it can pass it through; missing values fall back to "".
  bodyHtml?: string;
  receivedAt: Date;
  tier1Result: string | null;
  tier2Result: string | null;
  isKnownCustomer: boolean;
  processingStatus: string;
  analysisResult: string | null;
  lastAnalyzedAt: Date | null;
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
    sentAt?: Date | null;
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
  // Mask sent drafts in the preview: once a draft has been sent (sentAt set),
  // we treat the email as having NO current draft. The DB row is preserved
  // (audit, heuristic bucket, linkedOutgoingEmailId), but the UI's editor +
  // Send button see a blank state — merchant clicks "Générer le brouillon"
  // to produce a fresh one (upsertReplyDraftBody resets sentAt on update).
  const draftIsSent = rd?.sentAt != null;
  const history: string[] = Array.isArray(rd?.bodyHistory) ? (rd!.bodyHistory as string[]) : [];
  return {
    id: row.id,
    externalMessageId: row.externalMessageId,
    threadId: row.threadId,
    canonicalThreadId: row.canonicalThreadId,
    mailConnectionId: row.mailConnectionId,
    fromAddress: row.fromAddress,
    fromName: decodeHtmlEntities(row.fromName),
    subject: decodeHtmlEntities(row.subject),
    snippet: decodeHtmlEntities(row.snippet).replace(/<[^>]*>/g, " ").replace(/[<>]/g, " ").replace(/\s{2,}/g, " ").trim(),
    bodyText: decodeHtmlEntities(row.bodyText),
    bodyHtml: row.bodyHtml ?? "",
    incomingAttachments: row.incomingAttachments,
    receivedAt: row.receivedAt.toISOString(),
    tier1Result: row.tier1Result,
    tier2Result: row.tier2Result,
    isKnownCustomer: row.isKnownCustomer,
    processingStatus: row.processingStatus,
    analysisResult: parsed,
    lastAnalyzedAt: row.lastAnalyzedAt ? row.lastAnalyzedAt.toISOString() : null,
    draftReply: draftIsSent ? null : (rd?.body ?? null),
    draftHistory: draftIsSent ? [] : history,
    draftCC: draftIsSent ? null : (rd?.cc ?? null),
    draftBCC: draftIsSent ? null : (rd?.bcc ?? null),
    draftSubject: draftIsSent ? null : (rd?.subject ?? null),
    draftReplyMode: draftIsSent ? "thread" : (rd?.replyMode ?? "thread"),
    draftAttachments: draftIsSent ? [] : (rd?.attachments ?? []),
    replyDraftId: draftIsSent ? null : (rd?.id ?? null),
    // Keep the sent timestamp so the UI can render a "Envoyé le DATE"
    // indicator near the Send button area instead of an empty editor.
    draftSentAt: rd?.sentAt ? rd.sentAt.toISOString() : null,
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

// Thin wrapper around the shared bucket lib — the dashboard uses the same
// function so counts never disagree between surfaces. See
// [app/lib/support/thread-bucket.ts](../lib/support/thread-bucket.ts).
function getOpsBucket(
  thread: EmailThread,
  state: SerializedThreadState | null,
  connectedEmail: string | null,
): OpsBucket {
  return getThreadOpsBucket({
    latest: thread.latest,
    classification: getThreadClassification(thread),
    noReplyNeeded: thread.latest.analysisResult?.conversation?.noReplyNeeded === true,
    state,
    connectedEmail,
  });
}

function hasLinkedOrder(state: SerializedThreadState | null): boolean {
  return !!state?.resolvedOrderNumber;
}

/** Tooltip rendered via portal so card / row / overflow ancestors can't
 *  clip it. Positioned above (or below if no room) the anchor element. */
function PortalTooltip({
  open,
  anchor,
  children,
}: {
  open: boolean;
  anchor: HTMLElement | null;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'top' | 'bottom' } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) { setPos(null); return; }
    const update = () => {
      const r = anchor.getBoundingClientRect();
      const TOOLTIP_H_EST = 110; // generous; tooltip will be at most a few lines
      const TOOLTIP_W = 230;
      const margin = 8;
      const placement: 'top' | 'bottom' = r.top > TOOLTIP_H_EST + margin ? 'top' : 'bottom';
      const top = placement === 'top' ? r.top - margin : r.bottom + margin;
      // Anchor right edge to anchor right edge, but clamp to viewport.
      let left = r.right - TOOLTIP_W;
      if (left < margin) left = margin;
      if (left + TOOLTIP_W > window.innerWidth - margin) left = window.innerWidth - margin - TOOLTIP_W;
      setPos({ top, left, placement });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, anchor]);

  if (!open || !pos || typeof document === 'undefined') return null;
  return createPortal(
    <div style={{
      position: 'fixed',
      top: pos.top,
      left: pos.left,
      transform: pos.placement === 'top' ? 'translateY(-100%)' : undefined,
      width: 230,
      background: '#fff',
      border: '1px solid var(--ui-slate-200)',
      borderRadius: 8,
      padding: '8px 12px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
      zIndex: 10_000,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      fontSize: 12,
      color: 'var(--ui-slate-700)',
      fontWeight: 400,
      pointerEvents: 'none',
    }}>
      {children}
    </div>,
    document.body,
  );
}

/** Rounded pill with an alert-triangle icon — clickable trigger for the
 *  thread-level signals tooltip (replied elsewhere, ambiguous order, etc). */
function SignalPill() {
  return (
    <span
      role="img"
      aria-label="Warning: conversation has a signal (replied elsewhere, ambiguous order, etc)"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#fef3c7",
        color: "#a86600",
        borderRadius: "999px",
        padding: "4px",
        cursor: "help",
        lineHeight: 0,
      }}
    >
      <svg
        aria-hidden
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    </span>
  );
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
  return libGetMessageDirection(email, connectedEmail);
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
  connectionId,
  provider,
  connectedEmail,
  lastSyncAt,
  gmailAuthUrl,
  zohoAuthUrl,
  outlookAuthUrl,
  isSyncing,
  autoSyncEnabled,
  autoSyncIntervalMinutes,
}: {
  connected: boolean;
  connectionId: string | null;
  provider: MailProvider | null;
  connectedEmail: string | null;
  lastSyncAt: string | null;
  gmailAuthUrl: string | null;
  zohoAuthUrl: string | null;
  outlookAuthUrl: string | null;
  isSyncing: boolean;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
}) {
  const { t } = useTranslation();
  const ent = useEntitlements();
  const [showAdvanced, setShowAdvanced] = useState(false);

  if (!connected) {
    // Pre-OAuth gate: if billing prevents adding a mailbox (trial expired
    // or paid plan with mailbox quota reached) show a clear upgrade prompt
    // instead of the connect buttons. Saves the merchant from going through
    // the full Microsoft / Google consent flow only to hit a 0/0 wall on
    // the callback.
    if (!ent.canConnectMailbox) {
      return (
        <s-box padding="large-500" borderWidth="base" borderRadius="large-200" background="subdued">
          <s-stack direction="block" gap="base" align="center">
            <s-heading>{t("inbox.mailboxLimit.title")}</s-heading>
            <s-paragraph>
              {ent.state === "trial_expired"
                ? t("inbox.mailboxLimit.trialExpired")
                : t("inbox.mailboxLimit.quotaReached", {
                    used: ent.mailboxStatus.used,
                    limit: ent.mailboxStatus.limit,
                  })}
            </s-paragraph>
            <Link to="/app/billing">
              <s-button variant="primary">{t("billing.upgradeCta")}</s-button>
            </Link>
          </s-stack>
        </s-box>
      );
    }
    return (
      <s-box padding="large-500" borderWidth="base" borderRadius="large-200" background="subdued">
        <s-stack direction="block" gap="base" align="center">
          <s-heading>{t("inbox.connectHeading")}</s-heading>
          <s-paragraph>
            {t("inbox.connectDesc")}
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            {gmailAuthUrl && (
              <s-button variant="primary" onClick={() => { window.top!.location.href = gmailAuthUrl; }}>
                {t("inbox.connectGmail")}
              </s-button>
            )}
            {zohoAuthUrl && (
              <s-button variant="secondary" onClick={() => { window.top!.location.href = zohoAuthUrl; }}>
                {t("inbox.connectZoho")}
              </s-button>
            )}
            {outlookAuthUrl && (
              <s-button variant="secondary" onClick={() => { window.top!.location.href = outlookAuthUrl; }}>
                {t("inbox.connectOutlook")}
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-box>
    );
  }

  const providerLabel = provider === "zoho" ? "Zoho Mail" : provider === "outlook" ? "Outlook / Microsoft 365" : "Gmail";

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
            <input type="hidden" name="mailConnectionId" value={connectionId ?? ""} />
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
              <input type="hidden" name="mailConnectionId" value={connectionId ?? ""} />
              <input type="hidden" name="days" value="60" />
              <s-button variant="tertiary" type="submit" {...(isSyncing ? { loading: true } : {})}>
                {t("inbox.backfill")}
              </s-button>
            </Form>
            <Form
              method="post"
              onSubmit={(e) => {
                // Resync wipes all ingested email rows for this mailbox. Make
                // sure a misclick doesn't destroy the merchant's history.
                if (!window.confirm(t("inbox.resyncConfirm"))) {
                  e.preventDefault();
                }
              }}
            >
              <input type="hidden" name="_action" value="resync" />
              <input type="hidden" name="mailConnectionId" value={connectionId ?? ""} />
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
              <input type="hidden" name="mailConnectionId" value={connectionId ?? ""} />
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
      <label style={{ ...labelStyle, flex: "1 1 180px", minWidth: 0 }}>
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
  const [refreshFailed, setRefreshFailed] = useState(false);
  const fetcher = useFetcher<{ refreshed?: string }>();
  const submitting = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const r = fetcher.data?.refreshed;
    if (r === "error") {
      setRefreshFailed(true);
    } else if (r === "ok" || r === "skipped_noop" || r === "no_anchor") {
      setRefreshFailed(false);
    }
  }, [fetcher.state, fetcher.data]);
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-stack direction="inline" gap="small-300" blockAlign="center">
          <s-text variant="headingSm">{t("inbox.parsedIdentifiers")}</s-text>
          <s-button variant="plain" size="slim" onClick={() => setOpen((v) => !v)}>
            {open ? t("inbox.cancel") : t("inbox.edit")}
          </s-button>
        </s-stack>
        {refreshFailed && (
          <s-banner tone="warning">
            {t(
              "inbox.identifiersRefreshFailed",
              "Identifiers saved. Order/tracking refresh failed — will retry on next sync.",
            )}
          </s-banner>
        )}
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

function AttachmentDownloadButton({ att }: { att: IncomingAttachment }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const download = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    setError(false);
    try {
      // Shopify embedded app: attach the session token so authenticate.admin() accepts the fetch
      const headers: Record<string, string> = {};
      const shopify = typeof window !== "undefined" && (window as unknown as { shopify?: { idToken?: () => Promise<string> } }).shopify;
      if (shopify?.idToken) {
        headers["Authorization"] = `Bearer ${await shopify.idToken()}`;
      }
      const res = await fetch(`/api/incoming-attachment?id=${att.id}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = att.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[attachment download]", err);
      setError(true);
    } finally {
      setLoading(false);
    }
  };
  return (
    <button
      type="button"
      onClick={download}
      disabled={loading}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "4px 10px",
        fontSize: "12px",
        fontWeight: 500,
        borderRadius: "9999px",
        border: "1px solid var(--ui-slate-200)",
        background: loading ? "var(--ui-slate-200)" : "var(--ui-slate-100)",
        color: "var(--ui-slate-700)",
        cursor: loading ? "default" : "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {loading ? "⟳" : error ? "✕" : "📎"} {att.fileName}
      <span style={{ color: error ? "#ef4444" : "var(--ui-slate-400)", fontSize: "11px" }}>
        {error ? "erreur" : formatBytes(att.sizeBytes)}
      </span>
    </button>
  );
}

const EMAIL_BASE_CSS = `
<style>
  html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; background: transparent; word-wrap: break-word; overflow-wrap: break-word; }
  img { max-width: 100% !important; height: auto !important; display: inline-block; }
  table { max-width: 100% !important; border-collapse: collapse; }
  td, th { padding: 4px 8px; }
  a { color: #2563eb; }
  p, div { max-width: 100%; }
  pre, code { white-space: pre-wrap; word-break: break-all; }
  * { box-sizing: border-box; }
</style>
`;

function EmailHtmlBody({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      // The iframe is sandboxed without allow-same-origin → its origin is "null".
      // Reject any message that doesn't come from a null-origin frame to
      // prevent Shopify's parent frame, dev-tools panels, or other iframes
      // on the page from spoofing height-resize messages.
      if (event.origin !== "null") return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown };
      if (data?.type !== "email-height") return;
      if (typeof data.height !== "number" || !Number.isFinite(data.height)) return;
      if (iframeRef.current) {
        // Cap the height to defend against a malicious email setting an
        // absurd scrollHeight that would create a giant scroll trap.
        const safe = Math.min(Math.max(data.height + 4, 60), 8000);
        iframeRef.current.style.height = safe + "px";
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Inject a small script that posts the body height to the parent after load.
  // Note: allow-scripts without allow-same-origin runs in a null origin — the
  // iframe cannot access the parent's DOM or cookies, only postMessage.
  const heightScript = `<script>window.addEventListener('load',function(){window.parent.postMessage({type:'email-height',height:document.body.scrollHeight},'*')});<\/script>`;

  const withCss = html.includes("<html")
    ? html.replace(/<head[^>]*>/i, (m) => m + EMAIL_BASE_CSS)
    : EMAIL_BASE_CSS + html;

  const srcDoc = withCss.includes("</body>")
    ? withCss.replace("</body>", heightScript + "</body>")
    : withCss + heightScript;

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      // allow-scripts only — emails should never need to open popups,
      // and allow-same-origin is intentionally absent so the iframe
      // runs in a null origin (no DOM/cookies/storage from the parent).
      sandbox="allow-scripts"
      title="Email body"
      style={{ border: "none", width: "100%", minHeight: "60px", display: "block" }}
    />
  );
}

const EmailMessageBlock = memo(function EmailMessageBlock({
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

  // Memoize per-email — sanitize-html is expensive (O(html_size)) and EmailMessageBlock
  // re-renders any time the parent loader data changes, even if THIS email is unchanged.
  const cidMap = useMemo(() => buildCidMap(email.incomingAttachments), [email.incomingAttachments]);
  const sanitizedHtml = useMemo(
    () => (email.bodyHtml ? sanitizeEmailHtml(email.bodyHtml, cidMap) : null),
    [email.bodyHtml, cidMap],
  );
  const hasHtmlBody = !!sanitizedHtml;
  const hasUnresolvedZohoImages = !!email.bodyHtml?.includes("/mail/ImageDisplay?");

  const needsToggle = hasHtmlBody || body.length > PREVIEW_LENGTH;
  const [expanded, setExpanded] = useState(false);

  // Auto-refresh when bodyHtml is missing or still has unembedded Zoho inline images.
  const refreshFetcher = useFetcher();
  const refreshPending = refreshFetcher.state !== "idle";
  useEffect(() => {
    const needsRefresh = !email.bodyHtml || hasUnresolvedZohoImages;
    if (needsRefresh && !_refreshedEmailIds.has(email.id) && refreshFetcher.state === "idle") {
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
            <span suppressHydrationWarning style={{ fontSize: "0.8125rem", color: "#6b7280" }}>
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
          <>
            {hasHtmlBody ? (
              <EmailHtmlBody html={sanitizedHtml!} />
            ) : (
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.875rem", lineHeight: "1.6" }}>
                {body}
              </div>
            )}
          </>
        ) : (
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.875rem", lineHeight: "1.6" }}>
            {body.slice(0, PREVIEW_LENGTH) + (needsToggle ? "…" : "")}
          </div>
        )}

        {fileAttachments.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px" }}>
            {fileAttachments.map((att) => (
              <AttachmentDownloadButton key={att.id} att={att} />
            ))}
          </div>
        )}
      </s-stack>
    </s-box>
  );
});

// Placeholder rendered in place of a ThreadCard when the thread has been
// tombstoned by customers/redact (GDPR). The Thread row is kept so the
// merchant sees the gap and understands why — but every PII column is
// already NULL, so no content is available to render.
function TombstoneCard({
  redactedAt,
  reason,
}: {
  redactedAt: string;
  reason: string | null;
}) {
  const { t, i18n } = useTranslation();
  const dateLabel = (() => {
    try {
      return new Date(redactedAt).toLocaleDateString(i18n.language, {
        day: "numeric", month: "long", year: "numeric",
      });
    } catch {
      return redactedAt.slice(0, 10);
    }
  })();
  return (
    <div className="ui-card ui-card--compact" style={{ cursor: "default", opacity: 0.85 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <span aria-hidden style={{ fontSize: "1.125rem" }}>🗑️</span>
        <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: "0.875rem", color: "var(--ui-slate-700)" }}>
            {t("inbox.tombstoneTitle", { defaultValue: "Thread supprimé (RGPD)" })}
          </span>
          <span style={{ fontSize: "0.8125rem", color: "var(--ui-slate-500)" }}>
            {reason === "gdpr_customer_request"
              ? t("inbox.tombstoneReasonCustomer", {
                  defaultValue: "Demande de suppression du client — {{date}}",
                  date: dateLabel,
                })
              : t("inbox.tombstoneReasonGeneric", {
                  defaultValue: "Contenu supprimé — {{date}}",
                  date: dateLabel,
                })}
          </span>
          <span style={{ fontSize: "0.75rem", color: "var(--ui-slate-400)" }}>
            {t("inbox.tombstoneNoData", { defaultValue: "Aucune donnée conservée" })}
          </span>
        </div>
      </div>
    </div>
  );
}

const ThreadCard = memo(function ThreadCard({
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
  previousContact: { byOrder: boolean; recentReply: boolean };
  onSelect: (threadId: string) => void;
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
  const signalAnchorRef = useRef<HTMLSpanElement | null>(null);
  const [quotaModal, setQuotaModal] = useState<{
    open: boolean;
    used: number;
    limit: number;
    variant: 'exceeded' | 'just_used_last';
  }>({ open: false, used: 0, limit: 0, variant: 'exceeded' });
  useEffect(() => {
    const data = reanalyzeFetcher.data as { quotaExceeded?: boolean; quotaStatus?: { used: number; limit: number } } | null | undefined;
    if (!data) return;
    if (data.quotaExceeded) {
      setQuotaModal({ open: true, used: data.quotaStatus?.used ?? 0, limit: data.quotaStatus?.limit ?? 0, variant: 'exceeded' });
    } else if (data.quotaStatus && data.quotaStatus.used === data.quotaStatus.limit && data.quotaStatus.limit > 0) {
      setQuotaModal({ open: true, used: data.quotaStatus.used, limit: data.quotaStatus.limit, variant: 'just_used_last' });
    }
  }, [reanalyzeFetcher.data]);
  const hasSignals =
    (bucket === "to_process" || bucket === "waiting_merchant" || bucket === "waiting_customer") &&
    (previousContact.recentReply || previousContact.byOrder);

  // The "latest" email may be a new unanalyzed follow-up (e.g. waiting_merchant
  // after a customer reply). Find the most recent email that actually has
  // an analysisResult so we can still show the LLM context and the draft.
  const analysisEmail = [...emails].reverse().find((e) => e.analysisResult) ?? null;
  const ambiguousOrderCount =
    !analysisEmail?.analysisResult?.order &&
    (analysisEmail?.analysisResult?.orderCandidates?.length ?? 0) > 1
      ? analysisEmail!.analysisResult!.orderCandidates!.length
      : 0;
  const hasAnySignal = hasSignals || ambiguousOrderCount > 0;
  // For draft display, prefer the latest email's draft (freshly generated),
  // fall back to the analysisEmail's draft if latest has none yet.
  const draftEmail = latest.draftReply ? latest : (analysisEmail?.draftReply ? analysisEmail : null);

  const borderColor =
    cls === "support" ? "success" : cls === "uncertain" ? "warning" : undefined;

  return (
    <div
      onClick={() => onSelect(thread.threadId)}
      className={["ui-card ui-card--compact", isSelected ? "ui-card--selected" : ""].join(" ")}
      style={{ cursor: "pointer" }}
    >
      {/* Row 1 : badges */}
      <div className="ui-thread-row-tags">
        {cls === "uncertain" && <span className="ui-pill ui-pill--warning ui-pill--clickable" onClick={(e) => { e.stopPropagation(); onFilterClick({ nature: "uncertain" }); }}>{t("inbox.pillUncertain")}</span>}
        {/* Show "Non-support" badge for any thread in the "other" bucket:
            explicitly classified non_support (tier 1 or tier 2) AND outgoing-only
            threads (store's own emails, marketing copies, etc.) that have no
            incoming customer message and require no support action. */}
        {bucket === "other" && (
          <span className="ui-pill ui-pill--clickable" onClick={(e) => { e.stopPropagation(); onFilterClick({ nature: "non_support" }); }}>{t("inbox.pillNonSupport")}</span>
        )}

        {bucket === "to_process" ? (
          <span className="ui-pill ui-pill--warning ui-pill--clickable" onClick={(e) => { e.stopPropagation(); onBucketClick("to_handle"); }}>{t("inbox.stateWaitingMerchant")}</span>
        ) : bucket === "to_analyze" ? (
          <span className="ui-pill ui-pill--clickable" onClick={(e) => { e.stopPropagation(); onBucketClick("to_analyze"); }}>{t("inbox.bucketToAnalyze")}</span>
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

        {bucket !== "other" && (() => {
          const intents = analysisEmail?.analysisResult
            ? (analysisEmail.analysisResult.intents?.length ? analysisEmail.analysisResult.intents : [analysisEmail.analysisResult.intent])
            : [];
          if (intents.length === 0) return null;
          return (
            <>
              {intents.map((intent) => (
                <span
                  key={intent}
                  className="ui-pill ui-pill--clickable"
                  onClick={(e) => { e.stopPropagation(); onFilterClick({ intent }); }}
                >
                  {t(`analysis.intent_${intent}`, { defaultValue: intent })}
                </span>
              ))}
            </>
          );
        })()}
        {threadState?.historyStatus === "partial" && (
          <span
            className="ui-pill ui-pill--warning"
            title={t("inbox.pillPartialHistoryTooltip")}
            style={{ cursor: "help" }}
          >
            {t("inbox.pillPartialHistory")}
          </span>
        )}
        {latest.processingStatus === "error" && <span className="ui-pill ui-pill--danger">{t("inbox.pillError")}</span>}

        {hasAnySignal && (
          <span
            ref={signalAnchorRef}
            style={{ display: "inline-flex", alignItems: "center" }}
            onMouseEnter={(e) => { e.stopPropagation(); setShowSignals(true); }}
            onMouseLeave={() => setShowSignals(false)}
            onClick={(e) => e.stopPropagation()}
          >
            <SignalPill />
            <PortalTooltip open={showSignals} anchor={signalAnchorRef.current}>
              {hasSignals && previousContact.byOrder && <span>{t("inbox.signalPriorContactOrder")}</span>}
              {hasSignals && previousContact.recentReply && <span>{t("inbox.signalRepliedElsewhere")}</span>}
              {ambiguousOrderCount > 0 && (
                <span>{t("inbox.signalAmbiguousOrder", { count: ambiguousOrderCount })}</span>
              )}
            </PortalTooltip>
          </span>
        )}
      </div>

      {/* Row 2 : sender + time */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px", marginBottom: "4px" }}>
        <div className="ui-sender-stack" style={{ minWidth: 0 }}>
          <span className="ui-sender-stack__name" style={{ fontWeight: 600, fontSize: "0.9375rem", color: "var(--ui-slate-900)" }}>
            {latest.fromName || latest.fromAddress}
          </span>
          {latest.fromName && (
            <span className="ui-sender-stack__addr" style={{ fontWeight: 400, fontSize: "0.8125rem", color: "var(--ui-slate-500)" }}>
              {latest.fromAddress}
            </span>
          )}
        </div>
        <span suppressHydrationWarning style={{ flexShrink: 0, fontSize: "0.8125rem", color: "var(--ui-slate-500)" }}>
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
          overflowWrap: "anywhere",
          wordBreak: "break-word",
        }}>
          {reason || latest.snippet.slice(0, 140)}
          {!reason && latest.snippet.length > 140 ? "…" : ""}
        </div>
      )}

      {/* Row 5 : actions. Only swallow clicks coming from actual interactive
          children (buttons, links, form controls). Empty space inside this
          row should still bubble up so the whole card stays clickable. */}
      <div
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button, a, input, textarea, select, [role="button"]')) {
            e.stopPropagation();
          }
        }}
        style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "6px" }}
      >
        {latest.canonicalThreadId && (
          <MoveThreadControl
            canonicalThreadId={latest.canonicalThreadId}
            bucket={bucket}
            previousOperationalState={threadState?.previousOperationalState ?? null}
          />
        )}
        {(bucket === "to_process" || bucket === "waiting_merchant" || bucket === "to_analyze") &&
          !latest.draftReply &&
          !noReplyNeeded &&
          !latest.tier1Result?.startsWith("filtered:") &&
          latest.tier2Result !== "probable_non_client" && (
          <reanalyzeFetcher.Form method="post">
            <input type="hidden" name="_action" value="reanalyze" />
            <input type="hidden" name="emailId" value={latest.id} />
            {latest.processingStatus === "error" && (
              <input type="hidden" name="skipDraft" value="1" />
            )}
            <s-button type="submit" variant="primary" {...(isGenerating ? { loading: true } : {})}>
              {latest.processingStatus === "error"
                ? t("inbox.retryAnalysis")
                : bucket === "to_analyze"
                ? t("inbox.analyze")
                : latest.tier2Result === null
                  // Not yet Tier-2-classified: clicking runs Tier 2 first, and
                  // may or may not produce a draft depending on the verdict.
                  // "Analyser" is honest; "Générer le brouillon" promises a
                  // draft that won't materialize on non-support emails.
                  ? t("inbox.analyze")
                : latest.draftReply
                ? t("inbox.regenerateDraft")
                : t("inbox.generateDraft")}
            </s-button>
          </reanalyzeFetcher.Form>
        )}
        {bucket === "to_analyze" && latest.canonicalThreadId && (
          <DismissThreadFromAnalyzeButton canonicalThreadId={latest.canonicalThreadId} />
        )}
      </div>

      {/* Row 6 : Draft generated */}
      {latest.draftReply && (
        <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px solid var(--ui-slate-100)" }}>
          <span className="ui-pill ui-pill--success" style={{ fontSize: "11px", padding: "2px 8px" }}>{t("inbox.pillDraftGenerated")}</span>
        </div>
      )}
      <QuotaExceededModal
        open={quotaModal.open}
        onClose={() => setQuotaModal({ ...quotaModal, open: false })}
        variant={quotaModal.variant}
        used={quotaModal.used}
        limit={quotaModal.limit}
      />
    </div>
  );
});

// Hoisted out of DraftBlock so they aren't reallocated on every render.
const DRAFT_LABEL_STYLE: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--p-color-text-subdued)",
  minWidth: "52px",
};
const DRAFT_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

function DraftBlock({ email, threadSenderEmail }: {
  email: SerializedEmail;
  threadSenderEmail: string;
}) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const allVersions = [...email.draftHistory, email.draftReply!];
  const [versionIndex, setVersionIndex] = useState(allVersions.length - 1);
  const currentVersion = allVersions[versionIndex] ?? email.draftReply!;
  const isLatest = versionIndex === allVersions.length - 1;
  const total = allVersions.length;

  // Local editable body state — holds the user's working copy of the latest
  // version. Only reset when a new draft arrives from the server (AI regen,
  // refine, reanalyze), not when navigating between existing versions.
  const [bodyText, setBodyText] = useState(email.draftReply ?? "");
  useEffect(() => { setBodyText(email.draftReply ?? ""); }, [email.draftReply]);

  // Defer TipTap mount: the editor's init costs ~150-300ms and was the
  // dominant chunk of perceived latency when opening a thread. Rendering a
  // plain-HTML preview first lets the panel paint immediately; the real
  // editor swaps in on the next frame so typing/formatting still works.
  const [editorMounted, setEditorMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEditorMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

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

  // Jump to latest version when a new draft arrives
  useEffect(() => {
    setVersionIndex(allVersions.length - 1);
  }, [allVersions.length]);

  const generateFetcher = useFetcher();
  const submitting = generateFetcher.state !== "idle";
  const [instructions, setInstructions] = useState("");
  const wantsRefine = instructions.trim().length > 0;
  const generateFormRef = useRef<HTMLFormElement | null>(null);

  const [quotaModal, setQuotaModal] = useState<{
    open: boolean;
    used: number;
    limit: number;
    variant: 'exceeded' | 'just_used_last';
  }>({ open: false, used: 0, limit: 0, variant: 'exceeded' });

  useEffect(() => {
    const data = generateFetcher.data as { quotaExceeded?: boolean; quotaStatus?: { used: number; limit: number } } | null | undefined;
    if (!data) return;
    if (data.quotaExceeded) {
      setQuotaModal({ open: true, used: data.quotaStatus?.used ?? 0, limit: data.quotaStatus?.limit ?? 0, variant: 'exceeded' });
    } else if (data.quotaStatus && data.quotaStatus.used === data.quotaStatus.limit && data.quotaStatus.limit > 0) {
      setQuotaModal({ open: true, used: data.quotaStatus.used, limit: data.quotaStatus.limit, variant: 'just_used_last' });
    }
  }, [generateFetcher.data]);

  // Clear the instructions textarea after a successful submit so the next
  // click is a "regenerate", not a stale refine.
  useEffect(() => {
    if (generateFetcher.state !== "idle") return;
    const data = generateFetcher.data as { quotaExceeded?: boolean; quotaStatus?: unknown } | null | undefined;
    if (!data) return;
    if (data.quotaExceeded) return;
    if (data.quotaStatus) {
      setInstructions("");
    }
  }, [generateFetcher.state, generateFetcher.data]);

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

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <s-stack direction="block" gap="base">

        {/* Compose header */}
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <div style={DRAFT_ROW_STYLE}>
            <span style={DRAFT_LABEL_STYLE}>À</span>
            <span style={{ fontSize: "13px", color: "var(--p-color-text-subdued)" }}>{threadSenderEmail}</span>
          </div>
          <div style={DRAFT_ROW_STYLE}>
            <span style={DRAFT_LABEL_STYLE}>Objet</span>
            <input
              style={{ flex: 1, border: "none", borderBottom: "1px solid var(--p-color-border)", padding: "2px 0", fontSize: "13px", background: "transparent", outline: "none" }}
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                saveMeta({ subject: e.target.value });
              }}
            />
          </div>
          <div style={DRAFT_ROW_STYLE}>
            <span style={DRAFT_LABEL_STYLE}>CC</span>
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
            <div style={DRAFT_ROW_STYLE}>
              <span style={DRAFT_LABEL_STYLE}>BCC</span>
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
          <s-text variant="headingSm">{t("support.draftReplySection")}</s-text>
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

        {editorMounted ? (
          <RichDraftEditor
            content={isLatest ? bodyText : currentVersion}
            onChange={isLatest ? (html) => {
              setBodyText(html);
              saveBody(html);
            } : undefined}
            readOnly={!isLatest}
          />
        ) : (
          <div
            aria-hidden
            style={{
              minHeight: "180px",
              border: "1px solid var(--p-color-border)",
              borderRadius: "6px",
              background: "var(--p-color-bg-surface-secondary)",
            }}
          />
        )}


        {isLatest && (
          <generateFetcher.Form
            method="post"
            ref={generateFormRef}
            style={{ borderTop: "1px solid var(--p-color-border)", paddingTop: "8px" }}
          >
            <input type="hidden" name="_action" value="generateDraft" />
            <input type="hidden" name="emailId" value={email.id} />
            <input type="hidden" name="currentDraft" value={bodyText} />
            <s-stack direction={isMobile ? "block" : "inline"} gap="small-300" blockAlign="end">
              <div style={{ flex: 1 }}>
                <textarea
                  name="instructions"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      generateFormRef.current?.requestSubmit();
                    }
                  }}
                  placeholder={t("inbox.generateInputPlaceholder")}
                  rows={3}
                  style={{
                    width: "100%",
                    height: "60px",
                    padding: "8px",
                    // Stronger border + a default outline that holds even in
                    // themes where --p-color-border is near-white.
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    fontFamily: "inherit",
                    fontSize: "13px",
                    background: "var(--p-color-bg-surface)",
                    color: "var(--p-color-text)",
                    resize: "none",
                    boxSizing: "border-box",
                    outline: "none",
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = "#6366f1";
                    e.currentTarget.style.boxShadow =
                      "0 0 0 2px rgba(99, 102, 241, 0.15)";
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = "#cbd5e1";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                style={{
                  width: 140,
                  height: 60,
                  padding: "0 12px",
                  borderRadius: "8px",
                  border: "1px solid #cbd5e1",
                  background: submitting ? "#f1f5f9" : "#ffffff",
                  color: submitting ? "#94a3b8" : "#0f172a",
                  fontFamily: "inherit",
                  fontSize: "13px",
                  fontWeight: 500,
                  cursor: submitting ? "wait" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "6px",
                  boxSizing: "border-box",
                  transition: "background-color 120ms",
                }}
              >
                {submitting && (
                  <span
                    aria-hidden
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      border: "2px solid #cbd5e1",
                      borderTopColor: "#475569",
                      animation: "spin 0.6s linear infinite",
                    }}
                  />
                )}
                {submitting
                  ? t(wantsRefine ? "inbox.refiningButton" : "inbox.regeneratingButton")
                  : t(wantsRefine ? "inbox.refineButton" : "inbox.regenerateButton")}
              </button>
            </s-stack>
          </generateFetcher.Form>
        )}

      </s-stack>

      <QuotaExceededModal
        open={quotaModal.open}
        onClose={() => setQuotaModal({ ...quotaModal, open: false })}
        variant={quotaModal.variant}
        used={quotaModal.used}
        limit={quotaModal.limit}
      />
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
  previousContact: { byOrder: boolean; recentReply: boolean };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const loaderData = useLoaderData<typeof loader>();
  const { latest, emails } = thread;
  const noReplyNeeded = latest.analysisResult?.conversation?.noReplyNeeded === true;
  const reanalyzeFetcher = useFetcher();
  const isGenerating = reanalyzeFetcher.state !== "idle";
  const [quotaModal, setQuotaModal] = useState<{
    open: boolean;
    used: number;
    limit: number;
    variant: 'exceeded' | 'just_used_last';
  }>({ open: false, used: 0, limit: 0, variant: 'exceeded' });
  useEffect(() => {
    const data = reanalyzeFetcher.data as { quotaExceeded?: boolean; quotaStatus?: { used: number; limit: number } } | null | undefined;
    if (!data) return;
    if (data.quotaExceeded) {
      setQuotaModal({ open: true, used: data.quotaStatus?.used ?? 0, limit: data.quotaStatus?.limit ?? 0, variant: 'exceeded' });
    } else if (data.quotaStatus && data.quotaStatus.used === data.quotaStatus.limit && data.quotaStatus.limit > 0) {
      setQuotaModal({ open: true, used: data.quotaStatus.used, limit: data.quotaStatus.limit, variant: 'just_used_last' });
    }
  }, [reanalyzeFetcher.data]);
  const [showThread, setShowThread] = useState(false);
  const [showSignals, setShowSignals] = useState(false);
  const signalAnchorRef = useRef<HTMLSpanElement | null>(null);
  const hasSignals =
    (bucket === "to_process" || bucket === "waiting_merchant" || bucket === "waiting_customer") &&
    (previousContact.recentReply || previousContact.byOrder);

  const [editingClassification, setEditingClassification] = useState(false);
  const [showRegenToast, setShowRegenToast] = useState(false);
  const classificationFetcher = useFetcher<typeof action>();
  const classificationRevalidator = useRevalidator();
  const handledClassificationData = useRef<unknown>(null);
  const isSubmittingClassification = classificationFetcher.state !== "idle";
  const classificationErrorCode =
    classificationFetcher.data && "classificationError" in classificationFetcher.data
      ? (classificationFetcher.data.classificationError as string | undefined)
      : undefined;

  const submitClassificationEdit = (edit: ClassificationEditSubmit) => {
    const fd = new FormData();
    fd.set("_action", "updateClassification");
    fd.set("threadId", latest.canonicalThreadId ?? "");
    if (edit.resetIntents) fd.set("resetIntents", "1");
    if (edit.intents) fd.set("intents", JSON.stringify(edit.intents));
    if (edit.orderChange) {
      fd.set("orderChangeType", edit.orderChange.type);
      if (edit.orderChange.type === "candidate") {
        fd.set("orderId", edit.orderChange.orderId);
        fd.set("candidate", JSON.stringify(edit.orderChange.candidate));
      } else if (edit.orderChange.type === "search") {
        fd.set("orderNumber", edit.orderChange.orderNumber);
      }
    }
    classificationFetcher.submit(fd, { method: "post" });
  };

  useEffect(() => {
    if (
      classificationFetcher.state === "idle" &&
      classificationFetcher.data &&
      "classificationUpdated" in classificationFetcher.data &&
      classificationFetcher.data.classificationUpdated &&
      handledClassificationData.current !== classificationFetcher.data
    ) {
      handledClassificationData.current = classificationFetcher.data;
      setEditingClassification(false);
      setShowRegenToast(true);
      // Force the loader to re-run so the open thread's emails / analysis /
      // tracking shown in the detail panel reflect the just-saved edit.
      classificationRevalidator.revalidate();
    }
  }, [classificationFetcher.state, classificationFetcher.data, classificationRevalidator]);

  // Auto-dismiss the regen toast after 8 seconds.
  useEffect(() => {
    if (!showRegenToast) return;
    const id = setTimeout(() => setShowRegenToast(false), 8000);
    return () => clearTimeout(id);
  }, [showRegenToast]);

  const triggerRegenerateDraft = () => {
    const fd = new FormData();
    fd.set("_action", "reanalyze");
    fd.set("emailId", latest.id);
    reanalyzeFetcher.submit(fd, { method: "post" });
    setShowRegenToast(false);
  };

  const analysisEmail = [...emails].reverse().find((e) => e.analysisResult) ?? null;
  const draftEmail = latest.draftReply ? latest : (analysisEmail?.draftReply ? analysisEmail : null);
  const order = analysisEmail?.analysisResult?.order;
  const intents = bucket !== "other" && analysisEmail?.analysisResult
    ? (analysisEmail.analysisResult.intents?.length ? analysisEmail.analysisResult.intents : [analysisEmail.analysisResult.intent])
    : [];

  // Ambiguous order match: orchestrator left `order = null` because the match
  // was too weak (multiple email candidates / name-only). Surface it in the
  // same ⚠ tooltip as other thread-level signals.
  const ambiguousOrderCount =
    !order && (analysisEmail?.analysisResult?.orderCandidates?.length ?? 0) > 1
      ? analysisEmail!.analysisResult!.orderCandidates!.length
      : 0;
  const hasAnySignal = hasSignals || ambiguousOrderCount > 0;

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
          {intents.map((intent) => (
            <span key={intent} className="ui-pill">
              {t(`analysis.intent_${intent}`, { defaultValue: intent.replace(/_/g, " ") })}
            </span>
          ))}
          {threadState?.historyStatus === "partial" && (
            <span
              className="ui-pill ui-pill--warning"
              title={t("inbox.pillPartialHistoryTooltip")}
              style={{ cursor: "help" }}
            >
              {t("inbox.pillPartialHistory")}
            </span>
          )}
          {hasAnySignal && (
            <span
              ref={signalAnchorRef}
              style={{ display: "inline-flex", alignItems: "center" }}
              onMouseEnter={() => setShowSignals(true)}
              onMouseLeave={() => setShowSignals(false)}
            >
              <SignalPill />
              <PortalTooltip open={showSignals} anchor={signalAnchorRef.current}>
                {hasSignals && previousContact.byOrder && <span>{t("inbox.signalPriorContactOrder")}</span>}
                {hasSignals && previousContact.recentReply && <span>{t("inbox.signalRepliedElsewhere")}</span>}
                {ambiguousOrderCount > 0 && (
                  <span>{t("inbox.signalAmbiguousOrder", { count: ambiguousOrderCount })}</span>
                )}
              </PortalTooltip>
            </span>
          )}
          {analysisEmail?.analysisResult && (
            <PencilButton
              onClick={() => setEditingClassification(true)}
              hasOverrides={
                analysisEmail.analysisResult.manualOverrides?.intents !== undefined ||
                analysisEmail.analysisResult.manualOverrides?.order !== undefined
              }
            />
          )}
        </div>

        {/* Row 2 : sender + collapse button */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", marginBottom: "4px" }}>
          <div className="ui-sender-stack" style={{ minWidth: 0 }}>
            <span className="ui-sender-stack__name" style={{ fontWeight: 700, fontSize: "0.9375rem", color: "var(--ui-slate-900)" }}>
              {latest.fromName || latest.fromAddress}
            </span>
            {latest.fromName && (
              <span className="ui-sender-stack__addr" style={{ fontWeight: 400, fontSize: "0.8125rem", color: "var(--ui-slate-500)" }}>
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
        <div className="ui-thread-actions-row">
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
              {!latest.draftReply && latest.processingStatus === "error" && (
                <input type="hidden" name="skipDraft" value="1" />
              )}
              <s-button type="submit" variant="primary" {...(isGenerating ? { loading: true } : {})}>
                {latest.draftReply
                  ? t("inbox.regenerateDraft")
                  : latest.processingStatus === "error"
                  ? t("inbox.retryAnalysis")
                  : bucket === "to_analyze"
                  ? t("inbox.analyze")
                  : t("inbox.generateDraft")}
              </s-button>
            </reanalyzeFetcher.Form>
          )}
          {isGenerating && <span style={{ fontSize: "0.8125rem", color: "var(--ui-slate-500)", alignSelf: "center" }}>{t("inbox.generating")}</span>}
          {(() => {
            const connection = loaderData.connections.find(
              (c) => c.id === latest.mailConnectionId,
            );
            if (!connection || !latest.replyDraftId) return null;
            return (
              <SendButton
                shop={loaderData.shop}
                mailConnectionId={connection.id}
                draftId={latest.replyDraftId}
                customerEmail={latest.fromAddress}
                canSend={connection.canSend}
                reauthUrl={`/app/mail-auth/reauth?mailConnectionId=${connection.id}&returnTo=/app/inbox?thread=${latest.canonicalThreadId ?? ""}`}
                initialSentAt={latest.draftSentAt ?? null}
                disabled={!latest.draftReply}
              />
            );
          })()}
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
      <div className="ui-analysis-grid">
        {/* Left : order context */}
        <div style={{ padding: "16px 18px", borderRight: "1px solid var(--ui-slate-100)" }}>
          <div style={sectionLabel}>{t("inbox.sectionOrderContext")}</div>
          {order ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {([
                [t("inbox.orderCustomer"), order.customerName ?? "—"],
                [t("inbox.orderName"),    order.name],
                [t("inbox.orderItems"),    t("inbox.orderItemsCount", { count: order.lineItems.length })],
                [t("inbox.orderStatus"),   order.displayFulfillmentStatus
                  ? t(`analysis.orderFulfillmentStatus.${order.displayFulfillmentStatus}`, order.displayFulfillmentStatus)
                  : "—"],
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
                <span>{t("inbox.sectionAnalysis")}</span>
                {analysisEmail !== latest && (
                  <span className="ui-pill ui-pill--warning" style={{ fontSize: "10px" }}>{t("inbox.pillBasedOnPrevious")}</span>
                )}
                <PencilButton
                  onClick={() => setEditingClassification(true)}
                  hasOverrides={
                    analysisEmail.analysisResult.manualOverrides?.intents !== undefined ||
                    analysisEmail.analysisResult.manualOverrides?.order !== undefined
                  }
                />
              </div>
              <AnalysisDisplay
                analysis={analysisEmail.analysisResult}
                lastAnalyzedAt={analysisEmail.lastAnalyzedAt}
                threadOperationalState={threadState?.operationalState ?? null}
                onEditOrder={() => setEditingClassification(true)}
              />
            </div>
          )}
        </div>
      </div>

      {editingClassification && analysisEmail?.analysisResult && (
        <ClassificationEditModal
          analysis={analysisEmail.analysisResult}
          onSubmit={submitClassificationEdit}
          onClose={() => setEditingClassification(false)}
          isSubmitting={isSubmittingClassification}
          errorCode={classificationErrorCode}
        />
      )}

      {showRegenToast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            zIndex: 1100,
            background: "#fff",
            border: "1px solid var(--ui-slate-200)",
            borderRadius: "12px",
            boxShadow: "0 12px 32px rgba(15,23,42,0.18)",
            padding: "14px 16px",
            maxWidth: "380px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
            <span style={{ color: "#15803d", fontSize: "16px", lineHeight: 1 }}>✓</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--ui-slate-900)" }}>
                {t("classification.savedToast", "Classification enregistrée")}
              </div>
              <div style={{ fontSize: "12px", color: "var(--ui-slate-600)", marginTop: "2px" }}>
                {t(
                  "classification.regenerateDraftHint",
                  "Pensez à régénérer le draft pour refléter les changements.",
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowRegenToast(false)}
              aria-label={t("common.dismiss", "Fermer")}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--ui-slate-400)",
                fontSize: "18px",
                lineHeight: 1,
                padding: "0 4px",
              }}
            >
              ×
            </button>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={triggerRegenerateDraft}
              disabled={isGenerating}
              style={{
                padding: "6px 12px",
                fontSize: "12px",
                fontWeight: 600,
                border: "1px solid var(--ui-blue-700)",
                borderRadius: "8px",
                background: "var(--ui-blue-600)",
                color: "#fff",
                cursor: isGenerating ? "not-allowed" : "pointer",
                opacity: isGenerating ? 0.6 : 1,
              }}
            >
              {isGenerating
                ? t("inbox.regenerating", "Régénération…")
                : t("classification.regenerateNow", "Régénérer le draft")}
            </button>
          </div>
        </div>
      )}

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
      <QuotaExceededModal
        open={quotaModal.open}
        onClose={() => setQuotaModal({ ...quotaModal, open: false })}
        variant={quotaModal.variant}
        used={quotaModal.used}
        limit={quotaModal.limit}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// "À analyser" tab helpers
// ---------------------------------------------------------------------------

/**
 * Banner-style header for the À analyser tab: short explanation + a "Vider la
 * file" button that bulk-dismisses every thread currently waiting for Tier 3.
 * Submits intent=dismissAnalyzeQueue via a native form so we get React Router
 * revalidation for free; the action sets dismissedFromAnalyzeAt=now on all
 * matching threads.
 */
function ClearAnalyzeQueueButton({ count }: { count: number }) {
  const { t } = useTranslation();
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state === "submitting" || fetcher.state === "loading";

  const onClick = (e: React.MouseEvent) => {
    const ok = window.confirm(t("inbox.clearAnalyzeQueueConfirm", { count }));
    if (!ok) e.preventDefault();
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        background: "#fff7ed",
        border: "1px solid #fed7aa",
        color: "#9a3412",
        borderRadius: 8,
        fontSize: 13.5,
        lineHeight: 1.4,
      }}
    >
      <span style={{ flex: 1, fontWeight: 500 }}>
        {t("inbox.toAnalyzeHint", { count })}
      </span>
      <fetcher.Form method="post">
        <input type="hidden" name="_action" value="dismissAnalyzeQueue" />
        <button
          type="submit"
          onClick={onClick}
          disabled={isSubmitting}
          style={{
            background: "#9a3412",
            color: "white",
            border: "none",
            borderRadius: 6,
            padding: "6px 12px",
            fontSize: 13,
            fontWeight: 600,
            cursor: isSubmitting ? "wait" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {isSubmitting ? "…" : t("inbox.clearAnalyzeQueue")}
        </button>
      </fetcher.Form>
    </div>
  );
}

/**
 * Per-thread "Retirer de la file" button shown on cards in the À analyser tab.
 * Idempotent server-side; submits intent=dismissThreadFromAnalyze with the
 * canonical thread id.
 */
function DismissThreadFromAnalyzeButton({ canonicalThreadId }: { canonicalThreadId: string }) {
  const { t } = useTranslation();
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state === "submitting" || fetcher.state === "loading";
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="_action" value="dismissThreadFromAnalyze" />
      <input type="hidden" name="canonicalThreadId" value={canonicalThreadId} />
      <button
        type="submit"
        disabled={isSubmitting}
        title={t("inbox.dismissFromAnalyzeQueueTitle")}
        style={{
          background: "transparent",
          color: "#475569",
          border: "1px solid #cbd5e1",
          borderRadius: 6,
          padding: "6px 10px",
          fontSize: 12,
          fontWeight: 500,
          cursor: isSubmitting ? "wait" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {isSubmitting ? "…" : t("inbox.dismissFromAnalyzeQueue")}
      </button>
    </fetcher.Form>
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
  // Poll every 5s while a heavy job is running, otherwise every 60s.
  useEffect(() => {
    const interval = bgSyncActive ? 5_000 : 60_000;
    const poll = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, interval);
    return () => clearInterval(poll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgSyncActive]);

  // Initial bucket selection can be driven by the URL (e.g. dashboard
  // links: /app/inbox?bucket=resolved). Keep state local afterwards so
  // tab clicks stay snappy without pushing a history entry per click.
  type BucketKey = OpsBucket | "all" | "to_handle";
  const validBuckets = new Set<BucketKey>([
    "all", "to_handle", "to_process", "to_analyze", "waiting_customer", "waiting_merchant", "resolved", "other",
  ]);
  const initialBucket = (() => {
    if (typeof window === "undefined") return "to_handle";
    const fromUrl = new URLSearchParams(window.location.search).get("bucket") as BucketKey | null;
    return fromUrl && validBuckets.has(fromUrl) ? fromUrl : "to_handle";
  })();
  const [activeBucket, setActiveBucket] = useState<BucketKey>(initialBucket);
  const [filters, setFilters] = useState<InboxFilters>({
    search: "",
    orderLinked: "any",
    nature: "all",
    intent: "",
  });
  const isMobile = useMobile();

  // The expanded thread id lives in the URL (?thread=<id>) so that the
  // device/browser back button naturally closes the detail view on mobile
  // and bookmarks/refreshes preserve the open thread on desktop.
  const [searchParams, setSearchParams] = useSearchParams();
  const expandedThreadId = searchParams.get("thread");

  const setExpandedThreadId = useCallback((threadId: string | null) => {
    startTransition(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (threadId === null) next.delete("thread");
          else next.set("thread", threadId);
          return next;
        },
        { preventScrollReset: true },
      );
    });
  }, [setSearchParams]);

  // Toggle helper: stable identity (no `expandedThreadId` dep) so memoized
  // ThreadCards don't re-render on every selection change. Reads the current
  // value via `setSearchParams`'s functional updater.
  const toggleExpandedThreadId = useCallback((threadId: string) => {
    startTransition(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (next.get("thread") === threadId) next.delete("thread");
          else next.set("thread", threadId);
          return next;
        },
        { preventScrollReset: true },
      );
    });
  }, [setSearchParams]);

  const handleOrderClick = useCallback((orderNumber: string) => {
    setFilters((prev) => ({ ...prev, search: orderNumber }));
  }, []);

  const handleFilterClick = useCallback((patch: Partial<InboxFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleBucketClick = useCallback((bucket: OpsBucket | "to_handle") => {
    setActiveBucket(bucket);
  }, []);

  // Save list scroll on mobile when opening a thread, restore when closing.
  const savedScrollRef = useRef(0);
  const prevThreadIdRef = useRef<string | null>(expandedThreadId);
  useEffect(() => {
    if (!isMobile) {
      prevThreadIdRef.current = expandedThreadId;
      return;
    }
    const prev = prevThreadIdRef.current;
    if (prev === null && expandedThreadId !== null) {
      // Just opened on mobile: scroll to top so user sees the back button.
      savedScrollRef.current = window.scrollY || document.documentElement.scrollTop || 0;
      requestAnimationFrame(() => window.scrollTo(0, 0));
    } else if (prev !== null && expandedThreadId === null && savedScrollRef.current > 0) {
      // Just closed on mobile: restore the list scroll position.
      const target = savedScrollRef.current;
      savedScrollRef.current = 0;
      requestAnimationFrame(() => window.scrollTo(0, target));
    }
    prevThreadIdRef.current = expandedThreadId;
  }, [isMobile, expandedThreadId]);

  const closeMobileThread = () => setExpandedThreadId(null);

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

  const threads = useMemo(() => groupByThread(displayEmails), [displayEmails]);

  // Precompute each thread's bucket + classification once for reuse in
  // counts and filtering. Cheaper than calling the helpers repeatedly.
  // Memoized so 100+ threads aren't re-derived on every unrelated state change.
  const threadMeta = useMemo(
    () =>
      threads.map((t) => {
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
            byOrder: pc?.byOrder ?? false,
            recentReply: pc?.recentReply ?? false,
          },
        };
      }),
    [threads, loaderData.threadStates, loaderData.priorContact, loaderData.connectedEmail],
  );

  const bucketCounts: Record<OpsBucket | "all" | "to_handle", number> = {
    all: threadMeta.length,
    to_handle: threadMeta.filter((m) => m.bucket === "to_process" || m.bucket === "waiting_merchant").length,
    to_process: threadMeta.filter((m) => m.bucket === "to_process").length,
    to_analyze: threadMeta.filter((m) => m.bucket === "to_analyze").length,
    waiting_customer: threadMeta.filter((m) => m.bucket === "waiting_customer").length,
    waiting_merchant: threadMeta.filter((m) => m.bucket === "waiting_merchant").length,
    resolved: threadMeta.filter((m) => m.bucket === "resolved").length,
    other: threadMeta.filter((m) => m.bucket === "other").length,
  };

  // Selected thread for the right-side detail panel (searched across ALL threads,
  // not just filtered, so the panel stays open when filters change). Tombstoned
  // threads have no content to show and are never selectable.
  const selectedThreadMeta = expandedThreadId
    ? threadMeta.find(
        (m) => m.thread.threadId === expandedThreadId && !m.state?.redactedAt,
      ) ?? null
    : null;

  // On mobile: full-screen detail view replaces the list
  if (isMobile && selectedThreadMeta) {
    return (
      <div className="ui-inbox-root">
        <div style={{ marginBottom: "12px" }}>
          <button
            type="button"
            onClick={closeMobileThread}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "14px",
              fontWeight: 500,
              color: "var(--ui-slate-700)",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "10px 4px",
              minHeight: "44px",
            }}
          >
            ← {t("inbox.backToList")}
          </button>
        </div>
        <ThreadDetailPanel
          thread={selectedThreadMeta.thread}
          threadState={selectedThreadMeta.state}
          connectedEmail={loaderData.connectedEmail}
          bucket={selectedThreadMeta.bucket}
          previousContact={selectedThreadMeta.previousContact}
          onClose={closeMobileThread}
        />
      </div>
    );
  }

  const matchesFilters = (m: (typeof threadMeta)[number]): boolean => {
    if (filters.intent !== "") {
      const analysis = [...m.thread.emails].reverse().find(e => e.analysisResult)?.analysisResult;
      const threadIntents = analysis ? (analysis.intents?.length ? analysis.intents : [analysis.intent]) : [];
      if (!threadIntents.includes(filters.intent as SupportAnalysisExtended["intent"])) return false;
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
      const analysis = [...m.thread.emails].reverse().find(e => e.analysisResult)?.analysisResult;
      return analysis ? (analysis.intents?.length ? analysis.intents : [analysis.intent]) : [];
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
        <div className="ui-inbox-heading"><h1>{t("nav.emailInbox")}</h1></div>
        <s-section>
          <s-banner tone="success">
            {t("inbox.disconnected")}
          </s-banner>
        </s-section>
      </div>
    );
  }

  return (
    <div className="ui-inbox-root">
      {/* SyncSuspendedBanner moved to the app-shell top strip (app.tsx) so it
          aligns with TrialBanner / QuotaBanner on the right edge. */}
      <div className="ui-inbox-heading" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>{t("nav.emailInbox")}</h1>
        <MailboxIndicator connections={loaderData.connections} />
      </div>

      {/* Safety bypass banner: shown when SEND_DISABLED_FOR_INTERNAL=true on an internal shop */}
      {loaderData.sendDisabled && (
        <div style={{
          padding: "10px 16px", background: "#fff3cd", border: "1px solid #ffeeba",
          borderRadius: 6, marginBottom: 16, color: "#856404", fontFamily: "system-ui",
        }}>
          🧪 {t("inbox.send.internal_banner")}
        </div>
      )}

      {/* Onboarding checklist (auto-hides when dismissed or complete) */}
      <div className="ui-inbox-section">
        <OnboardingChecklist
          state={loaderData.onboardingChecklist.state}
          dismissed={loaderData.onboardingChecklist.dismissed}
        />
      </div>

      {/* Connection */}
      <div className="ui-inbox-section">
        <ConnectionCard
          connected={loaderData.connected}
          connectionId={loaderData.connectionId}
          provider={loaderData.provider}
          connectedEmail={loaderData.connectedEmail}
          lastSyncAt={loaderData.lastSyncAt}
          gmailAuthUrl={loaderData.gmailAuthUrl}
          zohoAuthUrl={loaderData.zohoAuthUrl}
          outlookAuthUrl={loaderData.outlookAuthUrl}
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
              <s-text>Le traitement des emails et la mise à jour des badges peuvent prendre quelques minutes. La page se rafraîchit automatiquement toutes les 5 secondes.</s-text>
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
              {/* Primary tabs.
                  "À analyser" appears between "À traiter" and "Attente client"
                  only when there are unanalyzed support threads (typically
                  accumulated while the shop was suspended). Hidden otherwise
                  to keep the UI quiet on healthy plans. */}
              <SegmentedTabs
                tabs={[
                  { key: "to_handle", label: t("inbox.bucketToHandle"), count: bucketCounts.to_handle },
                  ...(bucketCounts.to_analyze > 0
                    ? [{ key: "to_analyze" as const, label: t("inbox.bucketToAnalyze"), count: bucketCounts.to_analyze, countTone: "warning" as const }]
                    : []),
                  { key: "waiting_customer", label: t("inbox.bucketWaitingCustomer"), count: bucketCounts.waiting_customer },
                  { key: "resolved", label: t("inbox.bucketResolved"), count: bucketCounts.resolved },
                  { key: "other", label: t("inbox.bucketOther"), count: bucketCounts.other },
                  { key: "all", label: t("inbox.bucketAll"), count: bucketCounts.all },
                ]}
                active={activeBucket}
                onChange={(k) => setActiveBucket(k)}
              />

              {/* Bulk "Vider la file" button — only shown in À analyser tab */}
              {activeBucket === "to_analyze" && bucketCounts.to_analyze > 0 && (
                <ClearAnalyzeQueueButton count={bucketCounts.to_analyze} />
              )}

              {/* Secondary filters + mailbox filter */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
                <MailboxFilter
                  connections={loaderData.connections}
                  countsByMailbox={loaderData.threadCountsByMailbox}
                  totalCount={Object.values(loaderData.threadCountsByMailbox).reduce((a, b) => a + b, 0)}
                />
              </div>

              {/* Thread list + detail split.
                  IMPORTANT: use `minmax(0, 1fr)` instead of `1fr` even in the
                  single-column branch — bare `1fr` resolves to
                  `minmax(auto, 1fr)`, and a track's `auto` minimum is the
                  intrinsic min-content of its items. The thread cards contain
                  a `white-space: nowrap` subject line whose min-content is the
                  full subject width, which would blow the column out past the
                  viewport on narrow mobile screens (the original "cards
                  overflow horizontally on mobile" bug). */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: selectedThreadMeta
                    ? "minmax(0, 1fr) minmax(0, 2fr)"
                    : "minmax(0, 1fr)",
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
                  {filteredThreadMeta.map(({ thread, state, previousContact }) => {
                    const mailConn = loaderData.connections.find(
                      (c) => c.id === thread.latest.mailConnectionId,
                    );
                    return state?.redactedAt ? (
                      <TombstoneCard
                        key={thread.threadId}
                        redactedAt={state.redactedAt}
                        reason={state.redactedReason}
                      />
                    ) : (
                      <div key={thread.threadId} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {mailConn && loaderData.connections.length > 1 && (
                          <div>
                            <MailboxBadge
                              email={mailConn.email}
                              provider={mailConn.provider}
                              paused={!mailConn.autoSyncEnabled}
                            />
                          </div>
                        )}
                        <ThreadCard
                          thread={thread}
                          threadState={state}
                          isSelected={expandedThreadId === thread.threadId}
                          connectedEmail={loaderData.connectedEmail}
                          previousContact={previousContact}
                          onSelect={toggleExpandedThreadId}
                          onOrderClick={handleOrderClick}
                          onFilterClick={handleFilterClick}
                          onBucketClick={handleBucketClick}
                        />
                      </div>
                    );
                  })}
                </div>

                {/* Right: thread detail panel (sticky).
                    alignSelf: stretch makes this grid cell as tall as the
                    LEFT column (the thread list). Without it, the cell
                    only takes the panel's intrinsic height, giving sticky
                    zero scroll range and making the panel disappear once
                    the list scrolls past its bottom. The previous 100vh
                    spacer hack only worked when the list was ≤ 100vh tall. */}
                {selectedThreadMeta && (
                  <div style={{ alignSelf: "stretch" }}>
                    <div className="ui-detail-panel">
                      <ThreadDetailPanel
                        thread={selectedThreadMeta.thread}
                        threadState={selectedThreadMeta.state}
                        connectedEmail={loaderData.connectedEmail}
                        bucket={selectedThreadMeta.bucket}
                        previousContact={selectedThreadMeta.previousContact}
                        onClose={() => setExpandedThreadId(null)}
                      />
                    </div>
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
