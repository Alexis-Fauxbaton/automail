-- Add cooldown gate for the stale-unknown classify cron.
-- lastClassifyAttemptAt is stamped before each Tier 2 LLM call so the
-- hourly cron (enqueueClassifyStaleUnknown) skips threads retried < 24 h ago.
ALTER TABLE "Thread" ADD COLUMN "lastClassifyAttemptAt" TIMESTAMP(3);

CREATE INDEX "Thread_supportNature_lastClassifyAttemptAt_idx"
  ON "Thread"("supportNature", "lastClassifyAttemptAt");
