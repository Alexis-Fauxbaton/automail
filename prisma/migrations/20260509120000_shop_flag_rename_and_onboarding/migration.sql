-- Rename table.
ALTER TABLE "BillingShopFlag" RENAME TO "ShopFlag";

-- Add new nullable columns.
ALTER TABLE "ShopFlag" ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);
ALTER TABLE "ShopFlag" ADD COLUMN "checklistDismissedAt" TIMESTAMP(3);

-- Backfill: shops that already have a MailConnection are considered onboarded
-- as of their install date.
UPDATE "ShopFlag"
SET "onboardingCompletedAt" = "installDate"
WHERE "shop" IN (SELECT "shop" FROM "MailConnection");
