-- Pass 2 audit: focused composite + secondary indexes for dashboard / refresh / duplicate-detection queries.
-- All CREATE INDEX statements are IF NOT EXISTS so re-applying on partially-migrated environments is safe.

-- Thread.firstMessageAt range queries used by dashboard-stats `_fetchResponseTimesMs`.
CREATE INDEX IF NOT EXISTS "Thread_shop_firstMessageAt_idx" ON "Thread"("shop", "firstMessageAt");

-- Detect duplicate canonical threads after backfill races on (shop, provider, subjectKey).
CREATE INDEX IF NOT EXISTS "Thread_shop_provider_subjectKey_idx" ON "Thread"("shop", "provider", "subjectKey");

-- Plain canonicalThreadId index for COUNT(*) / simple lookups that don't need the receivedAt suffix.
CREATE INDEX IF NOT EXISTS "IncomingEmail_canonicalThreadId_idx" ON "IncomingEmail"("canonicalThreadId");

-- Covers refresh-stale-analyses query: shop + processingStatus + lastAnalyzedAt range.
CREATE INDEX IF NOT EXISTS "IncomingEmail_shop_processingStatus_lastAnalyzedAt_idx"
  ON "IncomingEmail"("shop", "processingStatus", "lastAnalyzedAt");

-- Covering index for dashboard alerts: shop + fromState + toState + changedAt range.
CREATE INDEX IF NOT EXISTS "ThreadStateHistory_shop_fromState_toState_changedAt_idx"
  ON "ThreadStateHistory"("shop", "fromState", "toState", "changedAt");
