/**
 * refreshThreadAnalysis — selective thread analysis refresh helper.
 *
 * PATH CHOSEN: Path A (fine-grained orchestrator flags)
 *
 * Motivation: the background auto-sync calls reanalyzeEmail every hour for
 * every active "to handle" thread, which re-runs the LLM intent classifier
 * AND the Shopify order search even when those values are already stable.
 * Path A adds reuseIntents / reuseOrder flags to analyzeSupportEmail so that
 * those expensive steps are genuinely skipped — not just discarded after the
 * fact (Path B). The orchestrator changes are ~30 LOC and all existing callers
 * continue to work unchanged (the fields are optional).
 *
 * Tradeoff: orchestrator is slightly more complex. The risk is low because the
 * new branches are additive and gated by explicit opt-in fields.
 */

import prisma from "../../db.server";
import type { AdminGraphqlClient } from "./shopify/order-search";
import type { SupportAnalysis } from "./types";
import { analyzeSupportEmail } from "./orchestrator";
import {
  extractAndCache,
  mergeThreadIdentifiers,
  getThreadResolution,
} from "./thread-identifiers";
import type { MailClient } from "../mail/types";
import {
  buildThreadContext,
  getMailClient,
} from "../gmail/pipeline";

export interface RefreshThreadAnalysisOptions {
  /**
   * When false, keep the previous intent and intents values from the
   * persisted analysis rather than re-running the LLM classifier.
   */
  reclassifyIntent: boolean;
  /**
   * When false, keep the previous order and orderCandidates values from
   * the persisted analysis rather than re-querying Shopify.
   */
  reSearchOrder: boolean;
  /**
   * Always true in practice — tracking is always refreshed.
   * Included for symmetry and future flexibility.
   */
  refreshTracking: boolean;
}

/**
 * Selectively refreshes parts of a thread's analysis based on the provided
 * flags. Always preserves manualOverrides from the previous analysis.
 *
 * - reclassifyIntent: false → skip LLM classifier, reuse previous intent/intents/identifiers
 * - reSearchOrder: false    → skip Shopify search, reuse previous order/orderCandidates
 * - refreshTracking: true   → always refresh trackings (order value forwarded from previous
 *                             analysis when reSearchOrder is false)
 *
 * Persists the merged analysis back to prisma and returns it.
 */
export async function refreshThreadAnalysis(
  emailId: string,
  admin: AdminGraphqlClient,
  shop: string,
  options: RefreshThreadAnalysisOptions,
): Promise<SupportAnalysis> {
  // Load the current persisted record
  const record = await prisma.incomingEmail.findUnique({ where: { id: emailId } });
  if (!record || record.shop !== shop) {
    throw new Error("Email not found");
  }

  // Parse the previous analysis so we can reuse fields selectively
  let previousAnalysis: SupportAnalysis | null = null;
  if (record.analysisResult) {
    try {
      previousAnalysis = JSON.parse(record.analysisResult as string) as SupportAnalysis;
    } catch {
      // Treat as no previous analysis — run full pipeline
    }
  }

  // Load mail connection for thread context building
  const conn = await prisma.mailConnection.findUnique({
    where: { shop },
    select: { email: true, provider: true },
  });

  let client: MailClient | undefined;
  try {
    if (conn) {
      client = await getMailClient(shop, conn.provider);
    }
  } catch (err) {
    console.error("[refresh-thread-analysis] Could not create mail client:", err);
  }

  // Build thread context (full conversation body + messages array)
  const threadContext = await buildThreadContext(
    shop,
    record.threadId,
    record.canonicalThreadId,
    record.id,
    conn?.email ?? "",
    client,
  );

  // Refresh thread-level identifier consolidation
  if (record.canonicalThreadId) {
    try {
      await extractAndCache(record.id, record.subject, record.bodyText);
      await mergeThreadIdentifiers(record.canonicalThreadId);
    } catch (err) {
      console.error("[refresh-thread-analysis] thread identifier merge failed:", err);
    }
  }
  const threadResolution = record.canonicalThreadId
    ? await getThreadResolution(record.canonicalThreadId)
    : null;

  // Build reuseIntents / reuseOrder payloads from the previous analysis
  // when the caller asked to skip those steps.
  const reuseIntents =
    !options.reclassifyIntent && previousAnalysis
      ? {
          intent: previousAnalysis.intent,
          intents: previousAnalysis.intents ?? [previousAnalysis.intent],
          identifiers: previousAnalysis.identifiers,
        }
      : undefined;

  const reuseOrder =
    !options.reSearchOrder && previousAnalysis
      ? {
          order: previousAnalysis.order,
          orderCandidates: previousAnalysis.orderCandidates,
        }
      : undefined;

  // Run the orchestrator with the selective flags.
  // skipDraft: true — this helper is for data refresh, not draft generation.
  // skipTracking: false — tracking is always refreshed.
  const freshAnalysis = await analyzeSupportEmail({
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
    skipDraft: true,
    skipTracking: !options.refreshTracking,
    reuseIntents,
    reuseOrder,
  });

  // Always preserve manualOverrides from the previous analysis.
  // The user's manual edits must never be lost across refreshes.
  const merged: SupportAnalysis = {
    ...freshAnalysis,
    manualOverrides: previousAnalysis?.manualOverrides,
  };

  // Persist the merged analysis
  await prisma.incomingEmail.update({
    where: { id: emailId },
    data: {
      processingStatus: "analyzed",
      analysisResult: JSON.stringify(merged),
      detectedIntent: merged.intent,
      analysisConfidence: merged.confidence,
      lastAnalyzedAt: new Date(),
    },
  });

  return merged;
}
