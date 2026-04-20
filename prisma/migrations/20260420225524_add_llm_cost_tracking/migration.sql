-- AlterTable
ALTER TABLE "IncomingEmail" ADD COLUMN     "llmCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "llmTokensTotal" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "LlmCallLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "emailId" TEXT,
    "threadId" TEXT,
    "callSite" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL,
    "completionTokens" INTEGER NOT NULL,
    "totalTokens" INTEGER NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LlmCallLog_shop_createdAt_idx" ON "LlmCallLog"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "LlmCallLog_emailId_idx" ON "LlmCallLog"("emailId");

-- CreateIndex
CREATE INDEX "LlmCallLog_threadId_idx" ON "LlmCallLog"("threadId");
