/**
 * Smoke test for the structured logger. Runs outside the test runner so
 * we see exactly what hits stdout/stderr in a real Node process.
 *
 * Run:   npx tsx scripts/smoke-logger.ts
 */

import { createLogger } from "../app/lib/log/logger";

const log = createLogger({
  shop: "dev-store.myshopify.com",
  mod: "smoke",
  correlationId: "corr-smoke-001",
});

log.info("hello — info line");
log.warn({ queueDepth: 12 }, "queue is filling up");
log.debug({ step: "tier1" }, "regex prefilter starting");

const child = log.child({ canonicalThreadId: "thr_abc123", emailId: "em_xyz789" });
child.info("nested context line");

// PII sanitization
log.info("found alice@example.com placed order #4567 with token 1Z999AA10123456789");

// Error path
try {
  throw new Error("Customer bob@store.com lookup failed for order #9876");
} catch (err) {
  log.error({ err }, "Shopify search failed");
}

// Missing shop fail-loud path
createLogger({ shop: "", mod: "broken-caller" }).info("this should still emit");
