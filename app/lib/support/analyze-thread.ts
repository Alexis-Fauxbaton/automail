/**
 * analyzeThread — single entry point for all analysis paths.
 *
 * Motivation: the codebase previously had ~5 functions calling analyzeSupportEmail
 * with subtly different options, leading to duplicate DB write logic and an
 * easy-to-miss bug: backfill ingested emails (processingStatus="classified",
 * tier2Result=null, supportNature=unknown) that were never promoted through
 * Tier 2, causing them to pollute the "À traiter" inbox forever.
 *
 * This module centralises:
 *  - Tier 2 (LLM classifier)
 *  - Tier 3 (full orchestrator: intent + Shopify + tracking + draft)
 *  - All DB writes for the analysis result
 *  - Quota gate and catch-up zone gate
 *
 * Callers (classifyAndDraft, reanalyzeEmail, refreshThreadAnalysis, backfill)
 * are thin shims that delegate here. Their public signatures are unchanged.
 */

import prisma from "../../db.server";
import type { AdminGraphqlClient } from "./shopify/order-search";
import type { MailClient } from "../mail/types";
import { getMailClient } from "../mail/types";
import { analyzeSupportEmail } from "./orchestrator";
import type { SupportAnalysisExtended } from "./orchestrator";
import {
  extractAndCache,
  mergeThreadIdentifiers,
  getThreadResolution,
} from "./thread-identifiers";
import {
  recomputeThreadState,
  readStructuredState,
} from "./thread-state";
import {
  classifyEmail,
} from "../gmail/classifier";
import {
  buildThreadContext,
} from "../gmail/pipeline";
import {
  getTrueLatestMessage,
} from "../mail/thread-resolver";
import { upsertReplyDraftBody } from "./reply-draft";
import { isWithinActiveZone } from "../billing/catchup";
import { resolveEntitlements } from "../billing/entitlements";
import { createLogger } from "../log/logger";

export interface AnalyzeThreadOptions {
  // Stages (ordre d'exécution)
  /** Run LLM Tier 2 classifier before Tier 3. Default: false */
  runTier2?: boolean;
  /**
   * When true, run Tier 2 only (no Tier 3 orchestrator call). Used when
   * the shop is billing-suspended: Tier 2 still runs so support vs non-support
   * is known, but the expensive Tier 3 is skipped. The email surfaces as
   * "support, unanalyzed" until the merchant upgrades.
   * Only meaningful when runTier2=true. Default: false
   */
  tier2Only?: boolean;
  /** Run LLM intent + identifier extraction (Tier 3 step 1). Default: true */
  runIntent?: boolean;
  /** Run Shopify order search (Tier 3 step 2). Default: true */
  runShopify?: boolean;
  /** Run 17track tracking lookup (Tier 3 step 3). Default: true */
  runTracking?: boolean;
  /** Run LLM draft generation (Tier 3 step 6). Default: true */
  runDraft?: boolean;

  // Reuse from previous analysis (skip LLM/Shopify if manual overrides present)
  /** Reuse previous intent/intents/identifiers (skip LLM intent). Default: false */
  reuseIntents?: boolean;
  /** Reuse previous order/orderCandidates (skip Shopify search). Default: false */
  reuseOrder?: boolean;

  // Gates
  /** Bypass the catch-up zone gate (age > 72 h). Default: false */
  bypassCatchupGate?: boolean;
  /** Refuse Tier 3 when quota suspended. Default: true */
  enforceQuota?: boolean;
  /**
   * Skip the recomputeThreadState call at the end of Tier 3.
   * Use for background refresh paths that should not change the thread's
   * operational state — only tracking/Shopify data is being refreshed.
   * Default: false (recompute is called)
   */
  skipRecomputeState?: boolean;
  /**
   * Skip the markThreadAnalyzedIfFirst billing increment at the end of Tier 3.
   * Use for background refresh and stale-refresh paths that must never charge
   * a billing unit — only "first analysis" paths (live sync, Generate Draft,
   * reanalyzeEmail) should charge.
   * Default: false (billing is incremented on first analysis)
   */
  skipBillingIncrement?: boolean;
}

export type AnalyzeThreadResult =
  | {
      ok: true;
      /** The Tier 2 classification when runTier2 was true. */
      classification?: string;
      /** The full analysis when Tier 3 ran. */
      analysis?: SupportAnalysisExtended;
    }
  | {
      ok: false;
      skipped:
        | "non_support"       // Tier 2 ran and said non-support (no Tier 3)
        | "catchup_zone"      // email outside the 72-h active zone
        | "quota_suspended"   // shop's sync is suspended
        | "no_anchor"         // no eligible IncomingEmail in the thread
        | "no_connection"     // no MailConnection found for the thread
        | "no_admin";         // admin client is missing in ctx
    };

/**
 * Resolve and run the full or partial analysis pipeline for a thread.
 *
 * @param threadId  - canonical thread ID (Thread.id)
 * @param ctx       - resolution context (shop, admin, optional mail client)
 * @param opts      - stage flags and gate overrides
 */
export async function analyzeThread(
  threadId: string,
  ctx: {
    shop: string;
    admin: AdminGraphqlClient;
    client?: MailClient;
    mailboxAddress?: string;
    customerEmails?: Set<string>;
  },
  opts: AnalyzeThreadOptions = {},
): Promise<AnalyzeThreadResult> {
  const {
    runTier2 = false,
    tier2Only = false,
    runIntent = true,
    runShopify = true,
    runTracking = true,
    runDraft = true,
    reuseIntents = false,
    reuseOrder = false,
    bypassCatchupGate = false,
    enforceQuota = true,
    skipRecomputeState = false,
    skipBillingIncrement = false,
  } = opts;

  const { shop, admin, client } = ctx;

  const log = createLogger({ shop, mod: "support/analyze-thread", threadId });

  // ── Step 1: Resolve anchor email ──────────────────────────────────────────
  // Latest IncomingEmail in the thread that passed Tier 1, ordered by receivedAt.
  // We allow processingStatus="error" — retrying error rows is exactly what
  // user-triggered "Relancer l'analyse" is supposed to do, and the cron
  // (lastClassifyAttemptAt 24 h gate in auto-sync.ts) bounds automatic
  // retries. Outgoing rows are still excluded (they're our own sent mails,
  // not customer messages worth analyzing).
  let anchor = await prisma.incomingEmail.findFirst({
    where: {
      shop,
      canonicalThreadId: threadId,
      processingStatus: { notIn: ["outgoing"] },
      tier1Result: "passed",
    },
    orderBy: { receivedAt: "desc" },
  });

  if (!anchor) {
    // Fallback for legacy rows without tier1Result.
    anchor = await prisma.incomingEmail.findFirst({
      where: {
        shop,
        canonicalThreadId: threadId,
        processingStatus: { notIn: ["outgoing"] },
        tier1Result: null,
      },
      orderBy: { receivedAt: "desc" },
    });
  }

  if (!anchor) {
    log.info({ threadId }, "no anchor found");
    return { ok: false, skipped: "no_anchor" };
  }

  const emailId = anchor.id;

  // ── Step 2: Resolve MailConnection ────────────────────────────────────────
  const conn = anchor.mailConnectionId
    ? await prisma.mailConnection.findUnique({ where: { id: anchor.mailConnectionId } })
    : await prisma.mailConnection.findFirst({ where: { shop } });

  if (!conn) {
    log.warn({ threadId, emailId }, "no mail connection found");
    return { ok: false, skipped: "no_connection" };
  }

  const mailboxAddress = ctx.mailboxAddress ?? conn.email;

  // Resolve a MailClient if the caller didn't provide one.
  let resolvedClient = client;
  if (!resolvedClient) {
    try {
      resolvedClient = await getMailClient(conn);
    } catch (err) {
      log.error({ err }, "could not create mail client — continuing without it");
    }
  }

  // ── Step 3: Quota gate ────────────────────────────────────────────────────
  if (enforceQuota) {
    try {
      const ent = await resolveEntitlements({ shop, admin });
      if (ent.isSyncSuspended) {
        log.info({ threadId, emailId }, "quota suspended — skipping Tier 3");
        return { ok: false, skipped: "quota_suspended" };
      }
    } catch (err) {
      // Fail-open: a transient Shopify billing blip must not block analysis.
      log.error({ err }, "resolveEntitlements failed — proceeding (fail-open)");
    }
  }

  // ── Step 4: Catch-up gate (only relevant when Tier 2 would run) ───────────
  if (runTier2 && !bypassCatchupGate) {
    const isFresh = isWithinActiveZone(anchor.receivedAt);
    if (!isFresh) {
      log.info({ threadId, emailId }, "email outside active zone — catch-up gate");
      await prisma.incomingEmail.update({
        where: { id: emailId },
        data: { processingStatus: "ingested" },
      });
      return { ok: false, skipped: "catchup_zone" };
    }
  }

  // ── Step 5: Tier 2 (LLM classifier) ──────────────────────────────────────
  let tier2Classification: string | undefined;

  if (runTier2) {
    // Build thread state for the classifier (compact structured state + true latest).
    const threadStateForClassify = await readStructuredState(threadId).catch(() => null);
    let trueLatestBody: string | undefined;
    let agentHasReplied = false;

    const trueLatest = await getTrueLatestMessage(threadId, shop);
    if (trueLatest && trueLatest.id !== anchor.id) {
      trueLatestBody = trueLatest.bodyText;
    }
    const lastAgentIso = threadStateForClassify?.lastAgentMessageAt;
    if (lastAgentIso) {
      agentHasReplied = new Date(lastAgentIso).getTime() > anchor.receivedAt.getTime();
    }

    const classification = await classifyEmail(anchor.subject, anchor.bodyText ?? "", {
      shop,
      emailId,
      threadId,
      threadState: threadStateForClassify ?? undefined,
      trueLatestBody,
      agentHasReplied,
    });

    tier2Classification = classification;

    await prisma.incomingEmail.update({
      where: { id: emailId },
      data: { tier2Result: classification },
    });

    // Recompute thread state now that message-level classification changed.
    try {
      await recomputeThreadState(threadId, { mailboxAddress });
    } catch (err) {
      log.error({ err }, "post-Tier2 recomputeThreadState failed");
    }

    if (classification !== "support_client") {
      // Tier 2 classified as non-support: mark as classified but don't run Tier 3.
      await prisma.incomingEmail.update({
        where: { id: emailId },
        data: { processingStatus: "classified" },
      });
      log.info({ threadId, emailId, classification }, "Tier 2: non-support, skipping Tier 3");
      return { ok: true, classification };
    }

    // tier2Only: billing-suspended path. Tier 2 says support_client but the
    // expensive Tier 3 is skipped until the merchant upgrades. The email stays
    // "classified" in the inbox as "support, unanalyzed".
    if (tier2Only) {
      await prisma.incomingEmail.update({
        where: { id: emailId },
        data: { processingStatus: "classified" },
      });
      log.info({ threadId, emailId }, "Tier 2 only (billing gate): Tier 3 skipped");
      return { ok: true, classification };
    }
  }

  // ── Step 6: Tier 3 (orchestrator) ────────────────────────────────────────
  // Refresh thread-level identifier consolidation before the orchestrator runs.
  try {
    await extractAndCache(emailId, anchor.subject, anchor.bodyText ?? "");
    await mergeThreadIdentifiers(threadId, shop);
  } catch (err) {
    log.error({ err }, "thread identifier merge failed");
  }

  const threadResolution = await getThreadResolution(threadId, shop).catch(() => null);

  // Build thread context (full conversation body + messages array).
  const threadContext = await buildThreadContext(
    shop,
    anchor.threadId,
    threadId,
    emailId,
    mailboxAddress,
    resolvedClient,
  );

  // Parse previous analysis for reuseIntents / reuseOrder / manualOverrides.
  let previousAnalysis: SupportAnalysisExtended | null = null;
  if (anchor.analysisResult) {
    try {
      previousAnalysis = JSON.parse(anchor.analysisResult as string) as SupportAnalysisExtended;
    } catch (err) {
      log.error({ err }, "failed to parse previous analysisResult");
    }
  }

  // When opts.reuseIntents is true AND the previous analysis has a manual
  // override, forward the intent/intents/identifiers to the orchestrator
  // so the LLM intent step is skipped. If there's no previous analysis we
  // let the orchestrator re-run intent naturally.
  const reuseIntentsPayload =
    reuseIntents && previousAnalysis?.manualOverrides?.intents
      ? {
          intent: previousAnalysis.intent,
          intents: previousAnalysis.intents ?? [previousAnalysis.intent],
          identifiers: previousAnalysis.identifiers,
        }
      : undefined;

  const reuseOrderPayload =
    reuseOrder && previousAnalysis?.manualOverrides?.order
      ? {
          order: previousAnalysis.order ?? null,
          orderCandidates: previousAnalysis.orderCandidates ?? [],
        }
      : undefined;

  const analysis = await analyzeSupportEmail({
    subject: anchor.subject,
    body: threadContext.body,
    conversationMessages: threadContext.messages,
    admin,
    shop,
    mailboxAddress,
    trackedCallContext: { shop, emailId, threadId },
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
    skipDraft: !runDraft,
    // skipTracking controls 17track + crawler; still run Shopify.
    // runShopify=false is expressed via reuseOrderPayload (if order is
    // already known). The orchestrator has no standalone skipShopify flag,
    // so we forward reuseOrder when the caller asked to skip Shopify.
    skipTracking: !runTracking,
    reuseIntents: runIntent ? reuseIntentsPayload : previousAnalysis
      ? {
          intent: previousAnalysis.intent,
          intents: previousAnalysis.intents ?? [previousAnalysis.intent],
          identifiers: previousAnalysis.identifiers,
        }
      : undefined,
    reuseOrder: runShopify ? reuseOrderPayload : previousAnalysis
      ? {
          order: previousAnalysis.order ?? null,
          orderCandidates: previousAnalysis.orderCandidates ?? [],
        }
      : undefined,
  });

  // Carry forward manual override markers so they survive this analysis.
  // The user's manual edits (intent, order) must never be lost.
  if (previousAnalysis?.manualOverrides) {
    analysis.manualOverrides = previousAnalysis.manualOverrides;
  }

  // Restore overrides snapshotted by handleResync, if any.
  // No-op when the thread has no snapshot (the common case).
  const { applyPreservedOverridesIfAny } = await import("./preserved-overrides");
  await applyPreservedOverridesIfAny(analysis, threadId, shop).catch((err) => {
    log.error({ err }, "applyPreservedOverridesIfAny failed");
  });

  // If the user manually set the order, keep it in sync on Thread.resolvedOrderNumber
  // so SQL dashboards / rules don't have to parse the JSON blob.
  if (analysis.manualOverrides?.order) {
    const finalOrderNumber = analysis.order?.name?.replace(/^#/, "") ?? null;
    await prisma.thread.update({
      where: { id: threadId, shop },
      data: { resolvedOrderNumber: finalOrderNumber },
    }).catch((err) => {
      log.error({ err }, "thread order sync failed");
    });
  }

  // Persist the analysis result.
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

  // Persist the draft body when one was generated.
  if (runDraft && analysis.draftReply) {
    await upsertReplyDraftBody(emailId, shop, analysis.draftReply).catch((err) => {
      log.error({ err }, "upsertReplyDraftBody failed");
    });
  }

  // Single billing write site: mark the thread as analyzed (first time only).
  // Skipped for light-refresh paths (stale-refresh cron, handleEditThreadIdentifiers)
  // that must never consume a billing unit — they only refresh tracking/Shopify data.
  if (!skipBillingIncrement) {
    const { markThreadAnalyzedIfFirst } = await import("../billing/usage");
    await markThreadAnalyzedIfFirst(threadId, shop).catch((err) => {
      log.error(
        { err, threadId },
        "markThreadAnalyzedIfFirst failed — analysis is real but billing counter may be off",
      );
    });
  }

  // Recompute thread state so the inbox reflects the new analysis.
  // Skipped for background refresh paths (skipRecomputeState=true) that
  // only update tracking/Shopify data and must not change the thread's
  // operational state — that would make the thread ineligible for future refreshes.
  if (!skipRecomputeState) {
    try {
      await recomputeThreadState(threadId, { mailboxAddress });
    } catch (err) {
      log.error({ err }, "post-Tier3 recomputeThreadState failed");
    }
  }

  log.info({ threadId, emailId, intent: analysis.intent }, "analysis complete");

  return {
    ok: true,
    classification: tier2Classification ?? "support_client",
    analysis,
  };
}
