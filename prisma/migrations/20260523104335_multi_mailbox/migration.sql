BEGIN;

-- 1. MailConnection: add id while keeping the old PK temporarily
ALTER TABLE "MailConnection" ADD COLUMN "id" TEXT;
UPDATE "MailConnection" SET "id" = 'mc_' || substr(md5(random()::text || shop), 1, 24);
ALTER TABLE "MailConnection" ALTER COLUMN "id" SET NOT NULL;

-- 2. Add mailConnectionId nullable on dependent tables
ALTER TABLE "Thread" ADD COLUMN "mailConnectionId" TEXT;
ALTER TABLE "IncomingEmail" ADD COLUMN "mailConnectionId" TEXT;
ALTER TABLE "SyncJob" ADD COLUMN "mailConnectionId" TEXT;

-- 3a. Delete orphans: rows whose shop no longer has a MailConnection.
-- These are the ARCH-C2 leftovers (mailbox disconnected, dependent rows kept).
-- They can never be re-synced anyway, and they'd cause the post-backfill guard
-- to fail. Order matters: child tables before parents.
DELETE FROM "IncomingEmail" e
  WHERE NOT EXISTS (SELECT 1 FROM "MailConnection" mc WHERE mc.shop = e.shop);
DELETE FROM "Thread" t
  WHERE NOT EXISTS (SELECT 1 FROM "MailConnection" mc WHERE mc.shop = t.shop);
DELETE FROM "SyncJob" j
  WHERE j.kind NOT IN ('recompute', 'reclassify')
    AND NOT EXISTS (SELECT 1 FROM "MailConnection" mc WHERE mc.shop = j.shop);

-- 3b. Backfill (each shop has at most one MailConnection at this point)
UPDATE "Thread" t
  SET "mailConnectionId" = (SELECT mc."id" FROM "MailConnection" mc WHERE mc.shop = t.shop);
UPDATE "IncomingEmail" e
  SET "mailConnectionId" = (SELECT mc."id" FROM "MailConnection" mc WHERE mc.shop = e.shop);
UPDATE "SyncJob" j
  SET "mailConnectionId" = (SELECT mc."id" FROM "MailConnection" mc WHERE mc.shop = j.shop)
  WHERE j.kind NOT IN ('recompute', 'reclassify');

-- 4. Guard against orphans
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Thread" WHERE "mailConnectionId" IS NULL) THEN
    RAISE EXCEPTION 'Orphan Thread rows after backfill';
  END IF;
  IF EXISTS (SELECT 1 FROM "IncomingEmail" WHERE "mailConnectionId" IS NULL) THEN
    RAISE EXCEPTION 'Orphan IncomingEmail rows after backfill';
  END IF;
END $$;

-- 5. Swap MailConnection PK
ALTER TABLE "MailConnection" DROP CONSTRAINT "MailConnection_pkey";
ALTER TABLE "MailConnection" ADD CONSTRAINT "MailConnection_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX "MailConnection_shop_email_key" ON "MailConnection"("shop", "email");
CREATE INDEX "MailConnection_shop_idx" ON "MailConnection"("shop");

-- 6. Tighten constraints + cascade
ALTER TABLE "Thread" ALTER COLUMN "mailConnectionId" SET NOT NULL;
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_mailConnectionId_fkey"
  FOREIGN KEY ("mailConnectionId") REFERENCES "MailConnection"("id") ON DELETE CASCADE;
ALTER TABLE "IncomingEmail" ALTER COLUMN "mailConnectionId" SET NOT NULL;
ALTER TABLE "IncomingEmail" ADD CONSTRAINT "IncomingEmail_mailConnectionId_fkey"
  FOREIGN KEY ("mailConnectionId") REFERENCES "MailConnection"("id") ON DELETE CASCADE;
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_mailConnectionId_fkey"
  FOREIGN KEY ("mailConnectionId") REFERENCES "MailConnection"("id") ON DELETE CASCADE;

CREATE INDEX "Thread_mailConnectionId_idx" ON "Thread"("mailConnectionId");
CREATE INDEX "IncomingEmail_mailConnectionId_idx" ON "IncomingEmail"("mailConnectionId");
CREATE INDEX "SyncJob_mailConnectionId_idx" ON "SyncJob"("mailConnectionId");

COMMIT;
