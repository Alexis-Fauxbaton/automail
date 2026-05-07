// Dashboard statistics helpers â€” period bounds computation and aggregated DB queries.

import prisma from "../db.server";

// Timezone used for day bucketing (label display and chart grouping).
// A mail received at 01:22 local time must not appear on the previous UTC day.
const DISPLAY_TZ = "Europe/Paris";

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

export type KpiStats = {
  totalEmails: number;
  supportEmails: number;
  draftsCreated: number;
  sentEmails: number | null;
  prevTotalEmails: number;
  prevSupportEmails: number;
  prevDraftsCreated: number;
};

export type DailyPoint = {
  date: string; // "YYYY-MM-DD"
  total: number;
  support: number;
};

export type DailyActivityPoint = {
  date: string; // "YYYY-MM-DD"
  drafts: number;
  sent: number;
};

export type ThreadStateCounts = {
  open: number;
  waiting_customer: number;
  waiting_merchant: number;
  resolved: number;
  no_reply_needed: number;
};

export type ConversationStats = {
  newConversations: number;
  resolvedConversations: number;
  reopenedConversations: number;
};

export type IntentCount = {
  intent: string;
  count: number;
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

export async function getKpiStats(
  shop: string,
  start: Date,
  end: Date,
  prevStart: Date,
  prevEnd: Date
): Promise<KpiStats> {
  const [
    totalEmails,
    supportEmails,
    draftsCreated,
    prevTotalEmails,
    prevSupportEmails,
    prevDraftsCreated,
  ] = await Promise.all([
    prisma.incomingEmail.count({
      where: { shop, receivedAt: { gte: start, lt: end }, processingStatus: { not: "outgoing" } },
    }),
    // Count incoming emails that are either directly classified support, or belong
    // to a confirmed/probable support thread. The pipeline only LLM-classifies the
    // latest message per thread, so older messages in a support thread have
    // tier2=null and would otherwise be missed.
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
    prisma.replyDraft.count({
      where: {
        shop,
        createdAt: { gte: start, lt: end },
      },
    }),
    prisma.incomingEmail.count({
      where: { shop, receivedAt: { gte: prevStart, lt: prevEnd }, processingStatus: { not: "outgoing" } },
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
    prisma.replyDraft.count({
      where: {
        shop,
        createdAt: { gte: prevStart, lt: prevEnd },
      },
    }),
  ]);

  return {
    totalEmails,
    supportEmails,
    draftsCreated,
    sentEmails: null,
    prevTotalEmails,
    prevSupportEmails,
    prevDraftsCreated,
  };
}

export async function getDailyBreakdown(
  shop: string,
  start: Date,
  end: Date,
): Promise<DailyPoint[]> {
  type Row = { day: Date; total: bigint; support: bigint };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      DATE_TRUNC('day', e."receivedAt" AT TIME ZONE 'Europe/Paris')::date AS day,
      COUNT(*)::bigint                                                      AS total,
      COUNT(*) FILTER (
        WHERE e."tier2Result" = 'support_client'
        OR t."supportNature" IN ('confirmed_support', 'probable_support')
      )::bigint                                                             AS support
    FROM "IncomingEmail" e
    LEFT JOIN "Thread" t ON t.id = e."canonicalThreadId"
    WHERE e.shop = ${shop}
      AND e."receivedAt" >= ${start}
      AND e."receivedAt" < ${end}
      AND e."processingStatus" != 'outgoing'
    GROUP BY 1
    ORDER BY 1
  `;

  // Index results by local-day string for fast lookup
  const byDay = new Map<string, { total: number; support: number }>();
  for (const row of rows) {
    const day = toLocalDay(row.day);
    byDay.set(day, { total: Number(row.total), support: Number(row.support) });
  }

  // Fill days with no emails for a continuous series
  const points: DailyPoint[] = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const endDay = toLocalDay(end);
  while (toLocalDay(cursor) <= endDay) {
    const day = toLocalDay(cursor);
    const data = byDay.get(day) ?? { total: 0, support: 0 };
    points.push({ date: day, ...data });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}

export async function getCurrentThreadStates(shop: string): Promise<ThreadStateCounts> {
  const rows = await prisma.thread.groupBy({
    by: ["operationalState"],
    where: { shop },
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

export async function getConversationStats(
  shop: string,
  start: Date,
  end: Date
): Promise<ConversationStats> {
  const [
    newConversations,
    resolvedFromHistory,
    // Fallback: threads currently resolved whose state was last updated in the
    // period. Covers the gap before ThreadStateHistory was introduced (2026-04-21).
    resolvedFromState,
    reopenedConversations,
  ] = await Promise.all([
    prisma.thread.count({
      where: { shop, firstMessageAt: { gte: start, lt: end } },
    }),
    prisma.threadStateHistory.count({
      where: { shop, toState: "resolved", changedAt: { gte: start, lt: end } },
    }),
    prisma.thread.count({
      where: {
        shop,
        operationalState: "resolved",
        operationalStateUpdatedAt: { gte: start, lt: end },
      },
    }),
    prisma.threadStateHistory.count({
      where: {
        shop,
        fromState: "resolved",
        NOT: { toState: "resolved" },
        changedAt: { gte: start, lt: end },
      },
    }),
  ]);

  // Take the higher of the two resolution counts: the history table is
  // authoritative when populated; the state timestamp is the fallback for
  // threads resolved before the history table existed.
  const resolvedConversations = Math.max(resolvedFromHistory, resolvedFromState);

  return { newConversations, resolvedConversations, reopenedConversations };
}

export async function getIntentBreakdown(
  shop: string,
  start: Date,
  end: Date
): Promise<IntentCount[]> {
  const rows = await prisma.incomingEmail.groupBy({
    by: ["detectedIntent"],
    where: {
      shop,
      receivedAt: { gte: start, lt: end },
      detectedIntent: { not: null },
    },
    _count: { _all: true },
    orderBy: [{ _count: { detectedIntent: "desc" } }],
    take: 5,
  });

  return rows.map((r) => ({
    intent: r.detectedIntent as string,
    count: r._count._all,
  }));
}

export async function getDailyActivityBreakdown(
  shop: string,
  start: Date,
  end: Date,
): Promise<DailyActivityPoint[]> {
  type DraftRow = { day: Date; count: bigint };
  type SentRow  = { day: Date; count: bigint };
  const [draftRows, sentRows] = await Promise.all([
    prisma.$queryRaw<DraftRow[]>`
      SELECT
        DATE_TRUNC('day', "createdAt" AT TIME ZONE 'Europe/Paris')::date AS day,
        COUNT(*)::bigint AS count
      FROM "ReplyDraft"
      WHERE shop = ${shop}
        AND "createdAt" >= ${start}
        AND "createdAt" < ${end}
      GROUP BY 1
      ORDER BY 1
    `,
    prisma.$queryRaw<SentRow[]>`
      SELECT
        DATE_TRUNC('day', "receivedAt" AT TIME ZONE 'Europe/Paris')::date AS day,
        COUNT(*)::bigint AS count
      FROM "IncomingEmail"
      WHERE shop = ${shop}
        AND "receivedAt" >= ${start}
        AND "receivedAt" < ${end}
        AND "processingStatus" = 'outgoing'
      GROUP BY 1
      ORDER BY 1
    `,
  ]);

  const byDay = new Map<string, { drafts: number; sent: number }>();
  for (const r of draftRows) {
    const day = toLocalDay(r.day);
    byDay.set(day, { drafts: Number(r.count), sent: 0 });
  }
  for (const r of sentRows) {
    const day = toLocalDay(r.day);
    const existing = byDay.get(day) ?? { drafts: 0, sent: 0 };
    existing.sent = Number(r.count);
    byDay.set(day, existing);
  }

  const points: DailyActivityPoint[] = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const endDay = toLocalDay(end);
  while (toLocalDay(cursor) <= endDay) {
    const day = toLocalDay(cursor);
    const data = byDay.get(day) ?? { drafts: 0, sent: 0 };
    points.push({ date: day, ...data });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return points;
}

// ---------------------------------------------------------------------------
// Shared percentile helper (in-process, for small datasets)
// ---------------------------------------------------------------------------

function _percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
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
        DATE_TRUNC('day', t."firstMessageAt" AT TIME ZONE 'Europe/Paris')::date AS day,
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
      DATE_TRUNC('day', "createdAt" AT TIME ZONE 'Europe/Paris')::date AS day,
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
