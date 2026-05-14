/**
 * Centralised metric definitions.
 *
 * Keep names + help text here so every instrumented site uses the same
 * spelling and the dashboard / Prometheus scrape see a consistent surface.
 * Adding a new metric: define it here, import the accessor where needed.
 *
 * Naming convention (Prometheus): `<subsystem>_<noun>_<unit>`. Counters end
 * in `_total`, durations in `_seconds`, sizes in `_bytes`.
 */

import { metrics } from "./registry";

// --- Auto-sync / job queue ---
export const autoSyncJobsTotal = metrics.counter(
  "auto_sync_jobs_total",
  "Total auto-sync jobs by shop, kind, and final status.",
);
export const autoSyncJobDurationSeconds = metrics.histogram(
  "auto_sync_job_duration_seconds",
  "Duration of completed auto-sync jobs.",
);
export const autoSyncInFlight = metrics.gauge(
  "auto_sync_in_flight",
  "Number of jobs currently running on this worker.",
);
export const autoSyncLeader = metrics.gauge(
  "auto_sync_leader",
  "1 when this worker holds the leader advisory lock, 0 otherwise.",
);

// --- LLM (OpenAI) ---
export const llmCallsTotal = metrics.counter(
  "llm_calls_total",
  "Total LLM calls by shop, call_site, model, and status (ok|error|rate_limited|breaker_open).",
);
export const llmTokensTotal = metrics.counter(
  "llm_tokens_total",
  "Total LLM tokens consumed, labelled by shop and direction (prompt|completion).",
);
export const llmCostUsdTotal = metrics.counter(
  "llm_cost_usd_total",
  "Cumulative LLM cost in USD, labelled by shop and call_site.",
);
export const llmDurationSeconds = metrics.histogram(
  "llm_duration_seconds",
  "Duration of LLM calls labelled by call_site and model.",
);
export const llmSemaphoreInFlight = metrics.gauge(
  "llm_semaphore_in_flight",
  "Number of LLM calls currently in flight (held the semaphore).",
);
export const llmSemaphoreQueued = metrics.gauge(
  "llm_semaphore_queued",
  "Number of LLM callers currently queued behind the semaphore.",
);

// --- Circuit breakers ---
export const breakerState = metrics.gauge(
  "breaker_state",
  "Current state of each named circuit breaker. 1 = open, 0 = closed.",
);
export const breakerTransitionsTotal = metrics.counter(
  "breaker_transitions_total",
  "Total circuit-breaker state changes by name and target state.",
);

// --- HTTP / route layer (optional, lightweight) ---
export const httpRequestsTotal = metrics.counter(
  "http_requests_total",
  "Total HTTP requests handled, labelled by route and status_code.",
);

// --- Refine context refresh (edit-time) ---
export const refineContextRefreshTotal = metrics.counter(
  "refine_context_refresh_total",
  "Outcomes of the edit-time analysis refresh triggered by handleEditThreadIdentifiers.",
);

// --- Helper to time a histogram observation. Returns a stop() function
//     that records duration in seconds. ---
export function startTimer(): () => number {
  const start = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - start) / 1e9;
}
