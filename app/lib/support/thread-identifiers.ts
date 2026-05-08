// Thread-level identifier consolidation.
//
// Strategy (per spec §3):
//  A. Cheap regex extraction runs on EVERY incoming message at ingestion
//     time and is cached on IncomingEmail.extractedIdentifiers (JSON).
//  B. After the cache is updated, identifiers are CONSOLIDATED at the
//     canonical thread level (Thread.resolved*). Later code paths
//     (classification, orchestrator, drafting) should prefer those
//     resolved values over re-parsing the full thread.
//  C. Full-thread parsing (llm-parser) stays as a fallback when nothing
//     was resolved cheaply.
//
// The merge is deterministic: incoming messages are scanned from the
// most recent to the oldest, and the first non-empty value for each
// field wins. Confidence reflects the strongest signal that produced
// the current resolvedOrderNumber.

import prisma from "../../db.server";
import { extractIdentifiers } from "./identifier-extractor";
import type { ExtractedIdentifiers } from "./types";

export type ResolutionConfidence = "none" | "low" | "medium" | "high";

export interface ThreadResolution {
  orderNumber?: string;
  trackingNumber?: string;
  email?: string;
  customerName?: string;
  confidence: ResolutionConfidence;
  sourceMessageId?: string;
}

/** Run the cheap regex extraction and persist it on the email row. */
export async function extractAndCache(
  emailId: string,
  subject: string,
  body: string,
): Promise<ExtractedIdentifiers> {
  const normalized = `${subject}\n${body}`.toLowerCase();
  const identifiers = extractIdentifiers({ subject, body, normalized });
  await prisma.incomingEmail.update({
    where: { id: emailId },
    data: { extractedIdentifiers: JSON.stringify(identifiers) },
  });
  return identifiers;
}

/**
 * Grade how confidently an order number was extracted from the raw
 * source. Explicit "#1234" or "order 1234" beats a naked 4-digit match.
 */
function scoreOrderConfidence(
  orderNumber: string | undefined,
  source: string,
): ResolutionConfidence {
  if (!orderNumber) return "none";
  const hashHit = new RegExp(`#\\s?${orderNumber}\\b`).test(source);
  if (hashHit) return "high";
  const keywordHit = new RegExp(
    `\\b(?:order|commande|cmd|n[°o]\\.?|numero|num[eé]ro)\\s*[:#]?\\s*${orderNumber}\\b`,
    "i",
  ).test(source);
  if (keywordHit) return "medium";
  return "low";
}

function parseCached(raw: string | null | undefined): ExtractedIdentifiers {
  if (!raw) return {};
  try { return JSON.parse(raw) as ExtractedIdentifiers; } catch { return {}; }
}

/**
 * Walk the canonical thread from newest to oldest incoming message,
 * pick the first non-empty signal for each identifier and update
 * Thread.resolved*. Skips outgoing messages (they're the merchant's
 * own replies and should not override customer-provided identifiers).
 */
export async function mergeThreadIdentifiers(
  canonicalThreadId: string,
  shop: string,
): Promise<ThreadResolution> {
  const messages = await prisma.incomingEmail.findMany({
    where: {
      canonicalThreadId,
      shop,
      processingStatus: { notIn: ["outgoing"] },
    },
    orderBy: { receivedAt: "desc" },
    select: {
      id: true,
      subject: true,
      bodyText: true,
      extractedIdentifiers: true,
    },
  });

  const resolution: ThreadResolution = { confidence: "none" };
  let bestOrderConfidence: ResolutionConfidence = "none";
  let bestOrderSource: string | undefined;

  for (const m of messages) {
    const ids = parseCached(m.extractedIdentifiers);
    const source = `${m.subject}\n${m.bodyText}`;

    if (!resolution.orderNumber && ids.orderNumber) {
      resolution.orderNumber = ids.orderNumber;
      bestOrderConfidence = scoreOrderConfidence(ids.orderNumber, source);
      bestOrderSource = m.id;
    } else if (resolution.orderNumber && ids.orderNumber === resolution.orderNumber) {
      // Same number seen in another message — upgrade confidence if stronger.
      const c = scoreOrderConfidence(ids.orderNumber, source);
      if (isStronger(c, bestOrderConfidence)) {
        bestOrderConfidence = c;
        bestOrderSource = m.id;
      }
    }

    if (!resolution.trackingNumber && ids.trackingNumber) {
      resolution.trackingNumber = ids.trackingNumber;
      resolution.sourceMessageId ??= m.id;
    }
    if (!resolution.email && ids.email) {
      resolution.email = ids.email;
      resolution.sourceMessageId ??= m.id;
    }
    if (!resolution.customerName && ids.customerName) {
      resolution.customerName = ids.customerName;
    }
  }

  // Confidence: primary signal is the order-number strength. If no order
  // was resolved but we have an email or tracking, fall back to "low".
  if (resolution.orderNumber) {
    resolution.confidence = bestOrderConfidence;
    resolution.sourceMessageId = bestOrderSource;
  } else if (resolution.trackingNumber || resolution.email) {
    resolution.confidence = "low";
  }

  // Respect manual order overrides. The user's pick (or detach) must win
  // over per-message extraction — otherwise every new message that mentions
  // an order number resets `Thread.resolvedOrderNumber` to the parsed value
  // and silently undoes the user's decision. Two sources of truth, in order:
  //   1. `Thread.preservedManualOverridesJson` — the resync snapshot, set
  //      while the post-resync analyses haven't yet re-applied it.
  //   2. The latest analyzed email's `analysisResult.manualOverrides.order`.
  const manualOrderName = await readManualOrderOverride(canonicalThreadId, shop);
  const finalResolvedOrderNumber =
    manualOrderName !== undefined ? manualOrderName : (resolution.orderNumber ?? null);

  await prisma.thread.update({
    where: { id: canonicalThreadId, shop },
    data: {
      resolvedOrderNumber:    finalResolvedOrderNumber,
      resolvedTrackingNumber: resolution.trackingNumber ?? null,
      resolvedEmail:          resolution.email          ?? null,
      resolvedCustomerName:   resolution.customerName   ?? null,
      resolutionConfidence:   resolution.confidence,
      resolvedFromMessageId:  resolution.sourceMessageId ?? null,
    },
  });

  return resolution;
}

/**
 * Returns the user's manually-set order number for the thread (or `null`
 * for a manual detach). Returns `undefined` when there is no manual
 * override at all — caller should then use the auto-derived value.
 */
async function readManualOrderOverride(
  canonicalThreadId: string,
  shop: string,
): Promise<string | null | undefined> {
  // 1. Resync snapshot — applies until the next analysis pass consumes it.
  const thread = await prisma.thread
    .findUnique({
      where: { id: canonicalThreadId },
      select: { preservedManualOverridesJson: true },
    })
    .catch(() => null);
  if (thread?.preservedManualOverridesJson) {
    try {
      const snap = JSON.parse(thread.preservedManualOverridesJson) as {
        order?: { name?: string } | null;
        orderAt?: string;
      };
      if (snap.orderAt !== undefined) {
        return snap.order?.name?.replace(/^#/, "") ?? null;
      }
    } catch {
      // Corrupt snapshot — fall through to the analysisResult source.
    }
  }

  // 2. Latest analyzed email's manualOverrides marker.
  const latest = await prisma.incomingEmail
    .findFirst({
      where: {
        canonicalThreadId,
        shop,
        analysisResult: { not: null },
      },
      orderBy: { receivedAt: "desc" },
      select: { analysisResult: true },
    })
    .catch(() => null);
  if (!latest?.analysisResult) return undefined;
  try {
    const parsed = JSON.parse(latest.analysisResult) as {
      manualOverrides?: { order?: unknown };
      order?: { name?: string } | null;
    };
    if (parsed.manualOverrides?.order) {
      return parsed.order?.name?.replace(/^#/, "") ?? null;
    }
  } catch {
    // Ignore — corrupt analysis JSON shouldn't lock writes.
  }
  return undefined;
}

function isStronger(a: ResolutionConfidence, b: ResolutionConfidence): boolean {
  const rank: Record<ResolutionConfidence, number> = {
    none: 0, low: 1, medium: 2, high: 3,
  };
  return rank[a] > rank[b];
}

/**
 * Convenience: read the current Thread.resolved* state as a plain
 * object. Use this in downstream consumers (orchestrator) that should
 * prefer thread-level resolution over re-parsing a full thread.
 */
export async function getThreadResolution(
  canonicalThreadId: string,
  shop: string,
): Promise<ThreadResolution | null> {
  const t = await prisma.thread.findUnique({
    where: { id: canonicalThreadId, shop },
    select: {
      resolvedOrderNumber: true,
      resolvedTrackingNumber: true,
      resolvedEmail: true,
      resolvedCustomerName: true,
      resolutionConfidence: true,
      resolvedFromMessageId: true,
    },
  });
  if (!t) return null;
  return {
    orderNumber:     t.resolvedOrderNumber    ?? undefined,
    trackingNumber:  t.resolvedTrackingNumber ?? undefined,
    email:           t.resolvedEmail          ?? undefined,
    customerName:    t.resolvedCustomerName   ?? undefined,
    confidence:      (t.resolutionConfidence as ResolutionConfidence) ?? "none",
    sourceMessageId: t.resolvedFromMessageId  ?? undefined,
  };
}
