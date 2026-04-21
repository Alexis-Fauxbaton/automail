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
import { runOnboardingBackfill } from "./backfill";

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
    if (inFlight >= MAX_CONCURRENT) break;
    if (running.has(c.shop)) continue;

    const intervalMs = Math.max(1, c.autoSyncIntervalMinutes) * 60_000;
    const due =
      !c.lastSyncAt || now.getTime() - c.lastSyncAt.getTime() >= intervalMs;
    if (!due) continue;

    void runSyncForShop(c.shop, {
      runOnboarding: !c.onboardingBackfillDoneAt,
      onboardingDays: c.onboardingBackfillDays,
    });
  }
}

async function runSyncForShop(
  shop: string,
  opts: { runOnboarding: boolean; onboardingDays: number } = {
    runOnboarding: false,
    onboardingDays: 60,
  },
): Promise<void> {
  if (running.has(shop)) return;
  running.add(shop);
  inFlight++;
  try {
    const { admin } = await unauthenticated.admin(shop);
    if (opts.runOnboarding) {
      try {
        const res = await runOnboardingBackfill(shop, opts.onboardingDays);
        console.log(
          `[auto-sync] ${shop} onboarding backfill: ingested=${res.ingested} skipped=${res.skipped}`,
        );
      } catch (err) {
        console.error(`[auto-sync] ${shop} onboarding backfill failed:`, err);
      }
    }
    const report = await processNewEmails(shop, admin.graphql);
    console.log(
      `[auto-sync] ${shop} → ${report.total} fetched, ${report.supportClient} support, ${report.errors} errors`,
    );
  } catch (err) {
    console.error(`[auto-sync] ${shop} failed:`, err);
  } finally {
    inFlight = Math.max(0, inFlight - 1);
    running.delete(shop);
  }
}
