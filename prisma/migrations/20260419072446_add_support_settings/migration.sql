-- CreateTable
CREATE TABLE "SupportSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "signatureName" TEXT NOT NULL DEFAULT 'Customer Support',
    "brandName" TEXT NOT NULL DEFAULT '',
    "tone" TEXT NOT NULL DEFAULT 'friendly',
    "language" TEXT NOT NULL DEFAULT 'auto',
    "closingPhrase" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);
