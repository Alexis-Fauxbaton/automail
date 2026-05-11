-- GDPR tombstone fields on Thread.
-- When a customer requests deletion, all PII columns on Thread are NULLed
-- and child messages/drafts are deleted, but the Thread row itself is
-- kept (with redactedAt set) so the merchant inbox shows a placeholder
-- instead of a missing thread.
ALTER TABLE "Thread"
  ADD COLUMN "redactedAt"     TIMESTAMP(3),
  ADD COLUMN "redactedReason" TEXT;

CREATE INDEX "Thread_shop_redactedAt_idx" ON "Thread" ("shop", "redactedAt");
