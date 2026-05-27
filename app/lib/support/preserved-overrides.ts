// Snapshot + restore of `analysis.manualOverrides` across destructive
// resyncs. `handleResync` deletes every IncomingEmail row, which would
// otherwise lose the user's manual intent / order picks (they live inside
// `IncomingEmail.analysisResult`). We snapshot them onto Thread first and
// restore on the next analysis pass.

import prisma from "../../db.server";
import type { OrderFacts, SupportAnalysis, SupportIntent } from "./types";

export interface PreservedOverrides {
  intents?: SupportIntent[];
  intentsAt?: string;
  /** `null` is a meaningful "manually detached" — distinct from absence. */
  order?: OrderFacts | null;
  orderAt?: string;
}

/**
 * Scan all analyzed emails of `shop`, extract any `manualOverrides`, and
 * persist them on the corresponding Thread so the next analysis pass can
 * restore them after IncomingEmail rows are wiped.
 *
 * Latest message per thread wins (the canonical anchor).
 */
export async function snapshotManualOverridesForShop(shop: string): Promise<number> {
  const rows = await prisma.incomingEmail.findMany({
    where: {
      shop,
      analysisResult: { not: null },
      canonicalThreadId: { not: null },
    },
    orderBy: { receivedAt: "desc" },
    select: { canonicalThreadId: true, analysisResult: true },
  });

  // Group by thread, keep the latest analysisResult that has overrides.
  const byThread = new Map<string, PreservedOverrides>();
  for (const row of rows) {
    const threadId = row.canonicalThreadId!;
    if (byThread.has(threadId)) continue; // newer row already captured
    if (!row.analysisResult) continue;
    let parsed: SupportAnalysis;
    try {
      parsed = JSON.parse(row.analysisResult) as SupportAnalysis;
    } catch {
      continue;
    }
    const overrides = parsed.manualOverrides;
    if (!overrides?.intents && !overrides?.order) continue;
    const snapshot: PreservedOverrides = {};
    if (overrides.intents) {
      snapshot.intents = parsed.intents ?? [parsed.intent];
      snapshot.intentsAt = overrides.intents.editedAt;
    }
    if (overrides.order) {
      snapshot.order = parsed.order ?? null;
      snapshot.orderAt = overrides.order.editedAt;
    }
    byThread.set(threadId, snapshot);
  }

  if (byThread.size === 0) return 0;

  // Persist. Sequential is fine — N is bounded by the count of edited threads.
  for (const [threadId, snapshot] of byThread) {
    await prisma.thread
      .update({
        where: { id: threadId, shop },
        data: { preservedManualOverridesJson: JSON.stringify(snapshot) },
      })
      .catch((err) => {
        console.error(`[preserved-overrides] snapshot failed for thread=${threadId}:`, err);
      });
  }
  return byThread.size;
}

/**
 * Mailbox-scoped variant of `snapshotManualOverridesForShop`. Scans only the
 * IncomingEmail rows belonging to the given `mailConnectionId` (still
 * double-filtered by `shop` for safety). Same semantics: latest message per
 * thread wins, persists onto Thread, returns the count of threads snapshotted.
 */
export async function snapshotManualOverridesForMailbox(
  shop: string,
  mailConnectionId: string,
): Promise<number> {
  const rows = await prisma.incomingEmail.findMany({
    where: {
      shop,
      mailConnectionId,
      analysisResult: { not: null },
      canonicalThreadId: { not: null },
    },
    orderBy: { receivedAt: "desc" },
    select: { canonicalThreadId: true, analysisResult: true },
  });

  const byThread = new Map<string, PreservedOverrides>();
  for (const row of rows) {
    const threadId = row.canonicalThreadId!;
    if (byThread.has(threadId)) continue;
    if (!row.analysisResult) continue;
    let parsed: SupportAnalysis;
    try {
      parsed = JSON.parse(row.analysisResult) as SupportAnalysis;
    } catch {
      continue;
    }
    const overrides = parsed.manualOverrides;
    if (!overrides?.intents && !overrides?.order) continue;
    const snapshot: PreservedOverrides = {};
    if (overrides.intents) {
      snapshot.intents = parsed.intents ?? [parsed.intent];
      snapshot.intentsAt = overrides.intents.editedAt;
    }
    if (overrides.order) {
      snapshot.order = parsed.order ?? null;
      snapshot.orderAt = overrides.order.editedAt;
    }
    byThread.set(threadId, snapshot);
  }

  if (byThread.size === 0) return 0;

  for (const [threadId, snapshot] of byThread) {
    await prisma.thread
      .update({
        where: { id: threadId, shop },
        data: { preservedManualOverridesJson: JSON.stringify(snapshot) },
      })
      .catch((err) => {
        console.error(`[preserved-overrides] snapshot failed for thread=${threadId}:`, err);
      });
  }
  return byThread.size;
}

/**
 * If `Thread.preservedManualOverridesJson` is set, apply it to `analysis`
 * (replacing intent/intents/order and re-asserting the manualOverrides
 * markers), then clear the field. Mutates and returns `analysis`.
 *
 * No-op if the thread has no snapshot or the JSON is unreadable.
 */
export async function applyPreservedOverridesIfAny(
  analysis: SupportAnalysis,
  threadId: string | null,
  shop: string,
): Promise<SupportAnalysis> {
  if (!threadId) return analysis;

  const thread = await prisma.thread
    .findUnique({
      where: { id: threadId },
      select: { preservedManualOverridesJson: true, shop: true },
    })
    .catch(() => null);
  if (!thread || thread.shop !== shop || !thread.preservedManualOverridesJson) {
    return analysis;
  }

  let snapshot: PreservedOverrides;
  try {
    snapshot = JSON.parse(thread.preservedManualOverridesJson) as PreservedOverrides;
  } catch {
    // Corrupt snapshot — clear it so we don't keep retrying.
    await prisma.thread
      .update({ where: { id: threadId }, data: { preservedManualOverridesJson: null } })
      .catch(() => {});
    return analysis;
  }

  const overrides = { ...(analysis.manualOverrides ?? {}) };
  let orderRestored = false;
  if (snapshot.intents && snapshot.intents.length > 0 && snapshot.intentsAt) {
    analysis.intent = snapshot.intents[0];
    analysis.intents = snapshot.intents;
    overrides.intents = { editedAt: snapshot.intentsAt };
  }
  if (snapshot.orderAt !== undefined) {
    // `snapshot.order` is allowed to be null (manual detach).
    analysis.order = snapshot.order ?? null;
    overrides.order = { editedAt: snapshot.orderAt };
    orderRestored = true;
  }
  analysis.manualOverrides = Object.keys(overrides).length > 0 ? overrides : undefined;

  // One-shot: clear the snapshot. If we restored an order override, also
  // sync `Thread.resolvedOrderNumber` — `mergeThreadIdentifiers` will have
  // repopulated it from per-message extraction at re-ingest, but the user's
  // manual pick (incl. detach → null) must win.
  const updateData: { preservedManualOverridesJson: null; resolvedOrderNumber?: string | null } = {
    preservedManualOverridesJson: null,
  };
  if (orderRestored) {
    updateData.resolvedOrderNumber = analysis.order?.name?.replace(/^#/, "") ?? null;
  }
  await prisma.thread
    .update({ where: { id: threadId }, data: updateData })
    .catch((err) => {
      console.error(`[preserved-overrides] clear failed for thread=${threadId}:`, err);
    });

  return analysis;
}
