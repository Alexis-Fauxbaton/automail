-- Rename BillingUsage.draftsCount to analyzedThreadsCount.
-- The data is preserved via RENAME (no drop / re-create).
ALTER TABLE "BillingUsage" RENAME COLUMN "draftsCount" TO "analyzedThreadsCount";

-- Reset current-period counters so existing shops get a fresh quota
-- under the new model. Historical rows from previous periods are
-- preserved as audit trail.
UPDATE "BillingUsage"
SET "analyzedThreadsCount" = 0
WHERE "periodStart" >= date_trunc('month', NOW() AT TIME ZONE 'UTC');
