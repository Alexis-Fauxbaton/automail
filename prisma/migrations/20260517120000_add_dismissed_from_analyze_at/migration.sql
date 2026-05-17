-- Add Thread.dismissedFromAnalyzeAt for the "À analyser" tab feature.
-- See spec: merchants can dismiss the to-analyze queue without touching
-- billing or operational state.
ALTER TABLE "Thread"
  ADD COLUMN "dismissedFromAnalyzeAt" TIMESTAMP(3);
