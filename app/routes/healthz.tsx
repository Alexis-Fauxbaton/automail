import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";

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
    return new Response(
      JSON.stringify({ ok: true, db: "ok", checkMs: Date.now() - start }),
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
