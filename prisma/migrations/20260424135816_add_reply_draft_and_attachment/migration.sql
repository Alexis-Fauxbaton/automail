-- CreateTable
CREATE TABLE "ReplyDraft" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "body" TEXT,
    "bodyHistory" JSONB NOT NULL DEFAULT '[]',
    "subject" TEXT,
    "cc" TEXT,
    "bcc" TEXT,
    "replyMode" TEXT NOT NULL DEFAULT 'thread',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplyDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftAttachment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "replyDraftId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "storagePath" TEXT,
    "threadAttachmentRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DraftAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReplyDraft_emailId_key" ON "ReplyDraft"("emailId");

-- CreateIndex
CREATE INDEX "ReplyDraft_shop_idx" ON "ReplyDraft"("shop");

-- CreateIndex
CREATE INDEX "DraftAttachment_shop_idx" ON "DraftAttachment"("shop");

-- CreateIndex
CREATE INDEX "DraftAttachment_replyDraftId_idx" ON "DraftAttachment"("replyDraftId");

-- AddForeignKey
ALTER TABLE "ReplyDraft" ADD CONSTRAINT "ReplyDraft_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "IncomingEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftAttachment" ADD CONSTRAINT "DraftAttachment_replyDraftId_fkey" FOREIGN KEY ("replyDraftId") REFERENCES "ReplyDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
