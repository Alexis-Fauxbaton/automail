-- AlterTable
ALTER TABLE "Thread" ADD COLUMN "analyzedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Thread_shop_analyzedAt_idx" ON "Thread"("shop", "analyzedAt");

-- Backfill: any Thread with at least one analyzed IncomingEmail
-- is considered already-paid. Set analyzedAt to the thread's createdAt
-- as a stable, monotonic proxy.
UPDATE "Thread" t
SET "analyzedAt" = t."createdAt"
WHERE EXISTS (
  SELECT 1
  FROM "IncomingEmail" ie
  WHERE ie."canonicalThreadId" = t.id
    AND ie."analysisResult" IS NOT NULL
);
