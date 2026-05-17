import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { getLastTickAt } from "../lib/mail/auto-sync";

// Auto-sync ticks every 60 s; treat the loop as wedged if no tick fired
// in the last 3 minutes (covers a missed tick + a slow next tick).
// Boot grace: the loop starts 5 s after boot, so before the first tick
// `lastTickAt` is 0 — we skip the check during the first 90 s of process
// uptime so /healthz doesn't 503 a fresh container before its first tick.
const STALE_TICK_MS = 3 * 60_000;
const BOOT_GRACE_MS = 90_000;
const bootedAt = Date.now();

/**
 * GET /healthz — lightweight health probe for load balancers and uptime
 * monitors.
 *
 * Returns 200 with a small JSON body when the DB is reachable, 503 when it
 * is not. Intentionally unauthenticated: it must respond before / without
 * any Shopify embedded-admin handshake, otherwise the platform's TCP-level
 * health check has nothing useful to call.
 *
 * Keep this endpoint cheap — it is hit on a tight cadence (every few
 * seconds) by external probes. A single `SELECT 1` is enough to detect
 * connection-pool starvation, network partitions, and credential rotation
 * issues without putting load on the app.
 */
export async function loader(_args: LoaderFunctionArgs) {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    // Auto-sync wedge check: after the boot grace, if no tick has fired in
    // STALE_TICK_MS the loop is silently dead and the platform should restart
    // us. DB-only check would pass, masking the real problem.
    const uptime = Date.now() - bootedAt;
    const lastTickAt = getLastTickAt();
    const tickAge = lastTickAt > 0 ? Date.now() - lastTickAt : Infinity;
    if (uptime > BOOT_GRACE_MS && tickAge > STALE_TICK_MS) {
      return new Response(
        JSON.stringify({
          ok: false,
          db: "ok",
          autoSync: "stale",
          tickAgeMs: Number.isFinite(tickAge) ? tickAge : null,
          checkMs: Date.now() - start,
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        db: "ok",
        autoSync: lastTickAt > 0 ? "ok" : "warmup",
        checkMs: Date.now() - start,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({
        ok: false,
        db: "fail",
        error: msg.slice(0, 200),
        checkMs: Date.now() - start,
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
