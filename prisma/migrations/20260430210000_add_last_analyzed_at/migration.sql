-- AlterTable
ALTER TABLE "IncomingEmail" ADD COLUMN "lastAnalyzedAt" TIMESTAMP(3);

-- Index to quickly find stale analyses to refresh.
CREATE INDEX "IncomingEmail_shop_lastAnalyzedAt_idx" ON "IncomingEmail"("shop", "lastAnalyzedAt");
