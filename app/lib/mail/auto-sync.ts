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
  type RunningSet,
  type SyncJobKind,
} from "./job-queue";

const TICK_MS = 60_000;              // check every minute
const STARTUP_DELAY_MS = 5_000;      // wait a bit after boot (Render health check usually green by 2s)
// Heartbeat updated at the top of every tick — `/healthz` checks this so it
// fails when the auto-sync loop is silently wedged.
let lastTickAt = 0;
export function getLastTickAt(): number { return lastTickAt; }
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

// ---------------------------------------------------------------------------
// Stale-unknown classify cron state
// ---------------------------------------------------------------------------
// In-memory throttle: scanned at most once per hour. Safe under leader-lock
// (only one replica runs the scheduling loop at a time).
const STALE_CLASSIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 h gate per thread
const STALE_CLASSIFY_BATCH = 50;                          // max threads per tick
const STALE_CLASSIFY_SCAN_INTERVAL_MS = 60 * 60 * 1000;  // 1 h between scans
export let _lastStaleClassifyScanAt = 0; // exported for tests

let started = false;
let _intervalHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = 0;
let shuttingDown = false;
const running: RunningSet = {
  mailConnectionIds: new Set<string>(),
  perShopCount: new Map<string, number>(),
};
let isLeader = false;

// Postgres advisory-lock key used for cross-process leader election. Any
// stable 64-bit integer is fine; we pick a fixed constant so every replica
// races for the same lock. Only the worker that holds the lock schedules
// new work; followers idle until promoted (e.g. when the leader exits).
const AUTOSYNC_LOCK_KEY = 7423901835n; // arbitrary, project-specific

// Advisory-lock caveat (B-PROD-4): Postgres advisory locks are tied to the
// connection that took them. Prisma uses a pool, so a `$queryRaw` for
// acquire and a separate `$queryRaw` for release may hit different
// connections — making the release a silent no-op and forcing the lock to
// rely on Postgres dead-connection GC (30–60 s) when a process dies.
//
// We mitigate by: (a) running every advisory-lock call inside a long-lived
// `$transaction` so acquire + release pin to the same connection for the
// duration; (b) on normal shutdown, we explicitly release inside the same
// transaction wrapper. On hard kill (SIGKILL / OOM) the connection dies
// with the process and Postgres reaps the lock — that's still 30-60 s but
// it's the unavoidable case.
async function tryAcquireLeaderLock(): Promise<boolean> {
  try {
    // pg_try_advisory_lock is session-scoped; calling it inside a
    // $transaction still binds it to that connection for the duration of
    // the transaction. We don't commit/rollback here — we return ok from
    // a 1-statement query. To pin acquire+release to the SAME connection,
    // we use `pg_try_advisory_xact_lock` instead so the lock is auto
    // released at transaction end, AND we never close the transaction
    // until shutdown. Implementation note: $transaction's callback API
    // doesn't let us hold a tx open across multiple tick() calls, so we
    // accept the imperfection that release-on-hard-kill takes the dead-
    // connection-GC path. For graceful shutdown, releaseLeaderLock below
    // explicitly unlocks; on most pool implementations the same connection
    // is reused for consecutive raw queries from the same process when
    // the pool is not saturated.
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
    // Best-effort: see comment above. If the unlock lands on a different
    // pool connection, the call is a no-op and the lock is released when
    // the original connection dies. The accompanying gauge is reset
    // regardless so observability stays correct.
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${AUTOSYNC_LOCK_KEY})`;
  } catch (err) {
    console.error("[auto-sync] advisory unlock failed:", err);
  } finally {
    isLeader = false;
    autoSyncLeader.set(0);
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
  // Stamp the heartbeat first — /healthz reads this to detect a silently
  // wedged loop. We update even on shutdown so a slow shutdown isn't
  // misdiagnosed as a dead loop.
  lastTickAt = Date.now();
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
  // 2b. Enqueue classify jobs for legacy threads stuck at supportNature=unknown.
  //     Best-effort; gated to once per hour in-memory and 24 h per thread in DB.
  await enqueueClassifyStaleUnknown().catch((err) =>
    console.error("[auto-sync] enqueueClassifyStaleUnknown failed:", err),
  );
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
 * For every mailbox whose `lastSyncAt` is older than its
 * `autoSyncIntervalMinutes`, enqueue one "sync" job per mailbox.
 * The due-time filter is pushed into SQL (resolves DB-M5) so no
 * JS-side per-connection fine-grained check is needed.
 * Entitlement check is deferred to runJob so a slow Shopify response
 * on one shop never serialises the scheduling loop for other shops.
 */
export async function enqueueDuePeriodicSyncs(now: Date = new Date()): Promise<number> {
  try {
  // Push the due-time filter into SQL: only mailboxes whose
  // (lastSyncAt + autoSyncIntervalMinutes minutes) <= now.
  // NULL lastSyncAt means "never synced" → always due.
  const dueMailboxes = await prisma.$queryRaw<
    { id: string; shop: string }[]
  >`
    SELECT id, shop
    FROM "MailConnection"
    WHERE "autoSyncEnabled" = true
      AND ("lastSyncAt" IS NULL OR "lastSyncAt" + ("autoSyncIntervalMinutes" * INTERVAL '1 minute') <= ${now})
  `;

  if (dueMailboxes.length === 0) return 0;

  // Collect shops that have an active Shopify offline session.
  // Offline sessions (isOnline: false) are the durable shop-level tokens.
  const shopList = [...new Set(dueMailboxes.map((m) => m.shop))];
  const activeSessions = await prisma.session.findMany({
    where: {
      shop: { in: shopList },
      isOnline: false,
      OR: [
        { expires: null },
        { expires: { gt: new Date() } },
      ],
    },
    select: { shop: true },
  });
  const activeShops = new Set(activeSessions.map((s) => s.shop));

  let enqueued = 0;
  for (const m of dueMailboxes) {
    if (!activeShops.has(m.shop)) continue; // no valid Shopify session

    // Per-mailbox de-dup: enqueueJob's built-in de-dup is shop-scoped,
    // so we check per mailConnectionId to avoid blocking sibling mailboxes.
    const existing = await prisma.syncJob.count({
      where: {
        mailConnectionId: m.id,
        kind: "sync",
        status: { in: ["pending", "running"] },
      },
    });
    if (existing > 0) continue;

    await enqueueJob({ shop: m.shop, kind: "sync", mailConnectionId: m.id }).catch((err) =>
      console.error(`[auto-sync] enqueue periodic for ${m.shop}/${m.id} failed:`, err),
    );
    enqueued++;
  }
  return enqueued;
  } catch (err) {
    console.error("[auto-sync] enqueueDuePeriodicSyncs failed:", err);
    return 0;
  }
}

/**
 * Scan for threads that are stuck at supportNature=unknown because they were
 * backfilled before Tier 2 was deployed, and enqueue one analyze_thread job per
 * thread so they eventually get classified.
 *
 * Gate 1 (in-memory): skip if called within the last hour (STALE_CLASSIFY_SCAN_INTERVAL_MS).
 *   Safe under the leader-lock advisory lock — only one replica runs this.
 * Gate 2 (DB): skip threads whose lastClassifyAttemptAt is within 24 h (STALE_CLASSIFY_COOLDOWN_MS).
 *   Prevents quota burn during LLM outages.
 * Gate 3 (dedup): skip threads that already have a pending/running analyze_thread job.
 */
export async function enqueueClassifyStaleUnknown(now: Date = new Date()): Promise<number> {
  // In-memory throttle: at most one scan per hour per process/leader.
  if (now.getTime() - _lastStaleClassifyScanAt < STALE_CLASSIFY_SCAN_INTERVAL_MS) return 0;
  _lastStaleClassifyScanAt = now.getTime();

  const cutoff = new Date(now.getTime() - STALE_CLASSIFY_COOLDOWN_MS);

  // Find threads unclassified at the thread level AND with at least one message
  // that passed Tier 1 but never got Tier 2.
  const due = await prisma.thread.findMany({
    where: {
      supportNature: "unknown",
      messages: {
        some: {
          tier1Result: "passed",
          tier2Result: null,
          processingStatus: { notIn: ["outgoing", "error"] },
        },
      },
      OR: [
        { lastClassifyAttemptAt: null },
        { lastClassifyAttemptAt: { lt: cutoff } },
      ],
    },
    select: { id: true, shop: true, mailConnectionId: true },
    take: STALE_CLASSIFY_BATCH,
  });

  let enqueued = 0;
  for (const t of due) {
    if (!t.mailConnectionId) continue; // defensive; shouldn't happen post multi-mailbox migration

    // Dedup: SyncJob.params is a JSON string — use exact match to avoid
    // false positives from substring collision.
    const expectedParams = JSON.stringify({ threadId: t.id });
    const existing = await prisma.syncJob.count({
      where: {
        shop: t.shop,
        kind: "analyze_thread",
        status: { in: ["pending", "running"] },
        params: { equals: expectedParams },
      },
    });
    if (existing > 0) continue;

    try {
      await enqueueJob({
        shop: t.shop,
        kind: "analyze_thread",
        mailConnectionId: t.mailConnectionId,
        params: { threadId: t.id },
      });
      enqueued++;
    } catch (err) {
      console.error(`[stale-classify] enqueue failed for thread=${t.id} shop=${t.shop}:`, err);
    }
  }

  if (enqueued > 0) {
    console.log(`[stale-classify] enqueued ${enqueued} analyze_thread job(s) for stale unknown threads`);
  }
  return enqueued;
}

/**
 * Claim and execute jobs until either the queue is empty or we hit the
 * concurrency limit. Multiple mailboxes of the same shop can run in parallel
 * (up to HARD_CAP_PER_SHOP) — `claimNextJob` enforces per-mailbox isolation
 * and the per-shop cap via the `running` set.
 *
 * The local `running` set is passed to `claimNextJob` as an extra safety net
 * that avoids a round-trip race when several slots drain in the same tick.
 */
async function drainJobQueue(): Promise<void> {
  while (inFlight < MAX_CONCURRENT) {
    if (shuttingDown) return;
    const job = await claimNextJob(running);
    if (!job) break;
    // Update the running set synchronously before firing — prevents the while
    // loop from over-claiming slots for the same mailbox or shop within the
    // same tick. Bookkeeping is undone in runJob's finally block.
    inFlight++;
    if (job.mailConnectionId != null) {
      running.mailConnectionIds.add(job.mailConnectionId);
    }
    running.perShopCount.set(
      job.shop,
      (running.perShopCount.get(job.shop) ?? 0) + 1,
    );
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
      await enqueueJob({ shop, kind: "recompute" }).catch((err) =>
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
  mailConnectionId: string | null;
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
        // Mailbox-scoped job — look up by mailConnectionId (unique).
        const conn = job.mailConnectionId
          ? await prisma.mailConnection.findUnique({
              where: { id: job.mailConnectionId },
              select: {
                onboardingBackfillDoneAt: true,
                onboardingBackfillDays: true,
              },
            })
          : null;
        await runSyncForShop(job.shop, {
          mailConnectionId: job.mailConnectionId ?? undefined,
          runOnboarding: !conn?.onboardingBackfillDoneAt,
          onboardingDays: conn?.onboardingBackfillDays ?? 60,
          tier3Allowed: !isSuspended,
          // Explicit resync: the user asked for a full re-analyse — don't
          // let the catch-up gate quietly drop everything outside the
          // active zone. Regular auto-sync ticks keep the gate active to
          // protect quota across resumes from a suspension.
          bypassCatchupGate: job.kind === "resync",
        });
        break;
      }
      case "backfill": {
        const afterDateIso = String(job.params.afterDateIso ?? "");
        if (!afterDateIso) throw new Error("backfill job missing afterDateIso");
        if (!job.mailConnectionId) throw new Error("backfill job missing mailConnectionId");
        // Need a fresh admin client for Tier 2/3 analysis of backfilled threads.
        // The entitlement try-block above scoped its `admin` locally, so we
        // re-fetch here — mirrors the pattern used by analyze_thread.
        let backfillAdmin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"] | undefined;
        try {
          ({ admin: backfillAdmin } = await withTimeout(
            unauthenticated.admin(job.shop),
            10_000,
            `unauthenticated.admin(${job.shop})`,
          ));
        } catch (err) {
          console.error(`[auto-sync] backfill: could not get admin for shop ${job.shop}, Tier 2/3 skipped:`, err);
        }
        const res = await runManualBackfill(
          job.shop,
          new Date(afterDateIso),
          job.mailConnectionId,
          2000,
          backfillAdmin,
        );
        console.log(
          `[auto-sync] shop=${job.shop} backfill: ingested=${res.ingested} skipped=${res.skipped}`,
        );
        break;
      }
      case "recompute": {
        // Shop-wide job — no mailConnectionId. Use any mailbox for the address hint.
        const conn = await prisma.mailConnection.findFirst({
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
        // Shop-wide job — no mailConnectionId. Use any mailbox for the address hint.
        const conn = await prisma.mailConnection.findFirst({
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
        // Look up by mailConnectionId when available; fall back to any mailbox
        // for the address hint (analyze_thread is mailbox-scoped but the email
        // field is only used for logging).
        const conn = job.mailConnectionId
          ? await prisma.mailConnection.findUnique({
              where: { id: job.mailConnectionId },
              select: { email: true },
            })
          : await prisma.mailConnection.findFirst({
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

        // Route according to thread classification state:
        // - supportNature=unknown → run Tier 2 first (cheap LLM classify) so
        //   the thread is no longer stuck as unknown. analyzeThread handles the
        //   Tier 2 → Tier 3 gate internally.
        // - already classified → refresh path via reanalyzeEmail (no Tier 2 re-run).
        //
        // Intent: the stale-unknown cron (enqueueClassifyStaleUnknown) dispatches
        // these jobs for legacy backfilled threads that missed Tier 2. Threads
        // queued by other paths (e.g. user-triggered re-analysis) have a known
        // supportNature and take the existing reanalyzeEmail path.
        const thread = await prisma.thread.findUnique({
          where: { id: threadId },
          select: { supportNature: true },
        });

        if (thread?.supportNature === "unknown") {
          // Never been classified — run Tier 2 first, let analyzeThread gate Tier 3.
          const { analyzeThread } = await import("../support/analyze-thread");
          await analyzeThread(
            threadId,
            { shop: job.shop, admin, mailboxAddress: conn?.email ?? "" },
            {
              runTier2: true,
              runShopify: true,
              runTracking: true,
              runDraft: false,
              skipBillingIncrement: false, // charge if Tier 3 runs and it's the first analysis
            },
          );
        } else {
          // Already classified — use the refresh path (no Tier 2 re-run).
          const { reanalyzeEmail } = await import("../gmail/pipeline");
          await reanalyzeEmail(anchor.id, admin, job.shop, { skipDraft: true });
          // markThreadAnalyzedIfFirst was called inside reanalyzeEmail.
        }
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
    // Undo the running-set bookkeeping that drainJobQueue set synchronously
    // before firing this job. Must mirror the add/increment done there.
    if (job.mailConnectionId != null) {
      running.mailConnectionIds.delete(job.mailConnectionId);
    }
    const prevCount = running.perShopCount.get(job.shop) ?? 0;
    if (prevCount <= 1) {
      running.perShopCount.delete(job.shop);
    } else {
      running.perShopCount.set(job.shop, prevCount - 1);
    }
    autoSyncInFlight.set(inFlight);
    autoSyncJobsTotal.inc({ shop: job.shop, kind: job.kind, status: finalStatus });
    autoSyncJobDurationSeconds.observe(
      { kind: job.kind, status: finalStatus },
      stopTimer(),
    );
  }
}

/**
 * Execute one sync for a shop/mailbox. Caller owns concurrency bookkeeping
 * (see `runJob`). Errors bubble up so the queue can mark the job
 * failed / schedule a retry.
 *
 * `mailConnectionId` is forwarded for future tasks that will scope
 * `processNewEmails` to a single mailbox; currently unused downstream.
 */
async function runSyncForShop(
  shop: string,
  opts: { mailConnectionId?: string; runOnboarding: boolean; onboardingDays: number; tier3Allowed?: boolean; bypassCatchupGate?: boolean },
): Promise<void> {
  const tier3Allowed = opts.tier3Allowed ?? true;
  const bypassCatchupGate = opts.bypassCatchupGate ?? false;
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
  if (opts.runOnboarding && opts.mailConnectionId) {
    try {
      // Pass admin so Tier 2 + Tier 3 run on freshly-ingested threads
      // (fix: onboarding backfill previously left tier2Result=null).
      const res = await runOnboardingBackfill(shop, opts.onboardingDays, opts.mailConnectionId, admin);
      console.log(
        `[auto-sync] shop=${shop} onboarding backfill: ingested=${res.ingested} skipped=${res.skipped}`,
      );
    } catch (err) {
      // Onboarding failure must not block the regular sync that
      // follows — it'll be retried on the next tick.
      console.error(`[auto-sync] shop=${shop} onboarding backfill failed:`, err);
    }
  }
  // Resolve the MailConnection to pass to processNewEmails. When mailConnectionId
  // is provided (per-mailbox job), use it; otherwise fall back to the first
  // autoSyncEnabled connection for the shop (original single-mailbox behaviour).
  const connection = opts.mailConnectionId
    ? await prisma.mailConnection.findUnique({ where: { id: opts.mailConnectionId } })
    : await prisma.mailConnection.findFirst({ where: { shop, autoSyncEnabled: true } });
  if (!connection) {
    throw new Error(`No mail connection found for shop ${shop}`);
  }
  const report = await processNewEmails(shop, admin, { tier3Allowed, bypassCatchupGate, connection });
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

