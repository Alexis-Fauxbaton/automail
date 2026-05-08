-- Snapshot of analysis.manualOverrides (intent + order picks the user
-- explicitly made) preserved across destructive resyncs. Captured by
-- handleResync before wiping IncomingEmail rows; consumed and cleared
-- by the next analysis pass on the thread.
ALTER TABLE "Thread" ADD COLUMN IF NOT EXISTS "preservedManualOverridesJson" TEXT;
