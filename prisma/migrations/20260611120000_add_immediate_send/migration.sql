-- Add immediateSend to SupportSettings.
-- When true, the inbox « Envoyer » button sends in one click with no
-- countdown. Default false keeps the 5s safety countdown.
ALTER TABLE "SupportSettings" ADD COLUMN "immediateSend" BOOLEAN NOT NULL DEFAULT false;
