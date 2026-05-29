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
import { resolveEntitlements } from "../billing/entitlements";
import { getUsage } from "../billing/usage";
import { refineContextRefreshTotal } from "../metrics/definitions";
import { checkLlmRateLimit } from "../llm-rate-limit";

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
  // Gate on entitlements: a refresh still hits Shopify Admin + 17track, and
  // on a suspended account we must not subsidise those calls. The merchant
  // sees the slightly-stale analysis instead — it will refresh naturally
  // after they upgrade.
  try {
    const ent = await resolveEntitlements({ shop, admin });
    if (!ent.canGenerateDraft) return;
  } catch {
    // Fail-open on entitlement lookup glitches — the refresh is best-effort
    // anyway, and blocking it on a transient Shopify outage would degrade UX
    // for paying merchants without protecting much spend.
  }
  try {
    // Lightweight refresh: Shopify + 17track, no LLM. The intent stays
    // intact (the customer's message hasn't changed), only the order /
    // tracking facts are re-fetched in case Shopify-side state drifted
    // (e.g. order shipped between two refines).
    const { refreshThreadAnalysis } = await import("./refresh-thread-analysis");
    await refreshThreadAnalysis(emailId, admin, shop, {
      reclassifyIntent: false,
      reSearchOrder: true,
      refreshTracking: true,
    });
  } catch (err) {
    console.error(`[inbox] auto-refresh before draft failed for email=${emailId}:`, err);
  }
}

export async function handleDisconnect(params: {
  shop: string;
  mailConnectionId: string;
}) {
  await deleteConnection({ shop: params.shop, mailConnectionId: params.mailConnectionId });
  return { disconnected: true, report: null, reanalyzed: null, refined: null, stopped: false };
}

export async function handleStop(params: { shop: string; mailConnectionId: string }) {
  await prisma.mailConnection.update({
    where: { id: params.mailConnectionId, shop: params.shop },
    data: { syncCancelledAt: new Date() },
  });
  return { stopped: true, report: null, disconnected: false, reanalyzed: null, refined: null };
}

export async function handleResync(params: {
  shop: string;
  mailConnectionId: string;
}) {
  const { shop, mailConnectionId } = params;
  // Audit log — destructive operation. We capture every resync so a
  // misclick that wipes ingested email history can be traced. The log is
  // intentionally a structured `console.warn` so it ships to whatever log
  // sink is wired in production (Render, Datadog, etc.) without requiring
  // a new DB table.
  const startedAt = new Date().toISOString();
  console.warn(
    `[audit] resync shop=${shop} mailConnectionId=${mailConnectionId} startedAt=${startedAt} action=delete-incoming-emails-and-reset-cursor`,
  );

  // Snapshot manual overrides (intent / order picks the user explicitly
  // made) onto Thread BEFORE wiping IncomingEmail rows — they live inside
  // `analysisResult` JSON which is about to be deleted. The next analysis
  // pass on each thread will restore them. Scoped to this mailbox only.
  try {
    const { snapshotManualOverridesForMailbox } = await import("./preserved-overrides");
    const n = await snapshotManualOverridesForMailbox(shop, mailConnectionId);
    if (n > 0) {
      console.log(`[resync] shop=${shop} mailConnectionId=${mailConnectionId} snapshotted manualOverrides for ${n} thread(s)`);
    }
  } catch (err) {
    console.error("[resync] manual-overrides snapshot failed:", err);
    // Continue — losing overrides is bad UX but not a blocker for resync.
  }

  // Threads with a draft are "engaged" — never reset their supportNature, the
  // merchant has acted on them.
  const engagedThreads = await prisma.incomingEmail.findMany({
    where: { shop, mailConnectionId, replyDraft: { isNot: null } },
    select: { canonicalThreadId: true },
  });
  const engagedThreadIds = Array.from(
    new Set(
      engagedThreads
        .map((e) => e.canonicalThreadId)
        .filter((id): id is string => id !== null),
    ),
  );

  // Scoped to this mailbox only — other mailboxes' IncomingEmail rows are untouched.
  await prisma.incomingEmail.deleteMany({ where: { shop, mailConnectionId } });

  // Reset supportNature for this mailbox's classified-but-not-engaged threads —
  // re-classification will repopulate on the next ingest pass.
  await prisma.thread.updateMany({
    where: {
      shop,
      mailConnectionId,
      supportNature: { in: ["needs_review", "probable_support", "confirmed_support", "mixed"] },
      previousOperationalState: null,
      id: { notIn: engagedThreadIds },
    },
    data: { supportNature: "unknown" },
  });

  await prisma.mailConnection.update({
    where: { id: mailConnectionId },
    data: {
      historyId: null,
      // Outlook's incremental cursor lives in its own column. Without
      // clearing it, getSyncCursor() on the next tick returns the pre-resync
      // delta link, which then gets written back into historyId and 410s on
      // the following sync — wasting a tick and an API roundtrip.
      deltaToken: null,
      lastSyncAt: null,
      onboardingBackfillDoneAt: null,
    },
  });

  await enqueueJob({ shop, kind: "resync", mailConnectionId });
  return { syncStarted: true, report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
}

export async function handleReclassify(params: { shop: string }) {
  await enqueueJob({ shop: params.shop, kind: "reclassify" });
  return { syncStarted: true, report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
}

/**
 * Bulk-dismiss every thread currently visible in the "À analyser" tab.
 * Sets `dismissedFromAnalyzeAt = now` on threads matching the same filter
 * used by the inbox loader (support stance + analyzedAt null + not resolved).
 * Idempotent: re-dismissing an already-dismissed thread is a no-op (whereIs
 * `dismissedFromAnalyzeAt: null`).
 */
export async function handleDismissAnalyzeQueue(params: { shop: string }) {
  const { shop } = params;
  const result = await prisma.thread.updateMany({
    where: {
      shop,
      analyzedAt: null,
      dismissedFromAnalyzeAt: null,
      supportNature: { in: ["confirmed_support", "probable_support", "mixed"] },
      operationalState: { notIn: ["resolved", "no_reply_needed"] },
    },
    data: { dismissedFromAnalyzeAt: new Date() },
  });
  return { dismissedCount: result.count, report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
}

/** Dismiss a single thread from the "À analyser" queue. */
export async function handleDismissThreadFromAnalyze(params: { shop: string; canonicalThreadId: string }) {
  const { shop, canonicalThreadId } = params;
  if (!canonicalThreadId) {
    return { dismissedCount: 0, report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
  }
  const result = await prisma.thread.updateMany({
    where: { id: canonicalThreadId, shop, dismissedFromAnalyzeAt: null },
    data: { dismissedFromAnalyzeAt: new Date() },
  });
  return { dismissedCount: result.count, report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
}

export async function handleSync(params: {
  shop: string;
  admin: AdminGraphqlClient;
  mailConnectionId?: string; // if provided, sync only that mailbox; otherwise sync all
}) {
  const { shop, admin, mailConnectionId } = params;
  // Mirror auto-sync's per-conversation billing semantics: when the shop is
  // suspended (quota exceeded or trial expired) the pipeline still runs but
  // Tier 3 (intent + Shopify + tracking + draft) is skipped — Tier 1 + 2
  // keep classifying so merchants see new support mails arriving, even if
  // they're not analyzed. The stale-analysis refresh is also Tier 3 work
  // and is skipped in that case.
  const ent = await resolveEntitlements({ shop, admin });
  const tier3Allowed = !ent.isSyncSuspended;

  const connections = mailConnectionId
    ? await prisma.mailConnection.findMany({ where: { shop, id: mailConnectionId } })
    : await prisma.mailConnection.findMany({ where: { shop, autoSyncEnabled: true } });

  // The mail provider (Gmail / Outlook / Zoho) can throw — typically when the
  // OAuth refresh token is invalidated (user revoked, app secret rotated,
  // token TTL exceeded). processNewEmails already records the message in
  // MailConnection.lastSyncError; we must return a structured error here
  // instead of letting it propagate as a 500 (which would render a generic
  // "Erreur applicative" page that swallows the whole inbox).
  let report = null as Awaited<ReturnType<typeof processNewEmails>> | null;
  let syncError: string | null = connections.length === 0 ? "No mail connection for this shop" : null;
  for (const connection of connections) {
    try {
      const r = await processNewEmails(shop, admin, { tier3Allowed, connection });
      // Merge reports across mailboxes: sum numeric counters, combine errors,
      // preserve cancelled=true if any mailbox was cancelled.
      if (!report) {
        report = { ...r };
      } else {
        report = {
          total: report.total + r.total,
          alreadyProcessed: report.alreadyProcessed + r.alreadyProcessed,
          filtered: report.filtered + r.filtered,
          supportClient: report.supportClient + r.supportClient,
          uncertain: report.uncertain + r.uncertain,
          nonClient: report.nonClient + r.nonClient,
          errors: report.errors + r.errors,
          cancelled: report.cancelled || r.cancelled,
        };
      }
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
      break;
    }
  }

  let staleRefresh = null as Awaited<ReturnType<typeof refreshStaleAnalysesForShop>> | null;
  if (tier3Allowed && !syncError) {
    try {
      staleRefresh = await refreshStaleAnalysesForShop(shop, admin, {
        maxAgeMs: ANALYSIS_FRESHNESS_MS.autoRefresh,
      });
    } catch {
      // Best-effort refresh — never block the sync response on this.
    }
  }
  return { report, syncCompleted: !syncError, syncError, disconnected: false, reanalyzed: null, refined: null, stopped: false, staleRefresh, syncSuspended: !tier3Allowed };
}

export async function handleBackfill(params: {
  shop: string;
  mailConnectionId: string;
  days: number;
}) {
  const { shop, mailConnectionId, days } = params;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const afterDate = new Date(Date.now() - Math.max(1, days) * MS_PER_DAY);
  await enqueueJob({ shop, kind: "backfill", mailConnectionId, params: { afterDateIso: afterDate.toISOString() } });
  return {
    syncStarted: true,
    report: null,
    disconnected: false,
    reanalyzed: null,
    refined: null,
    stopped: false,
  };
}

export async function handleToggleAutoSync(params: {
  shop: string;
  mailConnectionId: string;
  enable: boolean;
}) {
  await prisma.mailConnection.update({
    where: { id: params.mailConnectionId, shop: params.shop },
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

  // Per-shop rate cap on LLM actions. Caught BEFORE the entitlement check
  // because a stuck-loop client retrying after a quota response would still
  // accumulate rate-counter hits.
  const limited = await checkLlmRateLimit(shop, "reanalyze");
  if (limited) {
    return { reanalyzed: null, report: null, disconnected: false, refined: null, ...limited };
  }

  // Gate on entitlements regardless of skipDraft. Both branches run Tier 3
  // (LLM intent extraction + Shopify + tracking + optional draft) — these
  // cost real money on every call even when markThreadAnalyzedIfFirst would
  // return counted=false (idempotent at the billing layer, but the LLM /
  // Shopify roundtrips still happen).
  //
  // Under suspension (trial_expired OR paid + quota_exceeded) we refuse ALL
  // Tier 3 work, including re-analysis of previously-analyzed threads and
  // error-retries (skipDraft=1). The merchant must upgrade or wait for the
  // next period to refresh anything.
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

  if (!skipDraft) {
    // The actual increment happens inside reanalyzeEmail → Tier 3 success →
    // markThreadAnalyzedIfFirst (idempotent per thread).
    let analysis: Awaited<ReturnType<typeof reanalyzeEmail>>;
    try {
      analysis = await reanalyzeEmail(emailId, admin, shop, { skipDraft: false });
    } catch (err) {
      // Tier 3 failed — no increment happened, no refund needed.
      throw err;
    }

    const freshUsage = await getUsage(shop);
    return {
      reanalyzed: { emailId, analysis },
      report: null,
      disconnected: false,
      refined: null,
      quotaStatus: { used: freshUsage.count, limit: ent.quotaStatus.limit },
    };
  }

  // skipDraft=true path: analysis only (no draft generated). Still gated
  // above; we just suppress the draftReply field on the response.
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

  const limited = await checkLlmRateLimit(shop, "redraft");
  if (limited) {
    return { reanalyzed: null, report: null, disconnected: false, refined: null, ...limited };
  }

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

  await redraftEmail(emailId, shop);

  return {
    reanalyzed: null,
    report: null,
    disconnected: false,
    refined: null,
    quotaStatus: { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit },
  };
}

export async function handleRefreshEmailHtml(params: {
  shop: string;
  emailId: string;
}) {
  const { shop, emailId } = params;
  const record = await prisma.incomingEmail.findUnique({
    where: { id: emailId },
    select: { shop: true, externalMessageId: true, mailConnectionId: true },
  });
  if (!record || record.shop !== shop) {
    return { report: null, disconnected: false, reanalyzed: null, refined: null };
  }
  // Use the email's mailConnectionId to resolve the correct connection.
  // Fall back to any connection for legacy rows that predate the column.
  const conn = record.mailConnectionId
    ? await prisma.mailConnection.findUnique({ where: { id: record.mailConnectionId } })
    : await prisma.mailConnection.findFirst({ where: { shop } });
  if (!conn) return { report: null, disconnected: false, reanalyzed: null, refined: null };
  try {
    const client = await getMailClient(conn);
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

  const limited = await checkLlmRateLimit(shop, "refine");
  if (limited) {
    return { reanalyzed: null, report: null, disconnected: false, refined: null, ...limited };
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

  // Reload AFTER the refresh so we see fresh analysisResult. Defence-in-
  // depth: re-include `shop` in the where clause so this reload cannot
  // pull another shop's data even in the unlikely event of an id collision.
  const fresh = await prisma.incomingEmail.findFirst({
    where: { id: emailId, shop },
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

  return {
    refined: { emailId, newDraft, draftHistory: history },
    report: null,
    disconnected: false,
    reanalyzed: null,
    quotaStatus: { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit },
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

  const supportNatureFlipped =
    forceSupport && thread.supportNature !== "confirmed_support";

  // If we just flipped a thread to a support stance AND it has never
  // been analyzed, enqueue a background analyze_thread job. The
  // auto-sync loop picks it up at the next tick and runs Tier 3 with
  // skipDraft:true. The first-time analysis consumes 1 billing unit
  // via markThreadAnalyzedIfFirst.
  if (supportNatureFlipped) {
    const threadRow = await prisma.thread.findUnique({
      where: { id: canonicalThreadId },
      // TODO(multi-mailbox): mailConnectionId will be plumbed from caller context once per-mailbox routing lands
      select: { analyzedAt: true, mailConnectionId: true },
    });
    if (threadRow && threadRow.analyzedAt === null) {
      await enqueueJob({ shop, kind: "analyze_thread", mailConnectionId: threadRow.mailConnectionId, params: { threadId: canonicalThreadId } }).catch((err) => {
        console.error(`[catch-up] enqueueJob analyze_thread failed for thread=${canonicalThreadId}:`, err);
      });
    }
  }

  // On reopen, refresh tracking + crawl on the thread anchor immediately.
  // Resolved threads skip those steps during auto-sync (orchestrator's
  // skipTracking flag), so without this hook a freshly-reopened thread
  // would show stale tracking until the next refresh-stale tick (~1h).
  //
  // Gated on entitlements: refreshThreadAnalysis runs Tier 3 (Shopify
  // order search + tracking + optional crawl) which costs real money on
  // every call. Under suspension we must not subsidize those operations.
  if (isReopen) {
    try {
      const ent = await resolveEntitlements({ shop, admin });
      if (!ent.canGenerateDraft) {
        // Suspended shop — leave the thread reopened, but skip the refresh.
        // The tracking will catch up the next time the merchant resumes a
        // paid period and triggers an analysis manually.
      } else {
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
      }
    } catch (err) {
      console.error("[moveThread] reopen refresh failed:", err);
    }
  }

  return { movedThread: { canonicalThreadId, target }, report: null, disconnected: false, reanalyzed: null, refined: null };
}

export async function handleEditThreadIdentifiers(params: {
  shop: string;
  admin: AdminGraphqlClient;
  canonicalThreadId: string;
  resolvedOrderNumber: string | null;
  resolvedTrackingNumber: string | null;
  resolvedEmail: string | null;
  resolvedCustomerName: string | null;
}) {
  const {
    shop, admin, canonicalThreadId,
    resolvedOrderNumber, resolvedTrackingNumber, resolvedEmail, resolvedCustomerName,
  } = params;
  if (!canonicalThreadId) {
    return { report: null, disconnected: false, reanalyzed: null, refined: null };
  }
  const before = await prisma.thread.findUnique({
    where: { id: canonicalThreadId },
    select: {
      shop: true,
      resolvedOrderNumber: true,
      resolvedTrackingNumber: true,
      resolvedEmail: true,
      resolvedCustomerName: true,
    },
  });
  if (!before || before.shop !== shop) {
    return { report: null, disconnected: false, reanalyzed: null, refined: null };
  }

  const orderChanged    = (before.resolvedOrderNumber    ?? null) !== resolvedOrderNumber;
  const trackingChanged = (before.resolvedTrackingNumber ?? null) !== resolvedTrackingNumber;
  const emailChanged    = (before.resolvedEmail          ?? null) !== resolvedEmail;
  const nameChanged     = (before.resolvedCustomerName   ?? null) !== resolvedCustomerName;
  const anyChange = orderChanged || trackingChanged || emailChanged || nameChanged;

  if (!anyChange) {
    refineContextRefreshTotal.inc({ shop, outcome: "skipped_noop" });
    return {
      editedThread: { canonicalThreadId },
      refreshed: "skipped_noop" as const,
      report: null, disconnected: false, reanalyzed: null, refined: null,
    };
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

  // refreshTracking follows reSearchOrder because a different order on
  // Shopify means different fulfillments and tracking numbers.
  const reSearchOrder = orderChanged || trackingChanged || emailChanged;
  const refreshTracking = reSearchOrder;

  const anchor = await prisma.incomingEmail.findFirst({
    where: { canonicalThreadId, shop, processingStatus: "analyzed" },
    orderBy: { receivedAt: "desc" },
    select: { id: true },
  });
  if (!anchor) {
    refineContextRefreshTotal.inc({ shop, outcome: "no_anchor" });
    return {
      editedThread: { canonicalThreadId },
      refreshed: "no_anchor" as const,
      report: null, disconnected: false, reanalyzed: null, refined: null,
    };
  }

  // Gate: identifier edit on a suspended account persists the new values
  // but skips the Tier 3 refresh (Shopify + 17track). Counter and metrics
  // are tagged 'skipped_suspended' for visibility.
  try {
    const ent = await resolveEntitlements({ shop, admin });
    if (!ent.canGenerateDraft) {
      refineContextRefreshTotal.inc({ shop, outcome: "skipped_suspended" });
      return {
        editedThread: { canonicalThreadId },
        refreshed: "skipped_suspended" as const,
        report: null, disconnected: false, reanalyzed: null, refined: null,
      };
    }
  } catch {
    // Fail-open on entitlement glitch.
  }

  try {
    const { refreshThreadAnalysis } = await import("./refresh-thread-analysis");
    await refreshThreadAnalysis(anchor.id, admin, shop, {
      reclassifyIntent: false,
      reSearchOrder,
      refreshTracking,
    });
    refineContextRefreshTotal.inc({ shop, outcome: "ok" });
    return {
      editedThread: { canonicalThreadId },
      refreshed: "ok" as const,
      report: null, disconnected: false, reanalyzed: null, refined: null,
    };
  } catch (err) {
    console.error(
      `[edit-identifiers] shop=${shop} canonicalThreadId=${canonicalThreadId} refresh failed:`,
      err,
    );
    refineContextRefreshTotal.inc({ shop, outcome: "error" });
    return {
      editedThread: { canonicalThreadId },
      refreshed: "error" as const,
      report: null, disconnected: false, reanalyzed: null, refined: null,
    };
  }
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
      // Gate the refresh on entitlements (Shopify search + 17track cost).
      let allowRefresh = true;
      try {
        const ent = await resolveEntitlements({ shop, admin });
        allowRefresh = ent.canGenerateDraft;
      } catch {
        // Fail-open.
      }
      if (allowRefresh) {
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
      }

      const finalOrderNumber = analysis.order?.name?.replace(/^#/, "") ?? null;
      await prisma.thread.update({
        where: { id: threadId },
        data: { resolvedOrderNumber: finalOrderNumber },
      }).catch((err) => {
        console.error("[updateClassification] thread sync after refresh failed:", err);
      });
    }

    // Re-include `shop` even though persistClassificationEdit above already
    // validated ownership — defence-in-depth so this lookup can never
    // return another shop's thread row even if a future refactor changes
    // the call shape.
    const threadRow = await prisma.thread.findFirst({
      where: { id: threadId, shop },
      // TODO(multi-mailbox): mailConnectionId will be plumbed from caller context once per-mailbox routing lands
      select: { analyzedAt: true, supportNature: true, mailConnectionId: true },
    });
    const isSupportNow =
      threadRow?.supportNature === "confirmed_support" ||
      threadRow?.supportNature === "probable_support" ||
      threadRow?.supportNature === "mixed";
    if (threadRow && isSupportNow && threadRow.analyzedAt === null) {
      await enqueueJob({ shop, kind: "analyze_thread", mailConnectionId: threadRow.mailConnectionId, params: { threadId } }).catch((err) => {
        console.error(`[catch-up] enqueueJob analyze_thread failed for thread=${threadId}:`, err);
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

/**
 * Unified entry point for the "Generate / Refine" merged UI affordance.
 * Branches on whether the user typed instructions:
 *   - empty (after trim) → redraft path (no LLM rewrite, just re-emit
 *     the draft from the existing analysisResult).
 *   - non-empty          → refine path (LLM rewrite using the user's
 *     instructions and the curated contextSummary).
 *
 * Both legacy handlers (handleRefine / handleRedraft) remain exported
 * for any internal caller — this wrapper picks one and forwards.
 */
export async function handleGenerateDraft(params: {
  shop: string;
  admin: AdminGraphqlClient;
  emailId: string;
  instructions: string;
  currentDraft: string;
}) {
  const wantsRefine = params.instructions.trim().length > 0;
  if (wantsRefine) {
    return handleRefine(params);
  }
  return handleRedraft({
    shop: params.shop,
    admin: params.admin,
    emailId: params.emailId,
  });
}
