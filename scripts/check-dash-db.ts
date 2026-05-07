import { getPeriodBounds, getDashboardKpis, getReopenedThreads, getCurrentThreadStates } from "../app/lib/dashboard-stats.js";

const SHOP = "2ed20e.myshopify.com";
const now = new Date("2026-05-07T22:00:00Z"); // ~midnight Paris time (UTC+2)
const bounds = getPeriodBounds("30d", undefined, undefined, now);

console.log("Period:", bounds.start.toISOString(), "->", bounds.end.toISOString());
console.log("Prev  :", bounds.prevStart.toISOString(), "->", bounds.prevEnd.toISOString());

const [kpis, reopened, states] = await Promise.all([
  getDashboardKpis(SHOP, bounds.start, bounds.end, bounds.prevStart, bounds.prevEnd),
  getReopenedThreads(SHOP, bounds.start, bounds.end, 10),
  getCurrentThreadStates(SHOP),
]);

const fmt = (ms: number | null) => ms ? (ms / 3600000).toFixed(1) + "h" : "null";
const pct = (cur: number, prev: number) =>
  prev > 0 ? ((cur - prev) / prev * 100).toFixed(0) + "%" : "N/A";

console.log("");
console.log("=== KPIs 30d ===");
console.log("Median response :", fmt(kpis.responseTime.medianMs), "| raw ms:", Math.round(kpis.responseTime.medianMs ?? 0));
console.log("P90 response    :", fmt(kpis.responseTime.p90Ms));
console.log("Prev median     :", fmt(kpis.responseTime.prevMedianMs));
console.log("Response var%   :", kpis.responseTime.medianMs && kpis.responseTime.prevMedianMs
  ? pct(kpis.responseTime.medianMs, kpis.responseTime.prevMedianMs)
  : "N/A");
console.log("Reopened count  :", kpis.reopened.count, "| prev:", kpis.reopened.prevCount);
console.log("Volume current  :", kpis.volume.count, "| prev:", kpis.volume.prevCount);
console.log("Volume var%     :", pct(kpis.volume.count, kpis.volume.prevCount));
console.log("Draft as_is     :", kpis.draftUsage.asIs);
console.log("Draft edited    :", kpis.draftUsage.edited);
console.log("Draft ignored   :", kpis.draftUsage.ignored);
console.log("Draft pending   :", kpis.draftUsage.pending);
console.log("Draft sentPct   :", kpis.draftUsage.sentPct !== null ? kpis.draftUsage.sentPct + "%" : "null — no classified drafts");
console.log("");
console.log("=== Thread states (snapshot actuel) ===");
console.log("  open            :", states.open);
console.log("  waiting_customer:", states.waiting_customer);
console.log("  waiting_merchant:", states.waiting_merchant);
console.log("  resolved        :", states.resolved);
console.log("  no_reply_needed :", states.no_reply_needed);
console.log("");
console.log("=== Reopened threads (" + reopened.length + ") ===");
for (const r of reopened) {
  console.log(" -", r.threadId, "| reopenCount:", r.reopenCount, "| last:", r.lastReopenedAt.toISOString());
}

process.exit(0);
