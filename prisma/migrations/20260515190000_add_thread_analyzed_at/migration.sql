-- AlterTable
ALTER TABLE "Thread" ADD COLUMN "analyzedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Thread_shop_analyzedAt_idx" ON "Thread"("shop", "analyzedAt");
