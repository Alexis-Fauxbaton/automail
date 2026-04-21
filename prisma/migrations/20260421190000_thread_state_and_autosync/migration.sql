-- Thread state (sticky nature + operational state + structured state)
ALTER TABLE "Thread"
  ADD COLUMN "supportNature"           TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "supportNatureUpdatedAt"  TIMESTAMP(3),
  ADD COLUMN "operationalState"        TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN "operationalStateUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "structuredState"         TEXT NOT NULL DEFAULT '{}',
  ADD COLUMN "summaryText"             TEXT,
  ADD COLUMN "summaryUpdatedAt"        TIMESTAMP(3),
  ADD COLUMN "historyStatus"           TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "oldestSyncedMessageAt"   TIMESTAMP(3),
  ADD COLUMN "backfillAttemptedAt"     TIMESTAMP(3);

CREATE INDEX "Thread_shop_supportNature_idx"      ON "Thread"("shop", "supportNature");
CREATE INDEX "Thread_shop_operationalState_idx"   ON "Thread"("shop", "operationalState");

-- Auto-sync (point 10) + onboarding backfill flag (point 11)
ALTER TABLE "MailConnection"
  ADD COLUMN "autoSyncEnabled"            BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "autoSyncIntervalMinutes"    INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "onboardingBackfillDoneAt"   TIMESTAMP(3),
  ADD COLUMN "onboardingBackfillDays"     INTEGER NOT NULL DEFAULT 60;

-- Backfill oldestSyncedMessageAt from existing data so history heuristics
-- have a sensible baseline on day one.
UPDATE "Thread" t SET "oldestSyncedMessageAt" = t."firstMessageAt";
