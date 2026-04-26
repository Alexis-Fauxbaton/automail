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
  end: Date
): Promise<DailyPoint[]> {
  const emails = await prisma.incomingEmail.findMany({
    where: { shop, receivedAt: { gte: start, lt: end }, processingStatus: { not: "outgoing" } },
    select: {
      receivedAt: true,
      tier2Result: true,
      thread: { select: { supportNature: true } },
    },
  });

  const byDay = new Map<string, { total: number; support: number }>();

  const SUPPORT_NATURES = new Set(["confirmed_support", "probable_support"]);

  for (const email of emails) {
    const day = toLocalDay(email.receivedAt);
    const existing = byDay.get(day) ?? { total: 0, support: 0 };
    existing.total += 1;
    const isSupport =
      email.tier2Result === "support_client" ||
      SUPPORT_NATURES.has(email.thread?.supportNature ?? "");
    if (isSupport) existing.support += 1;
    byDay.set(day, existing);
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
  end: Date
): Promise<DailyActivityPoint[]> {
  const [drafts, sent] = await Promise.all([
    prisma.replyDraft.findMany({
      where: { shop, createdAt: { gte: start, lt: end } },
      select: { createdAt: true },
    }),
    prisma.incomingEmail.findMany({
      where: { shop, receivedAt: { gte: start, lt: end }, processingStatus: "outgoing" },
      select: { receivedAt: true },
    }),
  ]);

  const byDay = new Map<string, { drafts: number; sent: number }>();

  for (const d of drafts) {
    const day = toLocalDay(d.createdAt);
    const existing = byDay.get(day) ?? { drafts: 0, sent: 0 };
    existing.drafts += 1;
    byDay.set(day, existing);
  }
  for (const s of sent) {
    const day = toLocalDay(s.receivedAt);
    const existing = byDay.get(day) ?? { drafts: 0, sent: 0 };
    existing.sent += 1;
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
