// Dashboard statistics helpers — period bounds computation and aggregated DB queries.

import prisma from "../db.server";

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
      where: { shop, receivedAt: { gte: start, lt: end } },
    }),
    prisma.incomingEmail.count({
      where: { shop, receivedAt: { gte: start, lt: end }, tier2Result: "support_client" },
    }),
    prisma.replyDraft.count({
      where: {
        shop,
        email: { receivedAt: { gte: start, lt: end } },
      },
    }),
    prisma.incomingEmail.count({
      where: { shop, receivedAt: { gte: prevStart, lt: prevEnd } },
    }),
    prisma.incomingEmail.count({
      where: { shop, receivedAt: { gte: prevStart, lt: prevEnd }, tier2Result: "support_client" },
    }),
    prisma.replyDraft.count({
      where: {
        shop,
        email: { receivedAt: { gte: prevStart, lt: prevEnd } },
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
    where: { shop, receivedAt: { gte: start, lt: end } },
    select: { receivedAt: true, tier2Result: true },
  });

  const byDay = new Map<string, { total: number; support: number }>();

  for (const email of emails) {
    const day = email.receivedAt.toISOString().slice(0, 10);
    const existing = byDay.get(day) ?? { total: 0, support: 0 };
    existing.total += 1;
    if (email.tier2Result === "support_client") existing.support += 1;
    byDay.set(day, existing);
  }

  // Fill days with no emails for a continuous series
  const points: DailyPoint[] = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const endDay = end.toISOString().slice(0, 10);

  while (cursor.toISOString().slice(0, 10) <= endDay) {
    const day = cursor.toISOString().slice(0, 10);
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
  const [newConversations, resolvedConversations, reopenedConversations] = await Promise.all([
    prisma.thread.count({
      where: { shop, firstMessageAt: { gte: start, lt: end } },
    }),
    prisma.threadStateHistory.count({
      where: { shop, toState: "resolved", changedAt: { gte: start, lt: end } },
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
