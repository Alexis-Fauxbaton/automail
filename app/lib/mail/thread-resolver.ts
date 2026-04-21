// Canonical thread resolution.
//
// A canonical Thread groups together messages that belong to the same
// logical conversation, even when the mail provider fragments them across
// multiple native threadIds (Zoho's behavior when the subject changes
// mid-conversation). All thread-level business logic (classification,
// operational state, backfill) should key off the canonical Thread.id,
// not the provider's raw threadId.
//
// Resolution strategy, in priority order:
//   1. Existing mapping       — (shop, provider, providerThreadId) already
//                               points to a canonical Thread.
//   2. RFC header reconciliation — the new message's In-Reply-To or
//                               References matches the rfcMessageId of an
//                               already-ingested email. Its thread wins
//                               and a new provider mapping is attached.
//   3. Create a new Thread.

import type { PrismaClient, Prisma } from "@prisma/client";
import prisma from "../../db.server";

export interface ResolveThreadInput {
  shop: string;
  provider: string;                // "gmail" | "zoho"
  providerThreadId: string;        // raw provider threadId (may be "")
  externalMessageId: string;       // provider message id (fallback key)
  subject: string;
  receivedAt: Date;
  rfcMessageId?: string;           // RFC 5322 Message-ID header (may be empty)
  inReplyTo?: string;              // RFC 5322 In-Reply-To header (may be empty)
  rfcReferences?: string;          // RFC 5322 References header (space-separated)
}

export interface ResolveThreadResult {
  canonicalThreadId: string;
  isNew: boolean;
  mergedFromRfc: boolean;          // true when the message was attached to
                                   // an existing thread via RFC header merge.
}

/** Normalize a subject for cache/debug purposes (strip Re:, Fwd:, trim, lowercase). */
export function normalizeSubjectKey(subject: string): string {
  return subject.replace(/^\s*(re:|fwd?:|fw:)\s*/gi, "").trim().toLowerCase();
}

/** Split a space-separated list of RFC Message-IDs, cleaning surrounding <>. */
function parseMessageIdList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\s+/)
    .map((s) => s.replace(/^<|>$/g, "").trim())
    .filter((s) => s.length > 0);
}

/** Clean a single Message-ID (strip <>). */
function cleanMessageId(id: string | undefined): string {
  if (!id) return "";
  return id.replace(/^<|>$/g, "").trim();
}

/**
 * Resolve (or create) the canonical Thread for an incoming message.
 *
 * Must be called INSIDE or BEFORE the email upsert so we know the
 * canonicalThreadId to write to IncomingEmail.canonicalThreadId.
 *
 * All writes are idempotent: safe to call multiple times for the same
 * message (e.g. on retry).
 */
export async function resolveCanonicalThread(
  input: ResolveThreadInput,
  db: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<ResolveThreadResult> {
  const {
    shop, provider, providerThreadId, externalMessageId,
    subject, receivedAt,
  } = input;

  // A stable provider key: if the provider threadId is empty, key the
  // mapping off the message id itself so singletons still get a Thread.
  const mappingKey = providerThreadId || externalMessageId;

  // ---- 1. Existing mapping ----
  const existing = await db.threadProviderId.findUnique({
    where: {
      shop_provider_providerThreadId: {
        shop,
        provider,
        providerThreadId: mappingKey,
      },
    },
    select: { canonicalThreadId: true },
  });
  if (existing) {
    return {
      canonicalThreadId: existing.canonicalThreadId,
      isNew: false,
      mergedFromRfc: false,
    };
  }

  // ---- 2. RFC header reconciliation ----
  const parentIds = [
    cleanMessageId(input.inReplyTo),
    ...parseMessageIdList(input.rfcReferences),
  ].filter((id) => id.length > 0);

  if (parentIds.length > 0) {
    const parent = await db.incomingEmail.findFirst({
      where: {
        shop,
        rfcMessageId: { in: parentIds },
        canonicalThreadId: { not: null },
      },
      select: { canonicalThreadId: true },
      orderBy: { receivedAt: "desc" },
    });
    if (parent?.canonicalThreadId) {
      // Attach a new provider mapping so future messages with this
      // providerThreadId hit the fast path.
      await attachProviderMapping(
        db,
        parent.canonicalThreadId,
        shop,
        provider,
        mappingKey,
      );
      return {
        canonicalThreadId: parent.canonicalThreadId,
        isNew: false,
        mergedFromRfc: true,
      };
    }
  }

  // ---- 3. Create a new Thread ----
  const thread = await db.thread.create({
    data: {
      shop,
      provider,
      firstMessageAt: receivedAt,
      lastMessageAt: receivedAt,
      messageCount: 0,                // incremented after email upsert
      subjectKey: normalizeSubjectKey(subject),
      providerIds: {
        create: {
          shop,
          provider,
          providerThreadId: mappingKey,
        },
      },
    },
    select: { id: true },
  });

  return {
    canonicalThreadId: thread.id,
    isNew: true,
    mergedFromRfc: false,
  };
}

/**
 * Idempotently attach a (provider, providerThreadId) pair to an existing
 * canonical Thread. No-op if the mapping already exists.
 */
export async function attachProviderMapping(
  db: PrismaClient | Prisma.TransactionClient,
  canonicalThreadId: string,
  shop: string,
  provider: string,
  providerThreadId: string,
): Promise<void> {
  if (!providerThreadId) return;
  await db.threadProviderId.upsert({
    where: {
      shop_provider_providerThreadId: { shop, provider, providerThreadId },
    },
    create: { canonicalThreadId, shop, provider, providerThreadId },
    update: {},
  });
}

/**
 * Refresh a Thread's cached stats after a message was ingested.
 * Called once per email upsert.
 */
export async function refreshThreadStats(
  canonicalThreadId: string,
  db: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<void> {
  const agg = await db.incomingEmail.aggregate({
    where: { canonicalThreadId },
    _count: { _all: true },
    _min: { receivedAt: true },
    _max: { receivedAt: true },
  });
  const latest = await db.incomingEmail.findFirst({
    where: { canonicalThreadId },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  await db.thread.update({
    where: { id: canonicalThreadId },
    data: {
      messageCount: agg._count._all,
      firstMessageAt: agg._min.receivedAt ?? new Date(),
      lastMessageAt: agg._max.receivedAt ?? new Date(),
      lastMessageId: latest?.id ?? null,
    },
  });
}

/**
 * Return the "true latest" message of a canonical thread — the most
 * recent message in any direction (incoming, outgoing, filtered).
 * This may differ from the "target message" being classified.
 */
export async function getTrueLatestMessage(canonicalThreadId: string) {
  return prisma.incomingEmail.findFirst({
    where: { canonicalThreadId },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
  });
}

/**
 * Return the "target message" — the latest incoming message that passed
 * Tier 1 and should be considered for classification / drafting. This is
 * what pickThreadsForClassification uses. Distinct from true-latest
 * because an outgoing reply or a Tier 1 filter can land after the target.
 */
export async function getTargetMessage(canonicalThreadId: string) {
  return prisma.incomingEmail.findFirst({
    where: {
      canonicalThreadId,
      processingStatus: { notIn: ["outgoing"] },
      tier1Result: "passed",
    },
    orderBy: { receivedAt: "desc" },
  });
}
