-- This migration is a duplicate of 20260502124332_add_llmcalllog_shop_index.
-- Kept in history for environments that already recorded it; rewritten as a
-- no-op (CREATE INDEX IF NOT EXISTS) so fresh databases that ran the earlier
-- migration don't fail with "relation already exists".
CREATE INDEX IF NOT EXISTS "LlmCallLog_shop_idx" ON "LlmCallLog"("shop");
