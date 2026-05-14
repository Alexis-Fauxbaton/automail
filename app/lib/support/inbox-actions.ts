import prisma from "../../db.server";
import { deleteConnection } from "../gmail/auth";
import {
  reanalyzeEmail,
  redraftEmail,
  processNewEmails,
  getMailClient,
  persistEmailAttachments,
} from "../gmail/pipeline";
import { refineDraft } from "../gmail/refine-draft";
import { buildRefineContext } from "./refine-context";
import { runDiagnosis } from "../gmail/diagnose";
import { enqueueJob } from "../mail/job-queue";
import { recordStateTransition } from "./thread-state-history";
import { isAnalysisStale, ANALYSIS_FRESHNESS_MS, refreshStaleAnalysesForShop } from "./refresh-stale-analyses";
import type { AdminGraphqlClient } from "./shopify/order-search";
import type { ClassificationEdit } from "./manual-classification";
import { withDraftQuota } from "../billing/draft-guard";
import { resolveEntitlements } from "../billing/entitlements";

async function maybeRefreshAnalysis(
  emailId: string,
  admin: AdminGraphqlClient,
  shop: string,
): Promise<void> {
  if (!emailId) return;
  const record = await prisma.incomingEmail.findUnique({
    where: { id: emailId },
    select: { shop: true, lastAnalyzedAt: true, processingStatus: true },
  });
  if (!record || record.shop !== shop) return;
  if (record.processingStatus !== "analyzed") return;
  if (!isAnalysisStale(record.lastAnalyzedAt, ANALYSIS_FRESHNESS_MS.draftTrigger)) return;
  try {
    await reanalyzeEmail(emailId, admin, shop);
  } catch (err) {
    console.error(`[inbox] auto-reanalyze before draft failed for email=${emailId}:`, err);
  }
}

export async function handleDisconnect(params: { shop: string }) {
  await deleteConnection(params.shop);
  return { disconnected: true, report: null, reanalyzed: null, refined: null, stopped: false };
}

export async function handleStop(params: { shop: string }) {
  await prisma.mailConnection.update({
    where: { shop: params.shop },
    data: { syncCancelledAt: new Date() },
  });
  return { stopped: true, report: null, disconnected: false, reanalyzed: null, refined: null };
}

export async function handleResync(params: { shop: string }) {
  const { shop } = params;
  // Audit log — destructive operation. We capture every resync so a
  // misclick that wipes ingested email history can be traced. The log is
  // intentionally a structured `console.warn` so it ships to whatever log
  // sink is wired in production (Render, Datadog, etc.) without requiring
  // a new DB table.
  const startedAt = new Date().toISOString();
  console.warn(
    `[audit] resync shop=${shop} startedAt=${startedAt} action=delete-all-incoming-emails`,
  );
  const engagedThreads = await prisma.incomingEmail.findMany({
    where: { shop, replyDraft: { isNot: null } },
    select: { canonicalThreadId: true },
  });
  const engagedThreadIds = Array.from(
    new Set(
      engagedThreads
        .map((e) => e.canonicalThreadId)
        .filter((id): id is string => id !== null),
    ),
  );

  // Snapshot manual overrides (intent / order picks the user explicitly
  // made) onto Thread BEFORE wiping IncomingEmail rows — they live inside
  // `analysisResult` JSON which is about to be deleted. The next analysis
  // pass on each thread will restore them.
  try {
    const { snapshotManualOverridesForShop } = await import("./preserved-overrides");
    const n = await snapshotManualOverridesForShop(shop);
    if (n > 0) {
      console.log(`[resync] shop=${shop} snapshotted manualOverrides for ${n} thread(s)`);
    }
  } catch (err) {
    console.error("[resync] manual-overrides snapshot failed:", err);
    // Continue — losing overrides is bad UX but not a blocker for resync.
  }

  await prisma.incomingEmail.deleteMany({ where: { shop } });
  await prisma.thread.updateMany({
    where: {
      shop,
      supportNature: { in: ["needs_review", "probable_support", "confirmed_support", "mixed"] },
      previousOperationalState: null,
      id: { notIn: engagedThreadIds },
    },
    data: { supportNature: "unknown" },
  });
  await prisma.mailConnection.update({
    where: { shop },
    data: { historyId: null, lastSyncAt: null, onboardingBackfillDoneAt: null },
  });
  await enqueueJob(shop, "resync");
  return { syncStarted: true, report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
}

export async function handleReclassify(params: { shop: string }) {
  await enqueueJob(params.shop, "reclassify");
  return { syncStarted: true, report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
}

export async function handleSync(params: { shop: string; admin: AdminGraphqlClient }) {
  const { shop, admin } = params;
  const report = await processNewEmails(shop, admin);
  const staleRefresh = await refreshStaleAnalysesForShop(shop, admin, {
    maxAgeMs: ANALYSIS_FRESHNESS_MS.autoRefresh,
  });
  return { report, syncCompleted: true, disconnected: false, reanalyzed: null, refined: null, stopped: false, staleRefresh };
}

export async function handleBackfill(params: { shop: string; days: number }) {
  const { shop, days } = params;
  const afterDate = new Date(Date.now() - Math.max(1, days) * 24 * 3600_000);
  await enqueueJob(shop, "backfill", {
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

export async function handleToggleAutoSync(params: { shop: string; enable: boolean }) {
  await prisma.mailConnection.update({
    where: { shop: params.shop },
    data: { autoSyncEnabled: params.enable },
  });
  return { report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
}

export async function handleDiagnose(params: { shop: string }) {
  const diagnosis = await runDiagnosis(params.shop);
  return { diagnosis, report: null, disconnected: false, reanalyzed: null, refined: null };
}

export async function handleReanalyze(params: {
  shop: string;
  admin: AdminGraphqlClient;
  emailId: string;
  skipDraft: boolean;
}) {
  const { shop, admin, emailId, skipDraft } = params;

  // skipDraft=true → analysis only, no quota consumed (refresh stale, error retry).
  // skipDraft=false → analysis + draft generated → 1 unit consumed, must be gated.
  if (!skipDraft) {
    const ent = await resolveEntitlements({ shop, admin });
    if (!ent.canGenerateDraft) {
      return {
        reanalyzed: null,
        report: null,
        disconnected: false,
        refined: null,
        quotaExceeded: true,
        quotaStatus: { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit },
      };
    }

    const guarded = await withDraftQuota({
      shop,
      limit: ent.quotaStatus.limit,
      generator: () => reanalyzeEmail(emailId, admin, shop, { skipDraft: false }),
    });

    if (!guarded.ok) {
      if (guarded.reason === 'quota_exceeded') {
        return {
          reanalyzed: null,
          report: null,
          disconnected: false,
          refined: null,
          quotaExceeded: true,
          quotaStatus: { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit },
        };
      }
      throw guarded.error ?? new Error('Reanalyze with draft generation failed');
    }

    return {
      reanalyzed: { emailId, analysis: guarded.value },
      report: null,
      disconnected: false,
      refined: null,
      quotaStatus: { used: guarded.newCount, limit: ent.quotaStatus.limit },
    };
  }

  // skipDraft=true path: analysis only, no quota gating.
  const analysis = await reanalyzeEmail(emailId, admin, shop, { skipDraft: true });
  if (analysis) {
    (analysis as { draftReply?: string }).draftReply = undefined;
  }
  return { reanalyzed: { emailId, analysis }, report: null, disconnected: false, refined: null };
}

export async function handleRedraft(params: {
  shop: string;
  admin: AdminGraphqlClient;
  emailId: string;
}) {
  const { shop, admin, emailId } = params;

  const ent = await resolveEntitlements({ shop, admin });
  if (!ent.canGenerateDraft) {
    return {
      reanalyzed: null,
      report: null,
      disconnected: false,
      refined: null,
      quotaExceeded: true,
      quotaStatus: { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit },
    };
  }

  await maybeRefreshAnalysis(emailId, admin, shop);

  const guarded = await withDraftQuota({
    shop,
    limit: ent.quotaStatus.limit,
    generator: () => redraftEmail(emailId, shop),
  });

  if (!guarded.ok) {
    if (guarded.reason === 'quota_exceeded') {
      return {
        reanalyzed: null,
        report: null,
        disconnected: false,
        refined: null,
        quotaExceeded: true,
        quotaStatus: { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit },
      };
    }
    throw guarded.error ?? new Error('Draft generation failed');
  }

  return {
    reanalyzed: null,
    report: null,
    disconnected: false,
    refined: null,
    quotaStatus: { used: guarded.newCount, limit: ent.quotaStatus.limit },
  };
}

export async function handleRefreshEmailHtml(params: {
  shop: string;
  emailId: string;
}) {
  const { shop, emailId } = params;
  const record = await prisma.incomingEmail.findUnique({
    where: { id: emailId },
    select: { shop: true, externalMessageId: true },
  });
  if (!record || record.shop !== shop) {
    return { report: null, disconnected: false, reanalyzed: null, refined: null };
  }
  const conn = await prisma.mailConnection.findUnique({ where: { shop } });
  if (!conn) return { report: null, disconnected: false, reanalyzed: null, refined: null };
  try {
    const client = await getMailClient(shop, conn.provider);
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
      await persistEmailAttachments(emailId, shop, conn.provider, record.externalMessageId, msgAttachments);
    }
    console.log(`[refresh_email_html] done email=${emailId}`);
  } catch (err) {
    console.error("[refresh_email_html] failed:", err);
  }
  return { report: null, disconnected: false, reanalyzed: null, refined: null };
}

export async function handleRefine(params: {
  shop: string;
  admin: AdminGraphqlClient;
  emailId: string;
  instructions: string;
  currentDraft: string;
}) {
  const { shop, admin, emailId, instructions, currentDraft } = params;
  const record = await prisma.incomingEmail.findUnique({ where: { id: emailId } });
  if (!record || record.shop !== shop || !currentDraft || !instructions) {
    return { report: null, disconnected: false, reanalyzed: null, refined: null };
  }

  const ent = await resolveEntitlements({ shop, admin });
  if (!ent.canGenerateDraft) {
    return {
      report: null,
      disconnected: false,
      reanalyzed: null,
      refined: null,
      quotaExceeded: true,
      quotaStatus: { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit },
    };
  }

  await maybeRefreshAnalysis(emailId, admin, shop);

  // Reload AFTER the refresh so we see fresh analysisResult.
  const fresh = await prisma.incomingEmail.findUnique({
    where: { id: emailId },
    select: { analysisResult: true },
  });
  let contextSummary: string | undefined;
  if (fresh?.analysisResult) {
    try {
      const analysis = JSON.parse(fresh.analysisResult);
      contextSummary = buildRefineContext(analysis) ?? undefined;
    } catch (err) {
      console.error(`[refine] malformed analysisResult for email=${emailId}:`, err);
    }
  }

  const guarded = await withDraftQuota({
    shop,
    limit: ent.quotaStatus.limit,
    generator: async () => {
      const newDraft = await refineDraft(currentDraft, instructions, {
        subject: record.subject,
        body: record.bodyText,
        contextSummary,
      }, {
        shop,
        emailId,
        threadId: record.threadId,
      });
      const { upsertReplyDraftBody } = await import("./reply-draft");
      await upsertReplyDraftBody(emailId, shop, newDraft);
      const updatedRD = await prisma.replyDraft.findUnique({
        where: { emailId },
        select: { bodyHistory: true },
      });
      const history = Array.isArray(updatedRD?.bodyHistory)
        ? (updatedRD!.bodyHistory as string[])
        : [];
      return { newDraft, history };
    },
  });

  if (!guarded.ok) {
    if (guarded.reason === 'quota_exceeded') {
      return {
        report: null,
        disconnected: false,
        reanalyzed: null,
        refined: null,
        quotaExceeded: true,
        quotaStatus: { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit },
      };
    }
    throw guarded.error ?? new Error('Draft refine failed');
  }

  return {
    refined: { emailId, newDraft: guarded.value.newDraft, draftHistory: guarded.value.history },
    report: null,
    disconnected: false,
    reanalyzed: null,
    quotaStatus: { used: guarded.newCount, limit: ent.quotaStatus.limit },
  };
}

export async function handleMoveThread(params: {
  shop: string;
  canonicalThreadId: string;
  target: string;
  admin: AdminGraphqlClient;
}) {
  const { shop, canonicalThreadId, target, admin } = params;
  const ALLOWED_STATES = new Set([
    "waiting_merchant",
    "waiting_customer",
    "resolved",
  ]);
  if (!canonicalThreadId || !ALLOWED_STATES.has(target)) {
    return { report: null, disconnected: false, reanalyzed: null, refined: null };
  }
  const forceSupport = target === "waiting_merchant" || target === "waiting_customer";
  const thread = await prisma.thread.findUnique({
    where: { id: canonicalThreadId },
    select: { shop: true, supportNature: true, operationalState: true },
  });
  if (!thread || thread.shop !== shop) {
    return { report: null, disconnected: false, reanalyzed: null, refined: null };
  }
  const previousOperationalState =
    target === "resolved" ? (thread.operationalState ?? null) : null;
  const isReopen = thread.operationalState === "resolved" && target !== "resolved";
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
    shop,
    threadId: canonicalThreadId,
    fromState: thread.operationalState ?? null,
    toState: target,
  });

  // On reopen, refresh tracking + crawl on the thread anchor immediately.
  // Resolved threads skip those steps during auto-sync (orchestrator's
  // skipTracking flag), so without this hook a freshly-reopened thread
  // would show stale tracking until the next refresh-stale tick (~1h).
  if (isReopen) {
    try {
      const anchor = await prisma.incomingEmail.findFirst({
        where: { canonicalThreadId, shop, processingStatus: "analyzed" },
        orderBy: { receivedAt: "desc" },
        select: { id: true },
      });
      if (anchor) {
        const { refreshThreadAnalysis } = await import("./refresh-thread-analysis");
        // reSearchOrder: true — the previous analysis (taken while resolved)
        // had `orderCandidates: []` because Shopify search was skipped. We
        // must force a fresh search; otherwise reuseOrder would replay the
        // empty result.
        await refreshThreadAnalysis(anchor.id, admin, shop, {
          reclassifyIntent: false,
          reSearchOrder: true,
          refreshTracking: true,
        });
      }
    } catch (err) {
      console.error("[moveThread] reopen refresh failed:", err);
    }
  }

  return { movedThread: { canonicalThreadId, target }, report: null, disconnected: false, reanalyzed: null, refined: null };
}

export async function handleEditThreadIdentifiers(params: {
  shop: string;
  canonicalThreadId: string;
  resolvedOrderNumber: string | null;
  resolvedTrackingNumber: string | null;
  resolvedEmail: string | null;
  resolvedCustomerName: string | null;
}) {
  const { shop, canonicalThreadId, resolvedOrderNumber, resolvedTrackingNumber, resolvedEmail, resolvedCustomerName } = params;
  if (!canonicalThreadId) {
    return { report: null, disconnected: false, reanalyzed: null, refined: null };
  }
  const thread = await prisma.thread.findUnique({
    where: { id: canonicalThreadId },
    select: { shop: true },
  });
  if (!thread || thread.shop !== shop) {
    return { report: null, disconnected: false, reanalyzed: null, refined: null };
  }
  await prisma.thread.update({
    where: { id: canonicalThreadId },
    data: {
      resolvedOrderNumber,
      resolvedTrackingNumber,
      resolvedEmail,
      resolvedCustomerName,
      resolutionConfidence: "high",
    },
  });
  return { editedThread: { canonicalThreadId }, report: null, disconnected: false, reanalyzed: null, refined: null };
}

export async function handleUpdateClassification(params: {
  shop: string;
  admin: AdminGraphqlClient;
  threadId: string;
  edit: ClassificationEdit;
  orderChangeType: string;
  orderId?: string;
  candidateJson?: string;
  orderNumber?: string;
}) {
  const { shop, admin, threadId, orderChangeType } = params;
  if (!threadId) {
    return {
      classificationError: "missing_thread_id",
      report: null,
      disconnected: false,
      reanalyzed: null,
      refined: null,
    };
  }

  const edit = { ...params.edit };

  try {
    if (orderChangeType === "candidate") {
      const { orderId = "", candidateJson = "" } = params;
      const candidate = candidateJson ? JSON.parse(candidateJson) : null;
      if (!candidate || candidate.id !== orderId) {
        return {
          classificationError: "candidate_mismatch",
          report: null,
          disconnected: false,
          reanalyzed: null,
          refined: null,
        };
      }
      edit.order = candidate;
    } else if (orderChangeType === "search") {
      const { searchOrderByExactNumber } = await import("./manual-classification");
      const number = params.orderNumber ?? "";
      const result = await searchOrderByExactNumber(admin, number);
      if (result.kind === "not_found") {
        return {
          classificationError: "order_not_found",
          report: null,
          disconnected: false,
          reanalyzed: null,
          refined: null,
        };
      }
      if (result.kind === "ambiguous") {
        return {
          classificationError: "order_ambiguous",
          report: null,
          disconnected: false,
          reanalyzed: null,
          refined: null,
        };
      }
      edit.order = result.order;
    } else if (orderChangeType === "detach") {
      edit.detachOrder = true;
    } else if (orderChangeType === "reset") {
      edit.resetOrder = true;
    }

    const { persistClassificationEdit } = await import("./manual-classification");
    const persisted = await persistClassificationEdit({
      shop,
      threadId,
      edit,
    });
    let analysis = persisted.analysis;

    const orderTouched =
      orderChangeType === "candidate" ||
      orderChangeType === "search" ||
      orderChangeType === "detach" ||
      orderChangeType === "reset";
    const isReset = orderChangeType === "reset";
    if (orderTouched) {
      try {
        const { refreshThreadAnalysis } = await import("./refresh-thread-analysis");
        // On reset: re-derive order from scratch (reSearchOrder=true) and
        // re-classify intent if the user also asked to reset intents.
        analysis = await refreshThreadAnalysis(
          persisted.emailId,
          admin,
          shop,
          {
            reclassifyIntent: isReset && edit.resetIntents === true,
            reSearchOrder: isReset,
            refreshTracking: true,
          },
        ) as typeof analysis;
      } catch (err) {
        console.error("[updateClassification] tracking refresh failed:", err);
      }

      const finalOrderNumber = analysis.order?.name?.replace(/^#/, "") ?? null;
      await prisma.thread.update({
        where: { id: threadId },
        data: { resolvedOrderNumber: finalOrderNumber },
      }).catch((err) => {
        console.error("[updateClassification] thread sync after refresh failed:", err);
      });
    }

    return {
      classificationUpdated: analysis,
      report: null,
      disconnected: false,
      reanalyzed: null,
      refined: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return {
      classificationError: message,
      report: null,
      disconnected: false,
      reanalyzed: null,
      refined: null,
    };
  }
}
