// Dashboard statistics helpers â€” period bounds computation and aggregated DB queries.

import { Prisma } from "@prisma/client";
import prisma from "../db.server";

// Timezone used for day bucketing (label display and chart grouping).
// A mail received at 01:22 local time must not appear on the previous UTC day.
const DISPLAY_TZ = "Europe/Paris";
// Prisma.raw snippet for AT TIME ZONE clauses — keeps DISPLAY_TZ as single source of truth.
const TZ = Prisma.raw(`'${DISPLAY_TZ}'`);

function toLocalDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export type PeriodBounds = {
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
};

const RANGE_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

export function getPeriodBounds(
  range: string,
  from: string | undefined,
  to: string | undefined,
  now: Date = new Date()
): PeriodBounds {
  let start: Date;
  let end: Date;

  if (range === "custom" && from && to) {
    start = new Date(from);
    end = new Date(to);
  } else {
    const ms = RANGE_MS[range] ?? RANGE_MS["30d"];
    end = now;
    start = new Date(now.getTime() - ms);
  }

  const duration = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime());
  const prevStart = new Date(start.getTime() - duration);

  return { start, end, prevStart, prevEnd };
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export type ThreadStateCounts = {
  open: number;
  waiting_customer: number;
  waiting_merchant: number;
  resolved: number;
  no_reply_needed: number;
};

export type ResponseTimeStats = {
  medianMs: number | null;
  p90Ms: number | null;
  prevMedianMs: number | null;
};

export type ResponseTimeDailyPoint = {
  date: string;        // "YYYY-MM-DD"
  support: number;     // support thread count that day
  medianMs: number | null;
};

export type DraftUsageStats = {
  asIs: number;
  edited: number;
  ignored: number;
  pending: number;
  sentPct: number | null;     // (asIs + edited) / (asIs + edited + ignored) * 100, null if denom=0
  prevSentPct: number | null;
};

export type ProductivityDailyPoint = {
  date: string;    // "YYYY-MM-DD"
  as_is: number;
  edited: number;
  ignored: number;
};

export type HeatmapCell = {
  dow: number;   // 0=Sunday … 6=Saturday (Postgres EXTRACT(DOW))
  hour: number;  // 0-23
  count: number;
};

export type IntentPerf = {
  intent: string;
  count: number;
  medianMs: number | null;
};

export type ReopenedThread = {
  threadId: string;
  reopenCount: number;
  lastReopenedAt: Date;
};

export type Alert = {
  type: "intent_surge" | "volume_surge" | "delay_degraded" | "reopened_spike";
  label: string;
  magnitude: number;
  current: number;
  baseline: number;
  inboxFilterParam: string;
};

export type DashboardKpis = {
  responseTime: ResponseTimeStats;
  reopened: { count: number; prevCount: number };
  draftUsage: DraftUsageStats;
  volume: { count: number; prevCount: number };
};

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export async function getCurrentThreadStates(shop: string): Promise<ThreadStateCounts> {
  const rows = await prisma.thread.groupBy({
    by: ["operationalState"],
    where: { shop, supportNature: { not: "non_support" } },
    _count: { _all: true },
  });

  const counts: ThreadStateCounts = {
    open: 0,
    waiting_customer: 0,
    waiting_merchant: 0,
    resolved: 0,
    no_reply_needed: 0,
  };

  for (const row of rows) {
    const state = row.operationalState as keyof ThreadStateCounts;
    if (state in counts) counts[state] = row._count._all;
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Shared percentile helper (in-process, for small datasets)
// ---------------------------------------------------------------------------

// Linear interpolation — matches PostgreSQL PERCENTILE_CONT behaviour exactly.
function _percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

// ---------------------------------------------------------------------------
// Response time stats
// ---------------------------------------------------------------------------

async function _fetchResponseTimesMs(shop: string, start: Date, end: Date): Promise<number[]> {
  type Row = { response_ms: number };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      EXTRACT(EPOCH FROM (MIN(e."receivedAt") - t."firstMessageAt")) * 1000 AS response_ms
    FROM "Thread" t
    JOIN "IncomingEmail" e
      ON e."canonicalThreadId" = t.id
      AND e."processingStatus" = 'outgoing'
      AND e."receivedAt" > t."firstMessageAt"
    WHERE t.shop = ${shop}
      AND t."firstMessageAt" >= ${start}
      AND t."firstMessageAt" < ${end}
      AND t."supportNature" IN ('confirmed_support', 'probable_support')
      AND NOT EXISTS (
        SELECT 1 FROM "IncomingEmail" fe
        WHERE fe."canonicalThreadId" = t.id
          AND fe."processingStatus" = 'outgoing'
          AND fe."receivedAt" <= t."firstMessageAt"
      )
    GROUP BY t.id, t."firstMessageAt"
  `;
  return rows.map((r) => Number(r.response_ms)).filter((v) => v > 0);
}

export async function getResponseTimeStats(
  shop: string,
  start: Date,
  end: Date,
  prevStart: Date,
  prevEnd: Date,
): Promise<ResponseTimeStats> {
  const [current, prev] = await Promise.all([
    _fetchResponseTimesMs(shop, start, end),
    _fetchResponseTimesMs(shop, prevStart, prevEnd),
  ]);
  return {
    medianMs: _percentile(current, 0.5),
    p90Ms: _percentile(current, 0.9),
    prevMedianMs: _percentile(prev, 0.5),
  };
}

export async function getResponseTimeDailyBreakdown(
  shop: string,
  start: Date,
  end: Date,
): Promise<ResponseTimeDailyPoint[]> {
  type Row = { day: Date; support: bigint; median_ms: number | null };
  const rows = await prisma.$queryRaw<Row[]>`
    WITH threads AS (
      SELECT
        t.id,
        t."firstMessageAt",
        DATE_TRUNC('day', t."firstMessageAt" AT TIME ZONE ${TZ})::date AS day,
        MIN(e."receivedAt") AS first_outgoing_at
      FROM "Thread" t
      LEFT JOIN "IncomingEmail" e
        ON e."canonicalThreadId" = t.id
        AND e."processingStatus" = 'outgoing'
        AND e."receivedAt" > t."firstMessageAt"
      WHERE t.shop = ${shop}
        AND t."firstMessageAt" >= ${start}
        AND t."firstMessageAt" < ${end}
        AND t."supportNature" IN ('confirmed_support', 'probable_support')
        AND NOT EXISTS (
          SELECT 1 FROM "IncomingEmail" fe
          WHERE fe."canonicalThreadId" = t.id
            AND fe."processingStatus" = 'outgoing'
            AND fe."receivedAt" <= t."firstMessageAt"
        )
      GROUP BY t.id, t."firstMessageAt"
    )
    SELECT
      day,
      COUNT(*)::bigint AS support,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (first_outgoing_at - "firstMessageAt")) * 1000
      ) FILTER (WHERE first_outgoing_at IS NOT NULL) AS median_ms
    FROM threads
    GROUP BY day
    ORDER BY day
  `;

  const byDay = new Map<string, { support: number; medianMs: number | null }>();
  for (const row of rows) {
    byDay.set(toLocalDay(row.day), {
      support: Number(row.support),
      medianMs: row.median_ms != null ? Number(row.median_ms) : null,
    });
  }

  const points: ResponseTimeDailyPoint[] = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const endDay = toLocalDay(end);
  while (toLocalDay(cursor) <= endDay) {
    const day = toLocalDay(cursor);
    const data = byDay.get(day) ?? { support: 0, medianMs: null };
    points.push({ date: day, ...data });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}

// ---------------------------------------------------------------------------
// Draft usage stats
// ---------------------------------------------------------------------------

async function _fetchDraftBuckets(shop: string, start: Date, end: Date) {
  const rows = await prisma.replyDraft.groupBy({
    by: ["heuristicBucket"],
    where: { shop, createdAt: { gte: start, lt: end } },
    _count: { _all: true },
  });
  const counts = { asIs: 0, edited: 0, ignored: 0, pending: 0 };
  for (const row of rows) {
    const bucket = row.heuristicBucket ?? "pending";
    if (bucket === "as_is") counts.asIs = row._count._all;
    else if (bucket === "edited") counts.edited = row._count._all;
    else if (bucket === "ignored") counts.ignored = row._count._all;
    else counts.pending += row._count._all;
  }
  return counts;
}

function _draftSentPct(c: { asIs: number; edited: number; ignored: number }): number | null {
  const denom = c.asIs + c.edited + c.ignored;
  if (denom === 0) return null;
  return Math.round(((c.asIs + c.edited) / denom) * 100);
}

export async function getDraftUsageStats(
  shop: string,
  start: Date,
  end: Date,
  prevStart: Date,
  prevEnd: Date,
): Promise<DraftUsageStats> {
  const [cur, prev] = await Promise.all([
    _fetchDraftBuckets(shop, start, end),
    _fetchDraftBuckets(shop, prevStart, prevEnd),
  ]);
  return {
    ...cur,
    sentPct: _draftSentPct(cur),
    prevSentPct: _draftSentPct(prev),
  };
}

export async function getDraftUsageDailyBreakdown(
  shop: string,
  start: Date,
  end: Date,
): Promise<ProductivityDailyPoint[]> {
  type Row = { day: Date; bucket: string | null; count: bigint };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      DATE_TRUNC('day', "createdAt" AT TIME ZONE ${TZ})::date AS day,
      "heuristicBucket" AS bucket,
      COUNT(*)::bigint AS count
    FROM "ReplyDraft"
    WHERE shop = ${shop}
      AND "createdAt" >= ${start}
      AND "createdAt" < ${end}
      AND "heuristicBucket" IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1
  `;

  const byDay = new Map<string, ProductivityDailyPoint>();
  for (const row of rows) {
    const day = toLocalDay(row.day);
    const existing = byDay.get(day) ?? { date: day, as_is: 0, edited: 0, ignored: 0 };
    const n = Number(row.count);
    if (row.bucket === "as_is") existing.as_is += n;
    else if (row.bucket === "edited") existing.edited += n;
    else if (row.bucket === "ignored") existing.ignored += n;
    byDay.set(day, existing);
  }

  const points: ProductivityDailyPoint[] = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const endDay = toLocalDay(end);
  while (toLocalDay(cursor) <= endDay) {
    const day = toLocalDay(cursor);
    points.push(byDay.get(day) ?? { date: day, as_is: 0, edited: 0, ignored: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}

// ---------------------------------------------------------------------------
// Aggregated KPI snapshot
// ---------------------------------------------------------------------------

export async function getDashboardKpis(
  shop: string,
  start: Date,
  end: Date,
  prevStart: Date,
  prevEnd: Date,
): Promise<DashboardKpis> {
  const [responseTime, draftUsage, reopened, prevReopened, volume, prevVolume] =
    await Promise.all([
      getResponseTimeStats(shop, start, end, prevStart, prevEnd),
      getDraftUsageStats(shop, start, end, prevStart, prevEnd),
      prisma.threadStateHistory.count({
        where: {
          shop,
          fromState: "resolved",
          NOT: { toState: "resolved" },
          changedAt: { gte: start, lt: end },
        },
      }),
      prisma.threadStateHistory.count({
        where: {
          shop,
          fromState: "resolved",
          NOT: { toState: "resolved" },
          changedAt: { gte: prevStart, lt: prevEnd },
        },
      }),
      prisma.incomingEmail.count({
        where: {
          shop,
          receivedAt: { gte: start, lt: end },
          processingStatus: { not: "outgoing" },
          OR: [
            { tier2Result: "support_client" },
            { thread: { supportNature: { in: ["confirmed_support", "probable_support"] } } },
          ],
        },
      }),
      prisma.incomingEmail.count({
        where: {
          shop,
          receivedAt: { gte: prevStart, lt: prevEnd },
          processingStatus: { not: "outgoing" },
          OR: [
            { tier2Result: "support_client" },
            { thread: { supportNature: { in: ["confirmed_support", "probable_support"] } } },
          ],
        },
      }),
    ]);

  return {
    responseTime,
    draftUsage,
    reopened: { count: reopened, prevCount: prevReopened },
    volume: { count: volume, prevCount: prevVolume },
  };
}

// ---------------------------------------------------------------------------
// Heatmap (volume by day-of-week × hour)
// ---------------------------------------------------------------------------

export async function getHeatmap(
  shop: string,
  start: Date,
  end: Date,
): Promise<HeatmapCell[]> {
  type Row = { dow: number; hour: number; count: bigint };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      EXTRACT(DOW  FROM e."receivedAt" AT TIME ZONE ${TZ})::int AS dow,
      EXTRACT(HOUR FROM e."receivedAt" AT TIME ZONE ${TZ})::int AS hour,
      COUNT(*)::bigint AS count
    FROM "IncomingEmail" e
    LEFT JOIN "Thread" t ON t.id = e."canonicalThreadId"
    WHERE e.shop = ${shop}
      AND e."receivedAt" >= ${start}
      AND e."receivedAt" < ${end}
      AND e."processingStatus" != 'outgoing'
      AND (
        e."tier2Result" = 'support_client'
        OR t."supportNature" IN ('confirmed_support', 'probable_support')
      )
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;
  return rows.map((r) => ({
    dow: Number(r.dow),
    hour: Number(r.hour),
    count: Number(r.count),
  }));
}

// ---------------------------------------------------------------------------
// Top intents with median response time
// ---------------------------------------------------------------------------

export async function getTopIntentsWithPerf(
  shop: string,
  start: Date,
  end: Date,
  limit = 5,
): Promise<IntentPerf[]> {
  type Row = { intent: string; count: bigint; median_ms: number | null };
  const rows = await prisma.$queryRaw<Row[]>`
    WITH latest_intent AS (
      SELECT DISTINCT ON (e."canonicalThreadId")
        e."canonicalThreadId",
        e."detectedIntent"
      FROM "IncomingEmail" e
      WHERE e.shop = ${shop}
        AND e."detectedIntent" IS NOT NULL
        AND e."canonicalThreadId" IS NOT NULL
        AND e."receivedAt" < ${end}
      ORDER BY e."canonicalThreadId", e."receivedAt" DESC
    ),
    thread_response AS (
      SELECT
        t.id,
        EXTRACT(EPOCH FROM (MIN(oe."receivedAt") - t."firstMessageAt")) * 1000 AS resp_ms
      FROM "Thread" t
      JOIN "IncomingEmail" oe
        ON oe."canonicalThreadId" = t.id
        AND oe."processingStatus" = 'outgoing'
        AND oe."receivedAt" > t."firstMessageAt"
      WHERE t.shop = ${shop}
        AND t."firstMessageAt" >= ${start}
        AND t."firstMessageAt" < ${end}
        AND t."supportNature" IN ('confirmed_support', 'probable_support')
      GROUP BY t.id, t."firstMessageAt"
    )
    SELECT
      li."detectedIntent" AS intent,
      COUNT(*)::bigint AS count,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tr.resp_ms) AS median_ms
    FROM "Thread" t
    JOIN latest_intent li ON li."canonicalThreadId" = t.id
    LEFT JOIN thread_response tr ON tr.id = t.id
    WHERE t.shop = ${shop}
      AND t."firstMessageAt" >= ${start}
      AND t."firstMessageAt" < ${end}
      AND t."supportNature" IN ('confirmed_support', 'probable_support')
    GROUP BY li."detectedIntent"
    ORDER BY count DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    intent: r.intent,
    count: Number(r.count),
    medianMs: r.median_ms != null ? Number(r.median_ms) : null,
  }));
}

// ---------------------------------------------------------------------------
// Reopened threads (most re-opened in period)
// ---------------------------------------------------------------------------

export async function getReopenedThreads(
  shop: string,
  start: Date,
  end: Date,
  limit = 10,
): Promise<ReopenedThread[]> {
  const rows = await prisma.threadStateHistory.groupBy({
    by: ["threadId"],
    where: {
      shop,
      fromState: "resolved",
      NOT: { toState: "resolved" },
      changedAt: { gte: start, lt: end },
    },
    _count: { _all: true },
    _max: { changedAt: true },
    orderBy: [
      { _count: { threadId: "desc" } },
      { _max: { changedAt: "desc" } },
    ],
    take: limit,
  });
  return rows.map((r) => ({
    threadId: r.threadId,
    reopenCount: r._count._all,
    lastReopenedAt: r._max.changedAt!,
  }));
}

// ---------------------------------------------------------------------------
// Baseline helpers (rolling average over prior windows)
// ---------------------------------------------------------------------------

async function _baselineThreadCount(
  shop: string,
  range: string,
  currentStart: Date,
  where: Prisma.ThreadWhereInput,
): Promise<number | null> {
  if (range === "90d" || range === "custom") return null;

  const durationMs =
    range === "24h" ? 24 * 60 * 60 * 1000
    : range === "7d" ? 7 * 24 * 60 * 60 * 1000
    : 30 * 24 * 60 * 60 * 1000;
  const windowCount = range === "24h" ? 4 : range === "7d" ? 4 : 3;

  const counts = await Promise.all(
    Array.from({ length: windowCount }, (_, i) => {
      let s: Date, e: Date;
      if (range === "24h") {
        // Same DOW baseline: step back by 1 week per window
        s = new Date(currentStart.getTime() - (i + 1) * 7 * 24 * 60 * 60 * 1000);
        e = new Date(s.getTime() + durationMs);
      } else {
        e = new Date(currentStart.getTime() - i * durationMs);
        s = new Date(e.getTime() - durationMs);
      }
      return prisma.thread.count({
        where: { ...where, firstMessageAt: { gte: s, lt: e } },
      });
    }),
  );
  return counts.reduce((a, b) => a + b, 0) / counts.length;
}

async function _baselineEventCount(
  shop: string,
  range: string,
  currentStart: Date,
  countFn: (start: Date, end: Date) => Promise<number>,
): Promise<number | null> {
  if (range === "90d" || range === "custom") return null;

  const durationMs =
    range === "24h" ? 24 * 60 * 60 * 1000
    : range === "7d" ? 7 * 24 * 60 * 60 * 1000
    : 30 * 24 * 60 * 60 * 1000;
  const windowCount = range === "24h" ? 4 : range === "7d" ? 4 : 3;

  const counts = await Promise.all(
    Array.from({ length: windowCount }, (_, i) => {
      let s: Date, e: Date;
      if (range === "24h") {
        s = new Date(currentStart.getTime() - (i + 1) * 7 * 24 * 60 * 60 * 1000);
        e = new Date(s.getTime() + durationMs);
      } else {
        e = new Date(currentStart.getTime() - i * durationMs);
        s = new Date(e.getTime() - durationMs);
      }
      return countFn(s, e);
    }),
  );
  return counts.reduce((a, b) => a + b, 0) / counts.length;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export async function getAlerts(
  shop: string,
  range: string,
  start: Date,
  end: Date,
  topIntents: IntentPerf[],
): Promise<Alert[]> {
  if (range === "90d" || range === "custom") return [];

  const supportWhere = {
    shop,
    supportNature: { in: ["confirmed_support", "probable_support"] as string[] },
  };

  const [currentVolume, baselineVolume, reopened, baselineReopened] =
    await Promise.all([
      prisma.thread.count({ where: { ...supportWhere, firstMessageAt: { gte: start, lt: end } } }),
      _baselineThreadCount(shop, range, start, supportWhere),
      prisma.threadStateHistory.count({
        where: {
          shop,
          fromState: "resolved",
          NOT: { toState: "resolved" },
          changedAt: { gte: start, lt: end },
        },
      }),
      _baselineEventCount(shop, range, start, (s, e) =>
        prisma.threadStateHistory.count({
          where: {
            shop,
            fromState: "resolved",
            NOT: { toState: "resolved" },
            changedAt: { gte: s, lt: e },
          },
        }),
      ),
    ]);

  const alerts: Alert[] = [];

  // Volume surge: >= 2x baseline AND absolute >= 20 threads
  if (
    baselineVolume !== null &&
    baselineVolume > 0 &&
    currentVolume >= 20 &&
    currentVolume >= 2 * baselineVolume
  ) {
    alerts.push({
      type: "volume_surge",
      label: `Volume ×${(currentVolume / baselineVolume).toFixed(1)} vs habituel (${currentVolume} vs ${Math.round(baselineVolume)} attendus)`,
      magnitude: currentVolume / baselineVolume,
      current: currentVolume,
      baseline: baselineVolume,
      inboxFilterParam: "",
    });
  }

  // Reopened spike: >= 2x baseline AND absolute >= 3
  if (
    baselineReopened !== null &&
    baselineReopened > 0 &&
    reopened >= 3 &&
    reopened >= 2 * baselineReopened
  ) {
    alerts.push({
      type: "reopened_spike",
      label: `Ré-ouvertures ×${(reopened / baselineReopened).toFixed(1)} vs habituel (${reopened} vs ${Math.round(baselineReopened)} attendus)`,
      magnitude: reopened / baselineReopened,
      current: reopened,
      baseline: baselineReopened,
      inboxFilterParam: "state=reopened",
    });
  }

  // Intent surges: per-intent >= 2x baseline AND absolute >= 5.
  // Both current (item.count) and baseline count **threads** (not emails),
  // so the units match and the 2× threshold is meaningful.
  for (const item of topIntents) {
    if (item.count < 5) continue;
    const baselineIntent = await _baselineEventCount(shop, range, start, (s, e) =>
      prisma.incomingEmail.findMany({
        where: {
          shop,
          detectedIntent: item.intent,
          receivedAt: { gte: s, lt: e },
          processingStatus: { not: "outgoing" },
        },
        select: { canonicalThreadId: true },
        distinct: ["canonicalThreadId"],
      }).then((r) => r.length),
    );
    if (
      baselineIntent !== null &&
      baselineIntent > 0 &&
      item.count >= 2 * baselineIntent
    ) {
      alerts.push({
        type: "intent_surge",
        label: `${item.intent} ×${(item.count / baselineIntent).toFixed(1)} vs habituel (${item.count} vs ${Math.round(baselineIntent)} attendus)`,
        magnitude: item.count / baselineIntent,
        current: item.count,
        baseline: baselineIntent,
        inboxFilterParam: `intent=${item.intent}`,
      });
    }
  }

  return alerts.sort((a, b) => b.magnitude - a.magnitude);
}
