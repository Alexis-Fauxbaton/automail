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
// Multi-mailbox concurrency (Task 3.4):
// The claim query uses `FOR UPDATE SKIP LOCKED` plus two complementary filters:
//   - Mailbox-scoped filter: skip jobs whose mailConnectionId is already running
//     (so two mailboxes of the same shop can run in parallel).
//   - Per-shop cap (HARD_CAP_PER_SHOP): skip jobs for shops that already have
//     >= N running jobs, preventing a single shop from monopolising the pool.
//   - Shop-wide jobs (mailConnectionId IS NULL — recompute/reclassify) are not
//     excluded by the mailbox filter but count toward the per-shop cap.
//   - Legacy fallback: JOB_LOCK_GRANULARITY=shop restores the old behaviour
//     (one job per shop at a time).
//
// This is safe for both single-process and small horizontal deployments.
// For large-scale horizontal scaling (many workers, many shops), move to
// a dedicated queue service (BullMQ/Redis, pg-boss, graphile-worker).

import prisma from "../../db.server";
import { Prisma } from "@prisma/client";

/**
 * Tracks which mailboxes and shops are currently executing jobs.
 * Passed to `claimNextJob` so the claim SQL can avoid race conditions
 * within the same process tick without a DB round-trip.
 */
export type RunningSet = {
  /** mailConnectionIds of jobs currently in flight (null-id jobs are not tracked here). */
  mailConnectionIds: Set<string>;
  /** Number of in-flight jobs per shop (includes shop-wide jobs). */
  perShopCount: Map<string, number>;
};

export type SyncJobKind =
  | "sync"
  | "backfill"
  | "resync"
  | "recompute"
  | "reclassify"
  | "analyze_thread";

export interface BackfillParams {
  afterDateIso: string;
}

export type EnqueueOptions = {
  shop: string;
  kind: SyncJobKind;
  /** Required for mailbox-scoped kinds (sync/backfill/resync/analyze_thread); null for shop-wide kinds (recompute/reclassify). */
  mailConnectionId?: string | null;
  params?: Record<string, unknown>;
};

const MAILBOX_SCOPED_KINDS: SyncJobKind[] = ["sync", "backfill", "resync", "analyze_thread"];

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
 *
 * Mailbox-scoped kinds (sync/backfill/resync/analyze_thread) require
 * `mailConnectionId`. Shop-wide kinds (recompute/reclassify) leave it null.
 */
export async function enqueueJob(opts: EnqueueOptions): Promise<string> {
  if (MAILBOX_SCOPED_KINDS.includes(opts.kind) && !opts.mailConnectionId) {
    throw new Error(`Job kind ${opts.kind} requires mailConnectionId`);
  }
  // Dedup: for mailbox-scoped kinds, key by (shop, mailConnectionId, kind) so
  // two different mailboxes of the same shop can each have one pending job of
  // the same kind. Shop-wide kinds (recompute/reclassify) deduplicate by
  // (shop, kind) only (mailConnectionId is null on those rows).
  //
  // analyze_thread carries per-thread granularity in params.threadId — two
  // analyze_thread jobs for DIFFERENT threads in the same mailbox must not
  // collapse into one. Include params in the dedup key for that kind.
  const statusFilter = { in: ["pending", "running"] };
  const paramsJson = opts.params ? JSON.stringify(opts.params) : null;
  const existing = await prisma.syncJob.findFirst({
    where: opts.kind === "analyze_thread"
      ? { shop: opts.shop, kind: opts.kind, mailConnectionId: opts.mailConnectionId ?? null, params: paramsJson ?? undefined, status: statusFilter }
      : MAILBOX_SCOPED_KINDS.includes(opts.kind)
        ? { shop: opts.shop, kind: opts.kind, mailConnectionId: opts.mailConnectionId ?? null, status: statusFilter }
        : { shop: opts.shop, kind: opts.kind, status: statusFilter },
    select: { id: true },
  });
  if (existing) return existing.id;

  const job = await prisma.syncJob.create({
    data: {
      shop: opts.shop,
      kind: opts.kind,
      mailConnectionId: opts.mailConnectionId ?? null,
      params: opts.params ? JSON.stringify(opts.params) : undefined,
    },
    select: { id: true },
  });
  return job.id;
}

interface ClaimedJobRow {
  id: string;
  shop: string;
  kind: string;
  mailConnectionId: string | null;
  params: string;
  attempts: number;
}

/**
 * Atomically claim the next pending job, enforcing per-mailbox isolation
 * with a per-shop running-job cap.
 *
 * The claim query (mailbox granularity, default):
 *   1. picks the oldest `pending` job whose backoff window has elapsed,
 *   2. whose `mailConnectionId` is NOT already running in this process
 *      (shop-wide jobs with mailConnectionId IS NULL are not excluded by
 *      this filter — they only count toward the per-shop cap),
 *   3. whose shop has NOT reached HARD_CAP_PER_SHOP running jobs,
 *   4. using `FOR UPDATE SKIP LOCKED` so concurrent claimers never
 *      fight over the same row.
 *
 * Legacy fallback (JOB_LOCK_GRANULARITY=shop):
 *   Restores the original behaviour — any shop with a running job is
 *   fully excluded (one job per shop at a time).
 *
 * Returns null if nothing is ready.
 */
export async function claimNextJob(
  running: RunningSet = { mailConnectionIds: new Set(), perShopCount: new Map() },
): Promise<{
  id: string;
  shop: string;
  kind: SyncJobKind;
  mailConnectionId: string | null;
  params: Record<string, unknown>;
  attempts: number;
} | null> {
  const lockGranularity =
    process.env.JOB_LOCK_GRANULARITY === "shop" ? "shop" : "mailbox";

  // In shop-granularity mode (legacy), every shop with any running job is
  // excluded — same as the old behaviour.
  // In mailbox-granularity mode (default), only shops that have reached the
  // hard cap are excluded.
  const shopsAtCap =
    lockGranularity === "mailbox"
      ? shopsThatReachedTheirCap(running.perShopCount)
      : Array.from(running.perShopCount.keys());

  const excludedMailboxIds = Array.from(running.mailConnectionIds);

  // Prisma.join requires a non-empty array. Use a sentinel value that can
  // never match a real ID when the set is empty.
  const mailboxFilter =
    excludedMailboxIds.length > 0
      ? Prisma.sql`AND ("mailConnectionId" IS NULL OR "mailConnectionId" NOT IN (${Prisma.join(excludedMailboxIds)}))`
      : Prisma.empty;

  const shopCapFilter =
    shopsAtCap.length > 0
      ? Prisma.sql`AND shop NOT IN (${Prisma.join(shopsAtCap)})`
      : Prisma.empty;

  // NOTE: The subquery check runs BEFORE the row lock, so two workers can
  // theoretically both claim a job for the same mailbox within a millisecond.
  // We retry up to 3 times on P2002 (unique violation) to handle the race.
  let rows: ClaimedJobRow[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rows = await prisma.$queryRaw<ClaimedJobRow[]>`
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
            ${mailboxFilter}
            ${shopCapFilter}
          ORDER BY "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, shop, kind, "mailConnectionId", params, attempts
      `;
      break;
    } catch (err) {
      // P2002 = unique violation — another worker won the race for this
      // mailbox/shop; retry since a different job may be available.
      const code = (err as { code?: string }).code;
      if (code === "P2002" && attempt < 2) continue;
      throw err;
    }
  }

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
    mailConnectionId: row.mailConnectionId,
    params,
    attempts: row.attempts,
  };
}

/**
 * Returns shops whose running-job count has reached or exceeded the
 * per-shop hard cap. These shops are skipped by `claimNextJob` until a
 * slot frees up.
 */
function shopsThatReachedTheirCap(perShopCount: Map<string, number>): string[] {
  // Cap of 3 concurrent jobs per shop: enough for 3 mailboxes to sync in
  // parallel without letting one shop monopolise the worker pool.
  const HARD_CAP_PER_SHOP = 3;
  const result: string[] = [];
  for (const [shop, count] of perShopCount) {
    if (count >= HARD_CAP_PER_SHOP) result.push(shop);
  }
  return result;
}

/**
 * Bump a running job's `startedAt` so the zombie reclaimer treats it as
 * still alive. Called periodically by the worker for legitimate long-running
 * jobs (e.g. heavy onboarding backfills). If two workers race a heartbeat
 * write, the later one wins — that's fine, both writes prove the job is alive.
 *
 * Uses Postgres NOW() rather than the application clock so the heartbeat
 * is on the same time-base as claimNextJob's startedAt write — avoids
 * spurious "went backwards" comparisons when app and DB clocks differ.
 */
export async function heartbeatJob(id: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "SyncJob"
    SET "startedAt" = NOW()
    WHERE id = ${id} AND status = 'running'
  `;
}

export async function markJobDone(id: string): Promise<void> {
  await prisma.syncJob.update({
    where: { id },
    data: { status: "done", finishedAt: new Date(), lastError: null },
  });
}

/**
 * Errors that should NOT be retried — they mean "this will never succeed
 * without merchant intervention". Going straight to `status='error'` lets
 * the inbox UI surface a "reconnect mailbox" CTA instead of silently
 * retrying for hours before giving up.
 *
 * Detection patterns (matched against the error message):
 *   - `MAILBOX_REVOKED` / `Mailbox revoked` → MailboxRevokedError marker
 *   - `invalid_grant` / `invalid_client` → OAuth refresh token revoked
 *   - HTTP 401 / 403 in the message → auth-level rejection
 *
 * Anything else is treated as transient (network, 5xx, timeout, throttle).
 */
function isPermanentFailure(message: string): boolean {
  return (
    /MAILBOX_REVOKED|Mailbox revoked/i.test(message) ||
    /invalid_grant|invalid_client/i.test(message) ||
    /\bHTTP 40[13]\b/.test(message) ||
    /\b40[13] /.test(message)
  );
}

export async function markJobFailed(id: string, err: unknown, knownAttempts?: number): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  let attempts: number;
  if (knownAttempts !== undefined) {
    attempts = knownAttempts;
  } else {
    const job = await prisma.syncJob.findUnique({
      where: { id },
      select: { attempts: true },
    });
    attempts = job?.attempts ?? 0;
  }
  // Permanent failures (revoked token, 401/403) short-circuit retries
  // and go straight to status='error'. The merchant sees a reconnect
  // banner; ops doesn't waste retries on a dead credential.
  const permanent = isPermanentFailure(message);
  const exhausted = permanent || attempts >= MAX_ATTEMPTS;
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

