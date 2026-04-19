-- CreateTable
CREATE TABLE "GmailConnection" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "googleEmail" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "tokenExpiry" DATETIME NOT NULL,
    "historyId" TEXT,
    "lastSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "IncomingEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL DEFAULT '',
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL DEFAULT '',
    "bodyText" TEXT NOT NULL DEFAULT '',
    "receivedAt" DATETIME NOT NULL,
    "tier1Result" TEXT,
    "tier2Result" TEXT,
    "isKnownCustomer" BOOLEAN NOT NULL DEFAULT false,
    "processingStatus" TEXT NOT NULL DEFAULT 'pending',
    "analysisResult" TEXT,
    "draftReply" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "IncomingEmail_shop_processingStatus_idx" ON "IncomingEmail"("shop", "processingStatus");

-- CreateIndex
CREATE INDEX "IncomingEmail_shop_receivedAt_idx" ON "IncomingEmail"("shop", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingEmail_shop_gmailMessageId_key" ON "IncomingEmail"("shop", "gmailMessageId");
