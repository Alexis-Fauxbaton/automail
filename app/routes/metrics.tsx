import type { LoaderFunctionArgs } from "react-router";
import { metrics } from "../lib/metrics/registry";

/**
 * GET /metrics — Prometheus-compatible scrape endpoint.
 *
 * Gated by a constant-time comparison against `METRICS_TOKEN`. The token
 * lives in an env var so it can be rotated without a deploy. If
 * `METRICS_TOKEN` is unset the endpoint refuses every request — we'd rather
 * be silent than risk leaking metrics with default credentials.
 *
 * The metrics surface is intentionally PII-free (counts, durations,
 * cumulative costs, breaker states). Shop labels are domain identifiers
 * the merchant already exposes publicly; nothing that needs special
 * protection beyond avoiding random scraping.
 */
import { timingSafeEqual } from "crypto";

function tokenMatches(provided: string, expected: string): boolean {
  // Both buffers MUST be the same length for timingSafeEqual; pad the
  // shorter side with zeros and only return true if both length and
  // content match. This avoids leaking length via timing.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) {
    return new Response("Not configured", { status: 404 });
  }

  // Accept either "Authorization: Bearer <token>" (standard) or
  // "?token=<token>" (some scrapers can only attach query params).
  let provided: string | null = null;
  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    provided = auth.slice(7).trim();
  } else {
    const url = new URL(request.url);
    provided = url.searchParams.get("token");
  }

  if (!provided || !tokenMatches(provided, expected)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="metrics"' },
    });
  }

  return new Response(metrics.renderPrometheus(), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
