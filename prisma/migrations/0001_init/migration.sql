-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportSettings" (
    "shop" TEXT NOT NULL,
    "signatureName" TEXT NOT NULL DEFAULT 'Customer Support',
    "brandName" TEXT NOT NULL DEFAULT '',
    "tone" TEXT NOT NULL DEFAULT 'friendly',
    "language" TEXT NOT NULL DEFAULT 'auto',
    "closingPhrase" TEXT NOT NULL DEFAULT '',
    "shareTrackingNumber" BOOLEAN NOT NULL DEFAULT true,
    "customerGreetingStyle" TEXT NOT NULL DEFAULT 'auto',
    "refundPolicy" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportSettings_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "MailConnection" (
    "shop" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'gmail',
    "email" TEXT NOT NULL DEFAULT '',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "tokenExpiry" TIMESTAMP(3) NOT NULL,
    "historyId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "zohoAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailConnection_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "IncomingEmail" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL DEFAULT '',
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL DEFAULT '',
    "bodyText" TEXT NOT NULL DEFAULT '',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "tier1Result" TEXT,
    "tier2Result" TEXT,
    "isKnownCustomer" BOOLEAN NOT NULL DEFAULT false,
    "processingStatus" TEXT NOT NULL DEFAULT 'pending',
    "analysisResult" TEXT,
    "draftReply" TEXT,
    "draftHistory" TEXT NOT NULL DEFAULT '[]',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncomingEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IncomingEmail_shop_externalMessageId_key" ON "IncomingEmail"("shop", "externalMessageId");

-- CreateIndex
CREATE INDEX "IncomingEmail_shop_processingStatus_idx" ON "IncomingEmail"("shop", "processingStatus");

-- CreateIndex
CREATE INDEX "IncomingEmail_shop_receivedAt_idx" ON "IncomingEmail"("shop", "receivedAt");
