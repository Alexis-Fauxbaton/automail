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
import { runManualBackfill, runOnboardingBackfill } from "./backfill";
import { recomputeAllOpenThreads, recomputeAllThreadsForShop } from "../support/thread-state";
import { refreshStaleAnalysesForShop } from "../support/refresh-stale-analyses";
import {
  claimNextJob,
  enqueueJob,
  markJobDone,
  markJobFailed,
  reclaimZombieJobs,
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
const ZOMBIE_TIMEOUT_MS = 30 * 60_000; // reclaim jobs stuck > 30 min in "running"

let started = false;
let inFlight = 0;
const runningShops = new Set<string>();

/**
 * Start the background auto-sync loop. Idempotent — safe to call
 * multiple times (e.g. during hot reload).
 */
export function startAutoSyncLoop(): void {
  if (started) return;
  started = true;
  setTimeout(() => {
    tick().catch((err) =>
      console.error("[auto-sync] initial tick failed:", err),
    );
    setInterval(() => {
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
}

/**
 * For every shop whose `lastSyncAt` is older than its
 * `autoSyncIntervalMinutes`, enqueue one "sync" job (de-dup is handled
 * inside `enqueueJob`, so a pending/running job blocks repeats).
 */
async function enqueueDuePeriodicSyncs(): Promise<void> {
  const now = new Date();
  const connections = await prisma.mailConnection.findMany({
    where: { autoSyncEnabled: true },
    select: {
      shop: true,
      lastSyncAt: true,
      autoSyncIntervalMinutes: true,
      onboardingBackfillDoneAt: true,
      onboardingBackfillDays: true,
    },
  });

  for (const c of connections) {
    const intervalMs = Math.max(1, c.autoSyncIntervalMinutes) * 60_000;
    const due =
      !c.lastSyncAt || now.getTime() - c.lastSyncAt.getTime() >= intervalMs;
    if (!due) continue;
    // First-run onboarding is still done inline inside `runSyncForShop`
    // when it sees the connection flag — no separate job type needed.
    await enqueueJob(c.shop, "sync").catch((err) =>
      console.error(`[auto-sync] enqueue periodic for ${c.shop} failed:`, err),
    );
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
    const job = await claimNextJob([...runningShops]);
    if (!job) break;
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
}

async function runJob(job: {
  id: string;
  shop: string;
  kind: "sync" | "backfill" | "resync" | "recompute";
  params: Record<string, unknown>;
}): Promise<void> {
  runningShops.add(job.shop);
  inFlight++;
  const startedAt = Date.now();
  try {
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
    await markJobFailed(job.id, err).catch(() => {});
  } finally {
    inFlight = Math.max(0, inFlight - 1);
    runningShops.delete(job.shop);
  }
}

/**
 * Execute one sync for a shop. Caller owns concurrency bookkeeping
 * (see `runJob`). Errors bubble up so the queue can mark the job
 * failed / schedule a retry.
 */
async function runSyncForShop(
  shop: string,
  opts: { runOnboarding: boolean; onboardingDays: number },
): Promise<void> {
  // unauthenticated.admin may throw a Response object (Remix redirect) when
  // the shop's offline token is missing or expired. Convert it to a proper
  // Error so markJobFailed captures a readable message.
  let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
  try {
    ({ admin } = await unauthenticated.admin(shop));
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
  const report = await processNewEmails(shop, admin);
  console.log(
    `[auto-sync] shop=${shop} fetched=${report.total} support=${report.supportClient} errors=${report.errors}`,
  );

  // Best-effort daily refresh of "to handle" thread analyses so tracking
  // and Shopify data stay at most ~24h stale even if the merchant doesn't
  // click anything. Failures are isolated per email and never abort sync.
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


