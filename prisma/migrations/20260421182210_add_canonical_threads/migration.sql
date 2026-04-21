-- AlterTable
ALTER TABLE "IncomingEmail" ADD COLUMN     "canonicalThreadId" TEXT,
ADD COLUMN     "inReplyTo" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "rfcMessageId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "rfcReferences" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "lastMessageId" TEXT,
    "firstMessageAt" TIMESTAMP(3) NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "subjectKey" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreadProviderId" (
    "id" TEXT NOT NULL,
    "canonicalThreadId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerThreadId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadProviderId_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Thread_shop_lastMessageAt_idx" ON "Thread"("shop", "lastMessageAt");

-- CreateIndex
CREATE INDEX "ThreadProviderId_canonicalThreadId_idx" ON "ThreadProviderId"("canonicalThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadProviderId_shop_provider_providerThreadId_key" ON "ThreadProviderId"("shop", "provider", "providerThreadId");

-- CreateIndex
CREATE INDEX "IncomingEmail_canonicalThreadId_receivedAt_idx" ON "IncomingEmail"("canonicalThreadId", "receivedAt");

-- CreateIndex
CREATE INDEX "IncomingEmail_shop_rfcMessageId_idx" ON "IncomingEmail"("shop", "rfcMessageId");

-- AddForeignKey
ALTER TABLE "ThreadProviderId" ADD CONSTRAINT "ThreadProviderId_canonicalThreadId_fkey" FOREIGN KEY ("canonicalThreadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomingEmail" ADD CONSTRAINT "IncomingEmail_canonicalThreadId_fkey" FOREIGN KEY ("canonicalThreadId") REFERENCES "Thread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill: derive canonical threads from existing IncomingEmail rows.
-- Strategy: one Thread per (shop, threadId). Rows with an empty threadId
-- become singleton threads keyed off the email id. Provider is inferred
-- from MailConnection; defaults to 'gmail' for legacy rows whose shop no
-- longer has a connection. Advanced merges (e.g. Zoho splits sharing the
-- same externalMessageId across threadIds) are deferred to the runtime
-- resolver on next ingestion.
-- ---------------------------------------------------------------------------

-- 1. Create one Thread row per logical group.
INSERT INTO "Thread" (
  "id", "shop", "provider",
  "firstMessageAt", "lastMessageAt", "lastMessageId",
  "messageCount", "subjectKey",
  "createdAt", "updatedAt"
)
SELECT
  'thr_' || md5(e."shop" || '|' || CASE WHEN e."threadId" = '' THEN e."id" ELSE e."threadId" END) AS id,
  e."shop",
  COALESCE(
    (SELECT mc."provider" FROM "MailConnection" mc WHERE mc."shop" = e."shop"),
    'gmail'
  ) AS provider,
  MIN(e."receivedAt") AS first_at,
  MAX(e."receivedAt") AS last_at,
  NULL::text AS last_message_id,
  COUNT(*)::int AS msg_count,
  LOWER(TRIM(REGEXP_REPLACE(
    (ARRAY_AGG(e."subject" ORDER BY e."receivedAt" ASC))[1],
    '^(re:|fwd:|fw:)\s*', '', 'gi'
  ))) AS subject_key,
  MIN(e."createdAt") AS created_at,
  MAX(e."updatedAt") AS updated_at
FROM "IncomingEmail" e
GROUP BY e."shop", CASE WHEN e."threadId" = '' THEN e."id" ELSE e."threadId" END;

-- 2. Link every existing email to its canonical Thread.
UPDATE "IncomingEmail" e
SET "canonicalThreadId" = 'thr_' || md5(e."shop" || '|' || CASE WHEN e."threadId" = '' THEN e."id" ELSE e."threadId" END);

-- 3. Cache the true-latest message id on each Thread.
UPDATE "Thread" t
SET "lastMessageId" = sub.id
FROM (
  SELECT DISTINCT ON (e."canonicalThreadId")
    e."canonicalThreadId" AS cid,
    e."id"
  FROM "IncomingEmail" e
  WHERE e."canonicalThreadId" IS NOT NULL
  ORDER BY e."canonicalThreadId", e."receivedAt" DESC, e."createdAt" DESC
) sub
WHERE t."id" = sub.cid;

-- 4. Populate ThreadProviderId mappings (one row per distinct provider threadId).
INSERT INTO "ThreadProviderId" ("id", "canonicalThreadId", "shop", "provider", "providerThreadId", "createdAt")
SELECT DISTINCT ON (t."shop", t."provider", COALESCE(NULLIF(e."threadId", ''), e."id"))
  'tpi_' || md5(t."id" || '|' || t."provider" || '|' || COALESCE(NULLIF(e."threadId", ''), e."id")),
  t."id",
  t."shop",
  t."provider",
  COALESCE(NULLIF(e."threadId", ''), e."id"),
  NOW()
FROM "Thread" t
JOIN "IncomingEmail" e ON e."canonicalThreadId" = t."id"
ON CONFLICT ("shop", "provider", "providerThreadId") DO NOTHING;
