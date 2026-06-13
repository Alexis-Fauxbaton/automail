-- Lower the auto-sync cadence default from 5 min to 1 min.
-- Now that the app runs on a persistent (non-spin-down) instance, the
-- background loop ticks reliably every 60s, so a 1-minute interval is the
-- natural floor (TICK_MS = 60s) and is cheap on every provider's API quota.

-- New default for future connections.
ALTER TABLE "MailConnection" ALTER COLUMN "autoSyncIntervalMinutes" SET DEFAULT 1;

-- Backfill existing connections that were still on the old default. We scope
-- to `= 5` so any deliberately customised value (set directly in the DB) is
-- left untouched — there is no merchant-facing editor for this column yet.
UPDATE "MailConnection" SET "autoSyncIntervalMinutes" = 1 WHERE "autoSyncIntervalMinutes" = 5;
