-- AlterTable
ALTER TABLE "IncomingEmail" ADD COLUMN     "extractedIdentifiers" TEXT NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "resolutionConfidence" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "resolvedCustomerName" TEXT,
ADD COLUMN     "resolvedEmail" TEXT,
ADD COLUMN     "resolvedFromMessageId" TEXT,
ADD COLUMN     "resolvedOrderNumber" TEXT,
ADD COLUMN     "resolvedTrackingNumber" TEXT;
