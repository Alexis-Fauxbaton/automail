-- CreateTable
CREATE TABLE "ThreadStateHistory" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadStateHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ThreadStateHistory_shop_changedAt_idx" ON "ThreadStateHistory"("shop", "changedAt");

-- CreateIndex
CREATE INDEX "ThreadStateHistory_threadId_changedAt_idx" ON "ThreadStateHistory"("threadId", "changedAt");

-- AddForeignKey
ALTER TABLE "ThreadStateHistory" ADD CONSTRAINT "ThreadStateHistory_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
