// Durable background-job queue backed by the `SyncJob` Postgres table.
//
// Rationale: the Remix/React Router route actions used to call
// `processNewEmails(...)` / `runManualBackfill(...)` without awaiting,
// which works on a warm single-instance box but loses work on restart,
// timeout, or scale-out. Web actions now enqueue a SyncJob row and
// return immediately; the in-process auto-sync loop (see `auto-sync.ts`)
// claims pending rows and executes them. Jobs are durable, retryable,
// and observable (status, attempts, lastError, timestamps).
//
// This is not a full-featured queue (no exponential backoff, no
// multi-worker leasing). It's the smallest durable improvement over
// fire-and-forget — sufficient for a single-store Shopify app.

import prisma from "../../db.server";

export type SyncJobKind = "sync" | "backfill" | "resync";

export interface BackfillParams {
  afterDateIso: string;
}

const MAX_ATTEMPTS = 3;

/**
 * Enqueue a job. Called by web actions in place of
 * `processNewEmails(...)` / `runManualBackfill(...)`.
 *
 * De-dup: if a pending or running job of the same kind already exists
 * for this shop, returns the existing id instead of creating a new row.
 * That avoids a storm of "sync" buttons queueing duplicates.
 */
export async function enqueueJob(
  shop: string,
  kind: SyncJobKind,
  params: Record<string, unknown> = {},
): Promise<string> {
  const existing = await prisma.syncJob.findFirst({
    where: { shop, kind, status: { in: ["pending", "running"] } },
    select: { id: true },
  });
  if (existing) return existing.id;

  const job = await prisma.syncJob.create({
    data: { shop, kind, params: JSON.stringify(params) },
    select: { id: true },
  });
  return job.id;
}

/**
 * Atomically claim the next pending job for any shop. Returns null if
 * nothing is ready. Uses a conditional update on status so two workers
 * would race safely (we currently have one, but the guarantee is nice
 * to have for free).
 */
export async function claimNextJob(): Promise<{
  id: string;
  shop: string;
  kind: SyncJobKind;
  params: Record<string, unknown>;
  attempts: number;
} | null> {
  const candidate = await prisma.syncJob.findFirst({
    where: { status: "pending", attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    select: { id: true, shop: true, kind: true, params: true, attempts: true },
  });
  if (!candidate) return null;

  // Conditional update: only claim if still pending. If another worker
  // grabbed it, updateMany returns count=0 and we fall through.
  const claimed = await prisma.syncJob.updateMany({
    where: { id: candidate.id, status: "pending" },
    data: {
      status: "running",
      startedAt: new Date(),
      attempts: { increment: 1 },
    },
  });
  if (claimed.count === 0) return null;

  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(candidate.params || "{}");
  } catch {
    /* ignore malformed payload */
  }
  return {
    id: candidate.id,
    shop: candidate.shop,
    kind: candidate.kind as SyncJobKind,
    params,
    attempts: candidate.attempts + 1,
  };
}

export async function markJobDone(id: string): Promise<void> {
  await prisma.syncJob.update({
    where: { id },
    data: { status: "done", finishedAt: new Date(), lastError: null },
  });
}

export async function markJobFailed(id: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const job = await prisma.syncJob.findUnique({
    where: { id },
    select: { attempts: true },
  });
  // If we've exhausted attempts, park it as "error". Otherwise put it
  // back to "pending" so the next tick retries.
  const exhausted = (job?.attempts ?? 0) >= MAX_ATTEMPTS;
  await prisma.syncJob.update({
    where: { id },
    data: {
      status: exhausted ? "error" : "pending",
      finishedAt: exhausted ? new Date() : null,
      startedAt: null,
      lastError: message.slice(0, 500),
    },
  });
}
