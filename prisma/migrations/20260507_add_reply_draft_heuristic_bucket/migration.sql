-- AlterTable
ALTER TABLE "ReplyDraft" ADD COLUMN "heuristicBucket" TEXT,
ADD COLUMN "heuristicComputedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ReplyDraft_shop_heuristicBucket_createdAt_idx" ON "ReplyDraft"("shop", "heuristicBucket", "createdAt");
