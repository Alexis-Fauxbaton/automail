/**
 * SQL-backed metrics for the internal dashboard.
 *
 * These complement the in-memory `metrics` registry by surfacing data that
 * lives in Postgres (job history, LLM cost log, thread state). The
 * in-memory metrics show "what's happening right now"; these queries show
 * "what has happened over the last 24h / 7d".
 *
 * All queries are read-only and scoped per shop where applicable. The
 * dashboard runs them on every page load (the page is for internal use,
 * so a few extra DB hits are acceptable).
 */

import prisma from "../../db.server";

export interface ShopJobStats {
  shop: string;
  doneCount: number;
  errorCount: number;
  runningCount: number;
  pendingCount: number;
  p50Seconds: number | null;
  p95Seconds: number | null;
}

/**
 * Job activity for the last `hours` hours, grouped per shop. Used to spot
 * shops with chronic failures and to rank scaling pressure.
 */
export async function getJobStatsPerShop(hours = 24): Promise<ShopJobStats[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      shop: string;
      done_count: bigint;
      error_count: bigint;
      running_count: bigint;
      pending_count: bigint;
      p50_seconds: number | null;
      p95_seconds: number | null;
    }>
  >`
    SELECT
      shop,
      COUNT(*) FILTER (WHERE status = 'done')    AS done_count,
      COUNT(*) FILTER (WHERE status = 'error')   AS error_count,
      COUNT(*) FILTER (WHERE status = 'running') AS running_count,
      COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM ("finishedAt" - "startedAt"))
      ) FILTER (WHERE status = 'done' AND "startedAt" IS NOT NULL AND "finishedAt" IS NOT NULL)
        AS p50_seconds,
      PERCENTILE_CONT(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM ("finishedAt" - "startedAt"))
      ) FILTER (WHERE status = 'done' AND "startedAt" IS NOT NULL AND "finishedAt" IS NOT NULL)
        AS p95_seconds
    FROM "SyncJob"
    WHERE "createdAt" > NOW() - (${hours}::int * INTERVAL '1 hour')
    GROUP BY shop
    ORDER BY error_count DESC, done_count DESC
    LIMIT 50
  `;
  return rows.map((r) => ({
    shop: r.shop,
    doneCount: Number(r.done_count),
    errorCount: Number(r.error_count),
    runningCount: Number(r.running_count),
    pendingCount: Number(r.pending_count),
    p50Seconds: r.p50_seconds === null ? null : Number(r.p50_seconds),
    p95Seconds: r.p95_seconds === null ? null : Number(r.p95_seconds),
  }));
}

export interface ShopLlmCost {
  shop: string;
  calls: number;
  costUsd: number;
  totalTokens: number;
}

/**
 * LLM cost per shop for the last `hours` hours. Spotting a shop that costs
 * 10× the average is the cheapest way to catch a refresh loop, a stuck
 * job hammering OpenAI, or a regression in prompt size.
 */
export async function getLlmCostPerShop(hours = 24): Promise<ShopLlmCost[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      shop: string;
      calls: bigint;
      cost_usd: number;
      total_tokens: bigint;
    }>
  >`
    SELECT
      shop,
      COUNT(*)        AS calls,
      SUM("costUsd")  AS cost_usd,
      SUM("totalTokens") AS total_tokens
    FROM "LlmCallLog"
    WHERE "createdAt" > NOW() - (${hours}::int * INTERVAL '1 hour')
    GROUP BY shop
    ORDER BY cost_usd DESC
    LIMIT 50
  `;
  return rows.map((r) => ({
    shop: r.shop,
    calls: Number(r.calls),
    costUsd: Number(r.cost_usd ?? 0),
    totalTokens: Number(r.total_tokens ?? 0),
  }));
}

export interface StuckCounts {
  totalIngested: number;
  totalError: number;
  totalAnalyzed24h: number;
}

/**
 * Pipeline health: how many emails are stuck not having reached the
 * "analyzed" state. A non-zero `totalIngested` after 1h of sync uptime is
 * a strong signal Pass 2 isn't running.
 */
export async function getPipelineHealth(): Promise<StuckCounts> {
  const rows = await prisma.$queryRaw<
    Array<{ ingested: bigint; errored: bigint; analyzed_24h: bigint }>
  >`
    SELECT
      COUNT(*) FILTER (WHERE "processingStatus" = 'ingested') AS ingested,
      COUNT(*) FILTER (WHERE "processingStatus" = 'error')    AS errored,
      COUNT(*) FILTER (
        WHERE "processingStatus" = 'analyzed'
        AND "lastAnalyzedAt" > NOW() - INTERVAL '24 hours'
      ) AS analyzed_24h
    FROM "IncomingEmail"
  `;
  const r = rows[0] ?? { ingested: 0n, errored: 0n, analyzed_24h: 0n };
  return {
    totalIngested: Number(r.ingested),
    totalError: Number(r.errored),
    totalAnalyzed24h: Number(r.analyzed_24h),
  };
}

export interface ShopClassificationHealth {
  shop: string;
  totalThreads: number;
  unknownThreads: number;
  unknownRatio: number; // 0..1
}

/**
 * Per-shop classification health. A high ratio of `supportNature: "unknown"`
 * threads is the canonical signal that direction-detection has misattributed
 * incoming customer mail as outgoing, causing tier1/tier2 to be skipped.
 *
 * Threshold guideline for alerting:
 *   - < 0.10  healthy (most shops have a few uncertain threads)
 *   - 0.10–0.30  watch (could be normal for a new shop with little history)
 *   - > 0.30  investigate (likely a provider direction bug or a stuck
 *             classifier — check outgoing_self_heal_total counter and
 *             recent logs)
 *
 * Only shops with at least 10 threads are returned, to avoid spurious
 * ratios from shops that just installed.
 */
export async function getClassificationHealthPerShop(): Promise<
  ShopClassificationHealth[]
> {
  const rows = await prisma.$queryRaw<
    Array<{ shop: string; total: bigint; unknown: bigint }>
  >`
    SELECT
      shop,
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE "supportNature" = 'unknown')::bigint AS unknown
    FROM "Thread"
    GROUP BY shop
    HAVING COUNT(*) >= 10
    ORDER BY (COUNT(*) FILTER (WHERE "supportNature" = 'unknown'))::float / COUNT(*) DESC
    LIMIT 50
  `;
  return rows.map((r) => {
    const total = Number(r.total);
    const unknown = Number(r.unknown);
    return {
      shop: r.shop,
      totalThreads: total,
      unknownThreads: unknown,
      unknownRatio: total === 0 ? 0 : unknown / total,
    };
  });
}

export interface DbPoolStats {
  active: number;
  idle: number;
  idleInTransaction: number;
  total: number;
  maxConnections: number;
}

/**
 * Postgres connection-pool health. The single best leading indicator for
 * scaling: when `active` approaches `maxConnections`, requests are about
 * to time out fetching a connection.
 */
export async function getDbPoolStats(): Promise<DbPoolStats | null> {
  try {
    const stateRows = await prisma.$queryRaw<
      Array<{ state: string | null; cnt: bigint }>
    >`
      SELECT state, COUNT(*)::bigint AS cnt
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY state
    `;
    const maxRows = await prisma.$queryRaw<Array<{ setting: string }>>`
      SELECT setting FROM pg_settings WHERE name = 'max_connections'
    `;
    const byState: Record<string, number> = {};
    for (const r of stateRows) byState[r.state ?? "null"] = Number(r.cnt);
    const total = Object.values(byState).reduce((a, b) => a + b, 0);
    return {
      active: byState["active"] ?? 0,
      idle: byState["idle"] ?? 0,
      idleInTransaction: byState["idle in transaction"] ?? 0,
      total,
      maxConnections: Number(maxRows[0]?.setting ?? "0"),
    };
  } catch {
    // pg_stat_activity may be denied for the user on managed providers
    // (Neon, Supabase). Don't crash the dashboard — return null and let
    // the UI label it as unavailable.
    return null;
  }
}
