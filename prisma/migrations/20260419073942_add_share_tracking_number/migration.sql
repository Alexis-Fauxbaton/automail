-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SupportSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "signatureName" TEXT NOT NULL DEFAULT 'Customer Support',
    "brandName" TEXT NOT NULL DEFAULT '',
    "tone" TEXT NOT NULL DEFAULT 'friendly',
    "language" TEXT NOT NULL DEFAULT 'auto',
    "closingPhrase" TEXT NOT NULL DEFAULT '',
    "shareTrackingNumber" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SupportSettings" ("brandName", "closingPhrase", "language", "shop", "signatureName", "tone", "updatedAt") SELECT "brandName", "closingPhrase", "language", "shop", "signatureName", "tone", "updatedAt" FROM "SupportSettings";
DROP TABLE "SupportSettings";
ALTER TABLE "new_SupportSettings" RENAME TO "SupportSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
