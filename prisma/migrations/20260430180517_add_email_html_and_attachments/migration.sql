-- AlterTable
ALTER TABLE "IncomingEmail" ADD COLUMN     "bodyHtml" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "hasAttachments" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "IncomingEmailAttachment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentId" TEXT,
    "disposition" TEXT NOT NULL,
    "inlineData" TEXT,
    "provider" TEXT NOT NULL,
    "providerMsgId" TEXT NOT NULL,
    "providerAttachId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncomingEmailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncomingEmailAttachment_shop_idx" ON "IncomingEmailAttachment"("shop");

-- CreateIndex
CREATE INDEX "IncomingEmailAttachment_emailId_idx" ON "IncomingEmailAttachment"("emailId");

-- AddForeignKey
ALTER TABLE "IncomingEmailAttachment" ADD CONSTRAINT "IncomingEmailAttachment_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "IncomingEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
