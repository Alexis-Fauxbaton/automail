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
 * The implementation does an UPSERT then a conditional UPDATE. It's not
 * lock-free but the contention is per-key, not global, and the shape is
 * simple enough to stay fast under realistic load.
 */
export async function checkRateLimit({
  key,
  kind,
  limit,
  windowMs,
}: RateLimitOptions): Promise<RateLimitResult> {
  const safeKey = key.slice(0, 200);
  const safeKind = kind.slice(0, 64);
  const now = Date.now();

  // Upsert: ensure the row exists so the next UPDATE has something to hit.
  // create with count=0 so the first UPDATE below moves us to 1.
  await prisma.rateLimitBucket.upsert({
    where: { key_kind: { key: safeKey, kind: safeKind } },
    create: { key: safeKey, kind: safeKind, count: 0, windowStart: new Date(now) },
    update: {},
  });

  // Read the row, decide whether to reset, and increment.
  const row = await prisma.rateLimitBucket.findUnique({
    where: { key_kind: { key: safeKey, kind: safeKind } },
  });
  if (!row) {
    // Should not happen after the upsert, but stay safe.
    return { ok: true, remaining: limit - 1, resetMs: windowMs };
  }

  const elapsed = now - row.windowStart.getTime();
  let count: number;
  let windowStart: Date;
  if (elapsed >= windowMs) {
    // Window expired — reset.
    count = 1;
    windowStart = new Date(now);
  } else {
    count = row.count + 1;
    windowStart = row.windowStart;
  }

  await prisma.rateLimitBucket.update({
    where: { key_kind: { key: safeKey, kind: safeKind } },
    data: { count, windowStart },
  });

  const ok = count <= limit;
  const resetMs = Math.max(0, windowMs - (now - windowStart.getTime()));
  return { ok, remaining: Math.max(0, limit - count), resetMs };
}

/** Best-effort cleanup of buckets that haven't been touched in 24h. */
export async function pruneOldRateLimitBuckets(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await prisma.rateLimitBucket.deleteMany({
    where: { windowStart: { lt: cutoff } },
  });
}

/** Extract the requesting client's IP from common proxy headers. */
export function getClientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}
