// Durable background-job queue backed by the `SyncJob` Postgres table.
//
// Web actions enqueue a SyncJob row and return immediately; the in-process
// auto-sync loop (see `auto-sync.ts`) claims pending rows and executes them.
// Jobs are durable, retryable, and observable (status, attempts, lastError,
// timestamps).
//
// Retry policy: exponential backoff — 30 s, 60 s, then permanent error.
// Zombie recovery: auto-sync resets jobs stuck in "running" for > 30 min.
// Concurrency guard: optimistic update on status prevents double-claim.
//
// For true multi-worker horizontal scaling, replace `claimNextJob` with a
// SELECT FOR UPDATE SKIP LOCKED query (pg_advisory_lock or a dedicated
// queue service). The current implementation is safe for a single-process
// deployment and straightforward to upgrade.

import prisma from "../../db.server";

export type SyncJobKind = "sync" | "backfill" | "resync";

export interface BackfillParams {
  afterDateIso: string;
}

const MAX_ATTEMPTS = 3;
// Exponential backoff: attempt N → wait 2^(N-1) × BASE_BACKOFF_MS (capped).
const BASE_BACKOFF_MS = 30_000;   // 30 s
const MAX_BACKOFF_MS  = 30 * 60_000; // 30 min

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
 * Atomically claim the next pending job whose backoff window has elapsed.
 * Returns null if nothing is ready.
 *
 * Uses a conditional updateMany on status so two concurrent workers race
 * safely — the loser gets count=0 and falls through without double-executing.
 */
export async function claimNextJob(): Promise<{
  id: string;
  shop: string;
  kind: SyncJobKind;
  params: Record<string, unknown>;
  attempts: number;
} | null> {
  const now = new Date();
  const candidate = await prisma.syncJob.findFirst({
    where: {
      status: "pending",
      attempts: { lt: MAX_ATTEMPTS },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, shop: true, kind: true, params: true, attempts: true },
  });
  if (!candidate) return null;

  const claimed = await prisma.syncJob.updateMany({
    where: { id: candidate.id, status: "pending" },
    data: {
      status: "running",
      startedAt: now,
      nextRetryAt: null,
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
  const attempts = job?.attempts ?? 0;
  const exhausted = attempts >= MAX_ATTEMPTS;
  // Exponential backoff: attempt N → delay 2^(N-1) × BASE_BACKOFF_MS.
  const backoffMs = Math.min(
    Math.pow(2, Math.max(0, attempts - 1)) * BASE_BACKOFF_MS,
    MAX_BACKOFF_MS,
  );
  await prisma.syncJob.update({
    where: { id },
    data: {
      status: exhausted ? "error" : "pending",
      finishedAt: exhausted ? new Date() : null,
      startedAt: null,
      nextRetryAt: exhausted ? null : new Date(Date.now() + backoffMs),
      lastError: message.slice(0, 500),
    },
  });
}

/**
 * Reset jobs stuck in "running" whose startedAt is older than `timeoutMs`.
 * This handles crashed or OOM-killed workers that never called markJobDone/
 * markJobFailed. Call once per tick before claiming new work.
 */
export async function reclaimZombieJobs(timeoutMs: number): Promise<void> {
  const cutoff = new Date(Date.now() - timeoutMs);
  await prisma.syncJob.updateMany({
    where: { status: "running", startedAt: { lt: cutoff } },
    data: { status: "pending", startedAt: null, nextRetryAt: null },
  });
}
