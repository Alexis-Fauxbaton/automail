// Backend auto-sync loop (spec §10).
//
// A single in-process timer wakes up every `TICK_MS`. Each tick:
//   1. Reclaims zombie jobs (running but startedAt > ZOMBIE_TIMEOUT_MS ago).
//   2. Enqueues time-based periodic syncs for due shops.
//   3. Drains the SyncJob queue up to MAX_CONCURRENT slots in parallel.
//
// Multi-shop isolation is enforced by the job queue itself: `claimNextJob`
// never returns a job for a shop that already has a running job, so a slow
// shop can never starve or stall another shop. Slots work on distinct shops
// in parallel.
//
// The job queue handles durability and retries; this loop is just a scheduler.
// For horizontal multi-instance deployments, `claimNextJob` uses
// `FOR UPDATE SKIP LOCKED` and is safe against concurrent claimers. Replacing
// `setInterval` with an external cron trigger (Render cron, pg_cron, etc.)
// would remove the need for this process to stay alive — a natural next step
// when scaling out.

import prisma from "../../db.server";
import { processNewEmails } from "../gmail/pipeline";
import { unauthenticated } from "../../shopify.server";
import { resolveEntitlements } from "../billing/entitlements";
import { runManualBackfill, runOnboardingBackfill } from "./backfill";
import { recomputeAllOpenThreads, recomputeAllThreadsForShop } from "../support/thread-state";
import { refreshStaleAnalysesForShop } from "../support/refresh-stale-analyses";
import { pruneOldRateLimitBuckets } from "../rate-limit";
import { withTimeout } from "../util/with-timeout";
import {
  autoSyncJobsTotal,
  autoSyncJobDurationSeconds,
  autoSyncInFlight,
  autoSyncLeader,
  startTimer,
} from "../metrics/definitions";
import {
  claimNextJob,
  enqueueJob,
  heartbeatJob,
  markJobDone,
  markJobFailed,
  reclaimZombieJobs,
  type SyncJobKind,
} from "./job-queue";

const TICK_MS = 60_000;              // check every minute
const STARTUP_DELAY_MS = 15_000;     // wait a bit after boot
// Parallel job slots (across distinct shops). One slow shop must never
// block another shop's sync, so we process several shops concurrently.
// Kept conservative: raise via AUTOSYNC_CONCURRENCY when your worker has
// spare IO/CPU budget.
const MAX_CONCURRENT = Math.max(
  1,
  Number(process.env.AUTOSYNC_CONCURRENCY ?? "4"),
);
// Reclaim jobs stuck > 10 min in "running". Lowered from 30 min so a
// deploy that interrupts a long backfill is recovered quickly. Legitimate
// syncs must complete in under 10 min — anything longer is treated as dead.
const ZOMBIE_TIMEOUT_MS = 10 * 60_000;

let started = false;
let _intervalHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = 0;
let shuttingDown = false;
const runningShops = new Set<string>();
let isLeader = false;

// Postgres advisory-lock key used for cross-process leader election. Any
// stable 64-bit integer is fine; we pick a fixed constant so every replica
// races for the same lock. Only the worker that holds the lock schedules
// new work; followers idle until promoted (e.g. when the leader exits).
const AUTOSYNC_LOCK_KEY = 7423901835n; // arbitrary, project-specific

async function tryAcquireLeaderLock(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<Array<{ ok: boolean }>>`
      SELECT pg_try_advisory_lock(${AUTOSYNC_LOCK_KEY}) AS ok
    `;
    return rows[0]?.ok === true;
  } catch (err) {
    console.error("[auto-sync] advisory lock acquire failed:", err);
    return false;
  }
}

async function releaseLeaderLock(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${AUTOSYNC_LOCK_KEY})`;
  } catch (err) {
    console.error("[auto-sync] advisory unlock failed:", err);
  }
}

/**
 * Start the background auto-sync loop. Idempotent — safe to call
 * multiple times (e.g. during hot reload).
 */
export function startAutoSyncLoop(): void {
  if (started) return;
  started = true;
  shuttingDown = false;
  setTimeout(() => {
    tick().catch((err) =>
      console.error("[auto-sync] initial tick failed:", err),
    );
    _intervalHandle = setInterval(() => {
      tick().catch((err) =>
        console.error("[auto-sync] tick failed:", err),
      );
    }, TICK_MS);
  }, STARTUP_DELAY_MS);
  console.log(
    `[auto-sync] background loop scheduled (maxConcurrent=${MAX_CONCURRENT})`,
  );
}

async function tick(): Promise<void> {
  // Stop scheduling new work once shutdown has been requested. Jobs already
  // in flight keep running until they finish or the process exits.
  if (shuttingDown) return;
  // Leader election via Postgres advisory lock. With multiple workers
  // (cluster mode, Render with N instances) only one schedules work; the
  // others sit idle until they win the lock on the next tick (e.g. after
  // the leader shuts down or restarts). This keeps the 17track breaker,
  // boot-cleanup, and entitlement-check storms single-instance even when
  // we scale horizontally.
  // Honoured-by-env: set AUTOSYNC_LEADER_LOCK=off to skip and have every
  // worker schedule (only sensible if the deployment is guaranteed single
  // process and the dev wants to bypass the round-trip).
  if (process.env.AUTOSYNC_LEADER_LOCK !== "off") {
    if (!isLeader) {
      isLeader = await tryAcquireLeaderLock();
      if (!isLeader) {
        autoSyncLeader.set(0);
        return; // follower: try again next tick
      }
      autoSyncLeader.set(1);
      console.log("[auto-sync] elected leader for this instance");
    }
  } else {
    autoSyncLeader.set(1);
  }
  // 1. Reset jobs whose workers died without completing (OOM, restart, timeout).
  await reclaimZombieJobs(ZOMBIE_TIMEOUT_MS).catch((err) =>
    console.error("[auto-sync] zombie reclaim failed:", err),
  );
  // 2. Convert due periodic syncs into SyncJob rows (de-dup is inside enqueueJob).
  await enqueueDuePeriodicSyncs();
  // 3. Enqueue a recompute job for any shop that still has threads stuck
  //    in the default "open" state (de-dup prevents duplicate jobs).
  await enqueueRecomputeIfNeeded();
  // 4. Execute pending jobs up to the concurrency limit.
  await drainJobQueue();
  // 5. Best-effort cleanup of stale rate-limit buckets. Cheap, idempotent,
  //    and prevents the table from growing unbounded over time.
  await pruneOldRateLimitBuckets().catch((err) =>
    console.error("[auto-sync] rate-limit prune failed:", err),
  );
}

/**
 * For every shop whose `lastSyncAt` is older than its
 * `autoSyncIntervalMinutes`, enqueue one "sync" job (de-dup is handled
 * inside `enqueueJob`, so a pending/running job blocks repeats).
 */
export async function enqueueDuePeriodicSyncs(): Promise<void> {
  try {
  const now = new Date();
  // Coarse pre-filter: only fetch connections whose lastSyncAt is null OR
  // older than 1 minute (the minimum sync interval). This cuts fetched rows
  // in large deployments without changing correctness — the per-connection
  // fine-grained check below remains the authoritative gate.
  const oneMinuteAgo = new Date(now.getTime() - 60_000);
  const connections = await prisma.mailConnection.findMany({
    where: {
      autoSyncEnabled: true,
      OR: [
        { lastSyncAt: null },
        { lastSyncAt: { lte: oneMinuteAgo } },
      ],
    },
    select: {
      shop: true,
      lastSyncAt: true,
      autoSyncIntervalMinutes: true,
      onboardingBackfillDoneAt: true,
      onboardingBackfillDays: true,
    },
  });

  // Collect shops that have an active Shopify offline session.
  // Offline sessions (isOnline: false) are the durable shop-level tokens.
  const shopList = connections.map((c) => c.shop);
  const activeSessions = shopList.length > 0
    ? await prisma.session.findMany({
        where: {
          shop: { in: shopList },
          isOnline: false,
          OR: [
            { expires: null },
            { expires: { gt: new Date() } },
          ],
        },
        select: { shop: true },
      })
    : [];
  const activeShops = new Set(activeSessions.map((s) => s.shop));

  for (const c of connections) {
    if (!activeShops.has(c.shop)) continue; // no valid Shopify session
    const intervalMs = Math.max(1, c.autoSyncIntervalMinutes) * 60_000;
    const due =
      !c.lastSyncAt || now.getTime() - c.lastSyncAt.getTime() >= intervalMs;
    if (!due) continue;
    // Entitlement check is deferred to runJob so a slow Shopify response
    // on one shop never serialises the scheduling loop for other shops.
    await enqueueJob(c.shop, "sync").catch((err) =>
      console.error(`[auto-sync] enqueue periodic for ${c.shop} failed:`, err),
    );
  }
  } catch (err) {
    console.error("[auto-sync] enqueueDuePeriodicSyncs failed:", err);
  }
}

/**
 * Claim and execute jobs until either the queue is empty or we hit the
 * concurrency limit. Each job runs on a distinct shop — `claimNextJob`
 * guarantees no two concurrent jobs for the same shop (DB-level filter).
 *
 * The local `runningShops` set is passed to `claimNextJob` as an extra
 * safety net that avoids a round-trip race inside the same tick.
 */
async function drainJobQueue(): Promise<void> {
  while (inFlight < MAX_CONCURRENT) {
    if (shuttingDown) return;
    const job = await claimNextJob([...runningShops]);
    if (!job) break;
    // Increment synchronously before firing — prevents the while loop from
    // over-claiming slots or the same shop within the same tick.
    inFlight++;
    runningShops.add(job.shop);
    autoSyncInFlight.set(inFlight);
    // Fire-and-forget: each slot runs in parallel. Bookkeeping happens
    // inside runJob's finally block.
    void runJob(job);
  }
}

/**
 * For every shop that has threads still in the default "open" state
 * (never recomputed), enqueue one "recompute" job. The de-dup inside
 * `enqueueJob` ensures at most one pending/running job per shop at a time.
 */
async function enqueueRecomputeIfNeeded(): Promise<void> {
  try {
    // Only target threads whose operationalState has NEVER been computed
    // (operationalStateUpdatedAt IS NULL). Threads that were already processed
    // but legitimately stay "open" (e.g. outgoing-only) must NOT trigger a new
    // job every tick — that would create an infinite recompute loop.
    const staleShops = await prisma.thread.groupBy({
      by: ["shop"],
      where: { operationalState: "open", operationalStateUpdatedAt: null },
    });
    for (const { shop } of staleShops) {
      await enqueueJob(shop, "recompute").catch((err) =>
        console.error(`[auto-sync] enqueue recompute for ${shop} failed:`, err),
      );
    }
  } catch (err) {
    console.error("[auto-sync] enqueueRecomputeIfNeeded failed:", err);
  }
}

async function runJob(job: {
  id: string;
  shop: string;
  kind: SyncJobKind;
  params: Record<string, unknown>;
  attempts: number;
}): Promise<void> {
  // bookkeeping moved to drainJobQueue
  const startedAt = Date.now();
  const stopTimer = startTimer();
  let finalStatus: "ok" | "error" | "suspended" = "ok";

  // Heartbeat the row every 2 min so a legitimate long-running job (heavy
  // backfill on a big shop) isn't reclaimed as a zombie by a peer worker.
  // Cleared in the finally below.
  const heartbeat = setInterval(() => {
    heartbeatJob(job.id).catch(() => { /* best-effort */ });
  }, 2 * 60_000);

  try {
    // Entitlement gate: moved here from the scheduler so one shop's slow
    // Shopify response can't serialise the scheduling loop.
    // Fail-open on errors (e.g. transient Shopify outage) so paying shops
    // aren't blocked from syncing by a billing-API blip.
    //
    // Per-conversation billing nuance: under suspension, "sync" and "resync"
    // still run with `tier3Allowed=false` so merchants keep seeing new mails
    // classified support/non-support, only the expensive Tier 3 (intent +
    // Shopify + tracking + draft) is gated. Heavier kinds (backfill, recompute,
    // reclassify, analyze_thread) remain fully blocked.
    let isSuspended = false;
    try {
      const { admin } = await withTimeout(
        unauthenticated.admin(job.shop),
        10_000,
        `unauthenticated.admin(${job.shop})`,
      );
      const ent = await withTimeout(
        resolveEntitlements({ shop: job.shop, admin }),
        10_000,
        `resolveEntitlements(${job.shop})`,
      );
      isSuspended = ent.isSyncSuspended;
      if (isSuspended && job.kind !== "sync" && job.kind !== "resync") {
        console.log(`[auto-sync] skipping ${job.shop} ${job.kind} — sync suspended (state=${ent.state})`);
        finalStatus = "suspended";
        await markJobDone(job.id);
        return;
      }
    } catch (err) {
      console.error(`[auto-sync] entitlement lookup failed for ${job.shop} (fail-open):`, err);
    }

    switch (job.kind) {
      case "sync":
      case "resync": {
        const conn = await prisma.mailConnection.findUnique({
          where: { shop: job.shop },
          select: {
            onboardingBackfillDoneAt: true,
            onboardingBackfillDays: true,
          },
        });
        await runSyncForShop(job.shop, {
          runOnboarding: !conn?.onboardingBackfillDoneAt,
          onboardingDays: conn?.onboardingBackfillDays ?? 60,
          tier3Allowed: !isSuspended,
        });
        break;
      }
      case "backfill": {
        const afterDateIso = String(job.params.afterDateIso ?? "");
        if (!afterDateIso) throw new Error("backfill job missing afterDateIso");
        const res = await runManualBackfill(job.shop, new Date(afterDateIso));
        console.log(
          `[auto-sync] shop=${job.shop} backfill: ingested=${res.ingested} skipped=${res.skipped}`,
        );
        break;
      }
      case "recompute": {
        const conn = await prisma.mailConnection.findUnique({
          where: { shop: job.shop },
          select: { email: true },
        });
        const res = await recomputeAllOpenThreads(job.shop, {
          mailboxAddress: conn?.email ?? "",
        });
        console.log(
          `[auto-sync] shop=${job.shop} recompute: processed=${res.processed} errors=${res.errors}`,
        );
        break;
      }
      case "reclassify": {
        // Recompute ALL threads (not just open/uninitialized ones).
        // Used to recover threads incorrectly set to "no_reply_needed" or
        // "waiting_customer" by a faulty resync. Manually-resolved threads
        // are protected inside recomputeThreadState.
        const conn = await prisma.mailConnection.findUnique({
          where: { shop: job.shop },
          select: { email: true },
        });
        const res = await recomputeAllThreadsForShop(job.shop, {
          mailboxAddress: conn?.email ?? "",
        });
        console.log(
          `[auto-sync] shop=${job.shop} reclassify: processed=${res.processed} errors=${res.errors}`,
        );
        break;
      }
      case "analyze_thread": {
        const threadId = String(job.params.threadId ?? "");
        if (!threadId) throw new Error("analyze_thread job missing threadId");
        const conn = await prisma.mailConnection.findUnique({
          where: { shop: job.shop },
          select: { email: true },
        });
        // Pick the latest analyzable email of the thread as anchor.
        const anchor = await prisma.incomingEmail.findFirst({
          where: {
            shop: job.shop,
            canonicalThreadId: threadId,
            processingStatus: { notIn: ["outgoing", "error"] },
            tier1Result: "passed",
          },
          orderBy: { receivedAt: "desc" },
          select: { id: true },
        });
        if (!anchor) {
          console.log(`[auto-sync] analyze_thread skipped: no anchor for thread=${threadId} shop=${job.shop}`);
          break;
        }
        // Need a fresh admin client here — the entitlement try-block above
        // scoped its `admin` locally. Mirror the pattern used by runSyncForShop.
        let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
        try {
          ({ admin } = await withTimeout(
            unauthenticated.admin(job.shop),
            10_000,
            `unauthenticated.admin(${job.shop})`,
          ));
        } catch (err) {
          if (err instanceof Response) {
            throw new Error(`Shopify auth failed for shop ${job.shop}: HTTP ${err.status} ${err.statusText || err.url}`);
          }
          throw err;
        }
        const { reanalyzeEmail } = await import("../gmail/pipeline");
        await reanalyzeEmail(anchor.id, admin, job.shop, { skipDraft: true });
        // markThreadAnalyzedIfFirst was called inside reanalyzeEmail.
        console.log(`[auto-sync] analyze_thread ok thread=${threadId} shop=${job.shop} mailbox=${conn?.email ?? "?"}`);
        break;
      }
      default:
        throw new Error(`[auto-sync] unknown job kind: ${job.kind}`);
    }
    await markJobDone(job.id);
    console.log(
      `[auto-sync] shop=${job.shop} job=${job.kind} ok durationMs=${Date.now() - startedAt}`,
    );
  } catch (err) {
    console.error(
      `[auto-sync] shop=${job.shop} job=${job.id} kind=${job.kind} failed after ${Date.now() - startedAt}ms:`,
      err,
    );
    finalStatus = "error";
    await markJobFailed(job.id, err, job.attempts).catch(() => {});
  } finally {
    clearInterval(heartbeat);
    inFlight = Math.max(0, inFlight - 1);
    runningShops.delete(job.shop);
    autoSyncInFlight.set(inFlight);
    autoSyncJobsTotal.inc({ shop: job.shop, kind: job.kind, status: finalStatus });
    autoSyncJobDurationSeconds.observe(
      { kind: job.kind, status: finalStatus },
      stopTimer(),
    );
  }
}

/**
 * Execute one sync for a shop. Caller owns concurrency bookkeeping
 * (see `runJob`). Errors bubble up so the queue can mark the job
 * failed / schedule a retry.
 */
async function runSyncForShop(
  shop: string,
  opts: { runOnboarding: boolean; onboardingDays: number; tier3Allowed?: boolean },
): Promise<void> {
  const tier3Allowed = opts.tier3Allowed ?? true;
  // unauthenticated.admin may throw a Response object (Remix redirect) when
  // the shop's offline token is missing or expired. Convert it to a proper
  // Error so markJobFailed captures a readable message.
  let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
  try {
    ({ admin } = await withTimeout(
      unauthenticated.admin(shop),
      10_000,
      `unauthenticated.admin(${shop})`,
    ));
  } catch (err) {
    if (err instanceof Response) {
      throw new Error(`Shopify auth failed for shop ${shop}: HTTP ${err.status} ${err.statusText || err.url}`);
    }
    throw err;
  }
  if (opts.runOnboarding) {
    try {
      const res = await runOnboardingBackfill(shop, opts.onboardingDays);
      console.log(
        `[auto-sync] shop=${shop} onboarding backfill: ingested=${res.ingested} skipped=${res.skipped}`,
      );
    } catch (err) {
      // Onboarding failure must not block the regular sync that
      // follows — it'll be retried on the next tick.
      console.error(`[auto-sync] shop=${shop} onboarding backfill failed:`, err);
    }
  }
  const report = await processNewEmails(shop, admin, { tier3Allowed });
  console.log(
    `[auto-sync] shop=${shop} fetched=${report.total} support=${report.supportClient} errors=${report.errors} tier3Allowed=${tier3Allowed}`,
  );

  // Best-effort refresh of active thread analyses every sync tick — independently
  // of whether new mail arrived. The adaptive cutoff inside refreshStaleAnalysesForShop
  // (pickCutoffForAnalysis: pending → 5 min, error → 10 min, ok / skipped → 1h)
  // already gates work per-thread, and the per-pass budget caps it at 10 candidates,
  // so running it every tick is cheap. Decoupling from `report.total > 0` ensures
  // a transient 17track failure on a calm shop still gets retried promptly.
  try {
    const res = await refreshStaleAnalysesForShop(shop, admin);
    if (res.refreshed > 0 || res.errors > 0) {
      console.log(
        `[auto-sync] shop=${shop} stale-refresh: refreshed=${res.refreshed} errors=${res.errors}`,
      );
    }
  } catch (err) {
    console.error(`[auto-sync] shop=${shop} stale-refresh failed:`, err);
  }
}

// Reset the singleton guard on hot reload so the loop doesn't duplicate.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (_intervalHandle) {
      clearInterval(_intervalHandle);
      _intervalHandle = null;
    }
    if (isLeader) {
      releaseLeaderLock().catch(() => { /* best-effort */ });
      isLeader = false;
    }
    started = false;
    shuttingDown = false;
  });
}

/**
 * Stop scheduling new work and wait for in-flight jobs to drain. Call this
 * from a SIGTERM/SIGINT handler before `process.exit`. After `timeoutMs`,
 * we return regardless — any still-running jobs will be picked up by the
 * zombie reclaim on the next deploy (max ZOMBIE_TIMEOUT_MS of retry delay).
 *
 * Returns the number of jobs still in flight when the wait ended.
 */
export async function stopAutoSyncLoop(timeoutMs = 25_000): Promise<number> {
  if (!started) return 0;
  shuttingDown = true;
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
  const deadline = Date.now() + timeoutMs;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (inFlight > 0) {
    console.warn(
      `[auto-sync] shutdown drain timed out after ${timeoutMs}ms with ${inFlight} job(s) still running — they will be reclaimed as zombies`,
    );
  } else {
    console.log("[auto-sync] graceful shutdown complete");
  }
  if (isLeader) {
    await releaseLeaderLock();
    isLeader = false;
  }
  return inFlight;
}

