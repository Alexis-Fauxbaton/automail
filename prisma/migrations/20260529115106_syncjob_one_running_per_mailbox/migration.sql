-- Migrate SyncJob_one_running_per_shop partial unique index from per-shop
-- to per-mailbox enforcement.
--
-- Background: when the original "one running per shop" index was added
-- (20260517143242), the app was single-mailbox. After multi-mailbox shipped,
-- the application layer started using JOB_LOCK_GRANULARITY=mailbox semantics
-- with HARD_CAP_PER_SHOP=3 — but the DB-level index still blocked at the
-- shop level, making HARD_CAP_PER_SHOP effectively unreachable.
--
-- New invariant: at most one running SyncJob per (shop, mailConnectionId).
-- Shop-wide jobs (recompute, reclassify) have NULL mailConnectionId; we
-- exclude them from the unique constraint with an additional predicate.

DROP INDEX IF EXISTS "SyncJob_one_running_per_shop";

CREATE UNIQUE INDEX IF NOT EXISTS "SyncJob_one_running_per_mailbox"
  ON "SyncJob" ("shop", "mailConnectionId")
  WHERE status = 'running' AND "mailConnectionId" IS NOT NULL;
