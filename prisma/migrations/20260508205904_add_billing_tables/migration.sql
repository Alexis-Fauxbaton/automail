-- AlterTable
ALTER TABLE "SupportSettings" DROP COLUMN "autoDraft";

-- CreateTable
CREATE TABLE "BillingUsage" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "draftsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingScheduledChange" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "fromPlan" TEXT NOT NULL,
    "toPlan" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "BillingScheduledChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingShopFlag" (
    "shop" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "installDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingShopFlag_pkey" PRIMARY KEY ("shop")
);

-- CreateIndex
CREATE INDEX "BillingUsage_shop_idx" ON "BillingUsage"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "BillingUsage_shop_periodStart_key" ON "BillingUsage"("shop", "periodStart");

-- CreateIndex
CREATE INDEX "BillingScheduledChange_shop_idx" ON "BillingScheduledChange"("shop");

-- CreateIndex
CREATE INDEX "BillingScheduledChange_effectiveAt_appliedAt_idx" ON "BillingScheduledChange"("effectiveAt", "appliedAt");
