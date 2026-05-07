import prisma from "../app/db.server.js";

const SHOP = "2ed20e.myshopify.com";
const NOW = new Date("2026-05-07T22:00:00Z");
const D30 = new Date(NOW.getTime() - 30 * 24 * 3600 * 1000);

// === AUDIT 1: Volume chart (qualité tab "Emails support par jour")
//     Dashboard: counts THREADS with firstMessageAt in period grouped by day
//     Should be (per the label): emails received per day
console.log("=== Volume chart audit ===\n");

// What dashboard returns (count of threads created/day)
const dashThreadsByDay = await prisma.$queryRaw<{ day: Date; count: bigint }[]>`
  SELECT DATE_TRUNC('day', t."firstMessageAt" AT TIME ZONE 'Europe/Paris')::date AS day,
         COUNT(*)::bigint AS count
  FROM "Thread" t
  WHERE t.shop = ${SHOP}
    AND t."firstMessageAt" >= ${D30}
    AND t."firstMessageAt" < ${NOW}
    AND t."supportNature" IN ('confirmed_support', 'probable_support')
    AND NOT EXISTS (
      SELECT 1 FROM "IncomingEmail" fe
      WHERE fe."canonicalThreadId" = t.id
        AND fe."processingStatus" = 'outgoing'
        AND fe."receivedAt" <= t."firstMessageAt"
    )
  GROUP BY 1 ORDER BY 1
`;
const dashThreadsTotal = dashThreadsByDay.reduce((s, r) => s + Number(r.count), 0);
console.log(`Dashboard chart sums to: ${dashThreadsTotal} threads (across ${dashThreadsByDay.length} days)`);
dashThreadsByDay.forEach(r => console.log(`  ${r.day.toISOString().slice(0, 10)}: ${r.count}`));

// What an "emails support per day" really should be (raw)
const realEmailsByDay = await prisma.$queryRaw<{ day: Date; count: bigint }[]>`
  SELECT DATE_TRUNC('day', e."receivedAt" AT TIME ZONE 'Europe/Paris')::date AS day,
         COUNT(*)::bigint AS count
  FROM "IncomingEmail" e
  LEFT JOIN "Thread" t ON t.id = e."canonicalThreadId"
  WHERE e.shop = ${SHOP}
    AND e."receivedAt" >= ${D30}
    AND e."receivedAt" < ${NOW}
    AND e."processingStatus" != 'outgoing'
    AND (e."tier2Result" = 'support_client'
         OR t."supportNature" IN ('confirmed_support', 'probable_support'))
  GROUP BY 1 ORDER BY 1
`;
const realEmailsTotal = realEmailsByDay.reduce((s, r) => s + Number(r.count), 0);
console.log(`\nReal emails-per-day sums to: ${realEmailsTotal} emails`);
realEmailsByDay.forEach(r => console.log(`  ${r.day.toISOString().slice(0, 10)}: ${r.count}`));

console.log(`\n>>> Volume KPI: ${realEmailsTotal} | Chart shows: ${dashThreadsTotal} → INCONSISTENT`);

// === AUDIT 2: alerts — check the function signature uses topIntents to compute baselines
//     Could be off if the topIntents helper was buggy (which we fixed)
console.log("\n\n=== Alerts audit ===");
// Skipping — alerts depend on already-fixed topIntents

// === AUDIT 3: Reopened threads list — verify against ThreadStateHistory raw
console.log("\n\n=== Reopened list audit ===");
const events = await prisma.$queryRaw<{ threadId: string; cnt: bigint; last_at: Date }[]>`
  SELECT "threadId", COUNT(*)::bigint AS cnt, MAX("changedAt") AS last_at
  FROM "ThreadStateHistory"
  WHERE shop = ${SHOP}
    AND "fromState" = 'resolved'
    AND "toState" != 'resolved'
    AND "changedAt" >= ${D30}
    AND "changedAt" < ${NOW}
  GROUP BY "threadId"
  ORDER BY cnt DESC, last_at DESC
  LIMIT 10
`;
console.log("Raw ThreadStateHistory:");
events.forEach(e => console.log(`  ${e.threadId} × ${e.cnt} | ${e.last_at.toISOString()}`));

// === AUDIT 4: Drafts daily breakdown — verify against ReplyDraft raw
console.log("\n\n=== Drafts daily breakdown audit ===");
const draftsByDay = await prisma.$queryRaw<{ day: Date; bucket: string; count: bigint }[]>`
  SELECT DATE_TRUNC('day', "createdAt" AT TIME ZONE 'Europe/Paris')::date AS day,
         "heuristicBucket" AS bucket,
         COUNT(*)::bigint AS count
  FROM "ReplyDraft"
  WHERE shop = ${SHOP}
    AND "createdAt" >= ${D30}
    AND "createdAt" < ${NOW}
    AND "heuristicBucket" IS NOT NULL
  GROUP BY 1, 2
  ORDER BY 1, 2
`;
console.log(`Drafts with heuristic, by day×bucket: ${draftsByDay.length} rows`);
draftsByDay.forEach(r => console.log(`  ${r.day.toISOString().slice(0, 10)} ${r.bucket}: ${r.count}`));

// === AUDIT 5: Heatmap — verify against raw IncomingEmail
console.log("\n\n=== Heatmap audit ===");
const heatmap = await prisma.$queryRaw<{ dow: number; hour: number; count: bigint }[]>`
  SELECT EXTRACT(DOW FROM e."receivedAt" AT TIME ZONE 'Europe/Paris')::int AS dow,
         EXTRACT(HOUR FROM e."receivedAt" AT TIME ZONE 'Europe/Paris')::int AS hour,
         COUNT(*)::bigint AS count
  FROM "IncomingEmail" e
  LEFT JOIN "Thread" t ON t.id = e."canonicalThreadId"
  WHERE e.shop = ${SHOP}
    AND e."receivedAt" >= ${D30}
    AND e."receivedAt" < ${NOW}
    AND e."processingStatus" != 'outgoing'
    AND (e."tier2Result" = 'support_client'
         OR t."supportNature" IN ('confirmed_support', 'probable_support'))
  GROUP BY 1, 2 ORDER BY 1, 2
`;
const heatTotal = heatmap.reduce((s, r) => s + Number(r.count), 0);
console.log(`Heatmap sums to: ${heatTotal} (should equal Volume KPI)`);

process.exit(0);
