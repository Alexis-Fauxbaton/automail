import prisma from "../db.server";

export interface RateLimitOptions {
  /** Logical key — e.g. shop domain or IP address. Truncated to 200 chars. */
  key: string;
  /** Free-form identifier for what's being limited (e.g. "reply-draft"). */
  kind: string;
  /** Max number of allowed events per window. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Remaining events in the current window after this call. */
  remaining: number;
  /** Milliseconds until the current window resets. */
  resetMs: number;
}

/**
 * Sliding-window rate limiter backed by Postgres.
 *
 * Semantics: per (key, kind), allow at most `limit` events in any
 * `windowMs` window. The window slides forward — when a new event arrives
 * after the window has expired, the count resets.
 *
 * The whole increment-and-decide is one atomic SQL statement (`INSERT ...
 * ON CONFLICT ... DO UPDATE`), so two concurrent calls on the same key
 * can never both read count=N and both write count=N+1 (which would let
 * 2 requests through when only 1 should). The CASE expression resets the
 * window inline when it's expired.
 */
export async function checkRateLimit({
  key,
  kind,
  limit,
  windowMs,
}: RateLimitOptions): Promise<RateLimitResult> {
  const safeKey = key.slice(0, 200);
  const safeKind = kind.slice(0, 64);

  // One atomic INSERT ... ON CONFLICT DO UPDATE.
  // - First call: inserts (count=1, windowStart=now).
  // - Subsequent calls within the window: count = count + 1.
  // - Subsequent calls after windowMs elapsed: count = 1, windowStart = now.
  // The RETURNING clause hands us the final state so we can compute the
  // remaining budget without a second round-trip.
  const rows = await prisma.$queryRaw<
    Array<{ count: number; windowStart: Date }>
  >`
    INSERT INTO "RateLimitBucket" ("key", "kind", "count", "windowStart")
    VALUES (${safeKey}, ${safeKind}, 1, NOW())
    ON CONFLICT ("key", "kind") DO UPDATE SET
      "count" = CASE
        WHEN EXTRACT(EPOCH FROM (NOW() - "RateLimitBucket"."windowStart")) * 1000 >= ${windowMs}
          THEN 1
          ELSE "RateLimitBucket"."count" + 1
      END,
      "windowStart" = CASE
        WHEN EXTRACT(EPOCH FROM (NOW() - "RateLimitBucket"."windowStart")) * 1000 >= ${windowMs}
          THEN NOW()
          ELSE "RateLimitBucket"."windowStart"
      END
    RETURNING "count", "windowStart";
  `;

  const row = rows[0];
  if (!row) {
    // Should not happen with INSERT ... RETURNING. Treat as allow + log.
    console.error("[rate-limit] empty RETURNING for", { safeKey, safeKind });
    return { ok: true, remaining: limit - 1, resetMs: windowMs };
  }

  const count = Number(row.count);
  const windowStart = row.windowStart instanceof Date ? row.windowStart : new Date(row.windowStart);
  const ok = count <= limit;
  const resetMs = Math.max(0, windowMs - (Date.now() - windowStart.getTime()));
  return { ok, remaining: Math.max(0, limit - count), resetMs };
}

/**
 * Best-effort cleanup of buckets that haven't been touched in 24h.
 *
 * Bounded by `maxBatches × batchSize` rows per call so a backlog of stale
 * rows can never hold a long delete lock and block live rate-limit writes
 * (the table is queried on every authenticated action). Anything remaining
 * is picked up on the next tick.
 */
export async function pruneOldRateLimitBuckets(opts: {
  batchSize?: number;
  maxBatches?: number;
} = {}): Promise<void> {
  const batchSize = opts.batchSize ?? 1000;
  const maxBatches = opts.maxBatches ?? 5;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (let i = 0; i < maxBatches; i++) {
    const stale = await prisma.rateLimitBucket.findMany({
      where: { windowStart: { lt: cutoff } },
      take: batchSize,
      select: { key: true, kind: true },
    });
    if (stale.length === 0) return;
    await prisma.rateLimitBucket.deleteMany({
      where: { OR: stale.map((s) => ({ key: s.key, kind: s.kind })) },
    });
    if (stale.length < batchSize) return;
  }
}

/**
 * Extract the requesting client's IP from common proxy headers.
 *
 * `X-Forwarded-For` can be set by anyone, so we only trust it when we know
 * we're behind a single trusted proxy hop. On Render, the platform adds
 * exactly one hop, so the LEFTMOST entry is the real client IP — but only
 * when the request actually came through Render's edge. If TRUSTED_PROXY
 * is not set explicitly, we fall back to "unknown" for the rate-limit key,
 * which means the per-IP cap becomes a per-deployment cap. That's safer
 * than trusting a header an attacker can set.
 */
export function getClientIp(request: Request): string {
  const trust = process.env.TRUSTED_PROXY === "true" || process.env.TRUSTED_PROXY === "1";
  if (trust) {
    const fwd = request.headers.get("x-forwarded-for");
    if (fwd) {
      const first = fwd.split(",")[0]?.trim();
      if (first) return first;
    }
    const cf = request.headers.get("cf-connecting-ip");
    if (cf) return cf.trim();
    const real = request.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  return "unknown";
}
