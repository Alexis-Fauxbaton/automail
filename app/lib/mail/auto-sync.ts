// Backend auto-sync loop (spec §10).
//
// A single in-process interval wakes up every `TICK_MS` and, for every
// MailConnection with `autoSyncEnabled=true`, triggers `processNewEmails`
// if its `lastSyncAt` is older than `autoSyncIntervalMinutes`.
//
// Rationale: Shopify embedded apps run as long-lived Node processes.
// A single timer per instance is sufficient for an internal single-store
// app (see Claude.md — this is not a public multi-tenant SaaS).
// For multi-instance deployments a real job queue / cron would be
// required; noted as a follow-up in the spec.

import prisma from "../../db.server";
import { processNewEmails } from "../gmail/pipeline";
import { unauthenticated } from "../../shopify.server";
import { runManualBackfill, runOnboardingBackfill } from "./backfill";
import {
  claimNextJob,
  enqueueJob,
  markJobDone,
  markJobFailed,
} from "./job-queue";

const TICK_MS = 60_000;             // check every minute
const STARTUP_DELAY_MS = 15_000;    // wait a bit after boot
const MAX_CONCURRENT = 1;           // serialize shops (Neon free tier)

let started = false;
let inFlight = 0;
const running = new Set<string>();

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
  console.log("[auto-sync] background loop scheduled");
}

async function tick(): Promise<void> {
  // Two kinds of work drive the tick:
  //   1. User-initiated jobs pushed into SyncJob by the inbox route
  //      (sync / backfill / resync). These are durable and must be
  //      drained first so a button click survives a restart.
  //   2. Periodic time-based syncs for shops with autoSyncEnabled=true.
  //      We express these as SyncJob rows too, so the whole worker has
  //      a single execution path.
  await enqueueDuePeriodicSyncs();
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
 * concurrency limit. Each job is executed inside `runJob` which handles
 * success/failure bookkeeping.
 */
async function drainJobQueue(): Promise<void> {
  while (inFlight < MAX_CONCURRENT) {
    const job = await claimNextJob();
    if (!job) break;
    if (running.has(job.shop)) {
      // Another job for the same shop is in flight; put it back to
      // pending and move on — it'll be retried on the next tick.
      await markJobFailed(job.id, new Error("shop busy")).catch(() => {});
      continue;
    }
    void runJob(job);
  }
}

async function runJob(job: {
  id: string;
  shop: string;
  kind: "sync" | "backfill" | "resync";
  params: Record<string, unknown>;
}): Promise<void> {
  running.add(job.shop);
  inFlight++;
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
          `[auto-sync] ${job.shop} backfill: ingested=${res.ingested} skipped=${res.skipped}`,
        );
        break;
      }
    }
    await markJobDone(job.id);
  } catch (err) {
    console.error(`[auto-sync] job ${job.id} (${job.kind}) failed:`, err);
    await markJobFailed(job.id, err).catch(() => {});
  } finally {
    inFlight = Math.max(0, inFlight - 1);
    running.delete(job.shop);
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
  const { admin } = await unauthenticated.admin(shop);
  if (opts.runOnboarding) {
    try {
      const res = await runOnboardingBackfill(shop, opts.onboardingDays);
      console.log(
        `[auto-sync] ${shop} onboarding backfill: ingested=${res.ingested} skipped=${res.skipped}`,
      );
    } catch (err) {
      // Onboarding failure must not block the regular sync that
      // follows — it'll be retried on the next tick.
      console.error(`[auto-sync] ${shop} onboarding backfill failed:`, err);
    }
  }
  const report = await processNewEmails(shop, admin.graphql);
  console.log(
    `[auto-sync] ${shop} → ${report.total} fetched, ${report.supportClient} support, ${report.errors} errors`,
  );
}
