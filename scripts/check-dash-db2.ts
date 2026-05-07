import { getPeriodBounds, getTopIntentsWithPerf, getCurrentThreadStates, getReopenedThreads } from "../app/lib/dashboard-stats.js";

const SHOP = "2ed20e.myshopify.com";
const now = new Date("2026-05-07T22:00:00Z");
const bounds = getPeriodBounds("30d", undefined, undefined, now);

const [intents, states, reopened] = await Promise.all([
  getTopIntentsWithPerf(SHOP, bounds.start, bounds.end, 8),
  getCurrentThreadStates(SHOP),
  getReopenedThreads(SHOP, bounds.start, bounds.end, 10),
]);

console.log("=== Top motifs (top 8) ===");
intents.forEach((i, idx) => {
  const med = i.medianMs ? (i.medianMs / 3600000).toFixed(1) + "h" : "null";
  console.log(`  ${idx + 1}. ${i.intent} — ${i.count} threads — médian ${med}`);
});

console.log("");
console.log("=== État actuel de la file ===");
console.log("  Ouvert            :", states.open);
console.log("  Attente client    :", states.waiting_customer);
console.log("  À traiter         :", states.waiting_merchant);
console.log("  Résolu            :", states.resolved);
console.log("  Sans réponse req. :", states.no_reply_needed);

console.log("");
console.log("=== Threads ré-ouverts récents (top 6) ===");
reopened.slice(0, 6).forEach(r => {
  const d = r.lastReopenedAt.toLocaleDateString("fr-FR");
  console.log(`  ×${r.reopenCount} — ${r.threadId.slice(0, 28)}... — ${d}`);
});

process.exit(0);
