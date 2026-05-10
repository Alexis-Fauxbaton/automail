-- Rename installDate to firstInstallDate to clarify that the column is the
-- immutable first-install anchor used for trial calculation, not the
-- "current install" timestamp. Behavior is unchanged — the column is still
-- never overwritten on reinstall.
ALTER TABLE "ShopFlag" RENAME COLUMN "installDate" TO "firstInstallDate";
