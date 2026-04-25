-- AlterTable
ALTER TABLE "IncomingEmail" ADD COLUMN     "labelIds" TEXT NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "SupportSettings" ADD COLUMN     "autoDraft" BOOLEAN NOT NULL DEFAULT true;
