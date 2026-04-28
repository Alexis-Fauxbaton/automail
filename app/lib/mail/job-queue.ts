// Durable background-job queue backed by the `SyncJob` Postgres table.
//
// Web actions enqueue a SyncJob row and return immediately; the in-process
// auto-sync loop (see `auto-sync.ts`) claims pending rows and executes them.
// Jobs are durable, retryable, and observable (status, attempts, lastError,
// timestamps).
//
// Retry policy: exponential backoff — 30 s, 60 s, then permanent error.
// Zombie recovery: auto-sync resets jobs stuck in "running" for > 30 min.
//
// Multi-shop isolation: the claim query uses `FOR UPDATE SKIP LOCKED` plus
// a "shop NOT IN (shops with a running job)" filter. This guarantees:
//   - two workers never claim the same job row,
//   - a shop never has two concurrently running jobs (a slow shop cannot
//     steal a slot from another shop, but it also cannot run twice),
//   - slow shops never block fast shops — the scheduler simply picks the
//     next pending job for a shop that has no running work.
//
// This is safe for both single-process and small horizontal deployments.
// For large-scale horizontal scaling (many workers, many shops), move to
// a dedicated queue service (BullMQ/Redis, pg-boss, graphile-worker).

import prisma from "../../db.server";
import { Prisma } from "@prisma/client";

export type SyncJobKind = "sync" | "backfill" | "resync" | "recompute" | "reclassify";

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

interface ClaimedJobRow {
  id: string;
  shop: string;
  kind: string;
  params: string;
  attempts: number;
}

/**
 * Atomically claim the next pending job, enforcing per-shop isolation.
 *
 * The claim query:
 *   1. picks the oldest `pending` job whose backoff window has elapsed,
 *   2. for a shop that does NOT already have a `running` job,
 *   3. that is not in `excludeShops` (shops currently in-flight in this
 *      process — redundant with the DB filter but avoids a round-trip
 *      race when several slots drain in the same tick),
 *   4. using `FOR UPDATE SKIP LOCKED` so concurrent claimers never
 *      fight over the same row.
 *
 * Returns null if nothing is ready.
 */
export async function claimNextJob(
  excludeShops: readonly string[] = [],
): Promise<{
  id: string;
  shop: string;
  kind: SyncJobKind;
  params: Record<string, unknown>;
  attempts: number;
} | null> {
  const excludeFilter =
    excludeShops.length > 0
      ? Prisma.sql`AND shop NOT IN (${Prisma.join(excludeShops)})`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<ClaimedJobRow[]>`
    UPDATE "SyncJob"
    SET status = 'running',
        "startedAt" = NOW(),
        "nextRetryAt" = NULL,
        attempts = attempts + 1
    WHERE id = (
      SELECT id FROM "SyncJob"
      WHERE status = 'pending'
        AND attempts < ${MAX_ATTEMPTS}
        AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= NOW())
        AND shop NOT IN (
          SELECT DISTINCT shop FROM "SyncJob" WHERE status = 'running'
        )
        ${excludeFilter}
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, shop, kind, params, attempts
  `;

  const row = rows[0];
  if (!row) return null;

  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(row.params || "{}");
  } catch {
    /* ignore malformed payload */
  }
  return {
    id: row.id,
    shop: row.shop,
    kind: row.kind as SyncJobKind,
    params,
    attempts: row.attempts,
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
 *
 * Exhausted jobs (attempts >= MAX_ATTEMPTS) are marked "error" rather than
 * "pending" — putting them back to "pending" would block the queue forever
 * because claimNextJob requires attempts < MAX_ATTEMPTS.
 */
export async function reclaimZombieJobs(timeoutMs: number): Promise<void> {
  const cutoff = new Date(Date.now() - timeoutMs);
  // Zombies that have used all their attempts → permanent error.
  await prisma.syncJob.updateMany({
    where: { status: "running", startedAt: { lt: cutoff }, attempts: { gte: MAX_ATTEMPTS } },
    data: { status: "error", startedAt: null, finishedAt: new Date(), lastError: "Zombie job: exhausted all retry attempts" },
  });
  // Zombies with remaining attempts → back to pending for retry.
  await prisma.syncJob.updateMany({
    where: { status: "running", startedAt: { lt: cutoff }, attempts: { lt: MAX_ATTEMPTS } },
    data: { status: "pending", startedAt: null, nextRetryAt: null },
  });
  // Safety net: jobs stuck in "pending" with attempts >= MAX_ATTEMPTS can
  // never be claimed (claimNextJob checks attempts < MAX_ATTEMPTS). Mark them
  // as errors so they don't permanently pollute the active-job check.
  await prisma.syncJob.updateMany({
    where: { status: "pending", attempts: { gte: MAX_ATTEMPTS } },
    data: { status: "error", finishedAt: new Date(), lastError: "Stuck pending job: exhausted all retry attempts" },
  });
}

