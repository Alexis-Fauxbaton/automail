-- Migration: 20260422130000_job_backoff_and_confidence
--
-- 1. SyncJob.nextRetryAt — supports exponential backoff; claimNextJob skips
--    rows where nextRetryAt > now(), markJobFailed sets it on retry.
--
-- 2. SyncJob index change — replace (status, createdAt) with (status, nextRetryAt)
--    so the claim query uses the index instead of a full scan.
--
-- 3. IncomingEmail.analysisConfidence — promoted out of the analysisResult JSON
--    blob. Populated atomically with analysisResult in classifyAndDraft and
--    reanalyzeEmail. Historical rows stay NULL until next reanalyze.
--
-- Non-breaking: all new columns are nullable / have defaults.

-- 1. Add nextRetryAt to SyncJob
ALTER TABLE "SyncJob"
  ADD COLUMN "nextRetryAt" TIMESTAMP(3);

-- 2. Replace the (status, createdAt) index with (status, nextRetryAt) for
--    efficient claim queries that respect the backoff window.
DROP INDEX IF EXISTS "SyncJob_status_createdAt_idx";
CREATE INDEX "SyncJob_status_nextRetryAt_idx" ON "SyncJob"("status", "nextRetryAt");

-- 3. Add analysisConfidence to IncomingEmail
ALTER TABLE "IncomingEmail"
  ADD COLUMN "analysisConfidence" TEXT;

CREATE INDEX "IncomingEmail_shop_analysisConfidence_idx"
  ON "IncomingEmail"("shop", "analysisConfidence");
