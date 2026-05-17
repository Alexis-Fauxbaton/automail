-- H-7: enforce "at most one running SyncJob per shop" at the database level.
--
-- The application logic in claimNextJob already filters candidates by
-- `shop NOT IN (SELECT shop FROM SyncJob WHERE status='running')`, but
-- that subquery evaluates BEFORE the row lock is acquired, leaving a
-- millisecond race where two workers can both claim a job for the same
-- shop. A partial unique index closes the race: the second UPDATE that
-- would set status='running' for an already-running shop fails with
-- P2002, and the application catches it and re-claims.
--
-- Prisma schema language can't express partial unique indexes (as of
-- 2026-05), so we manage this index by hand. Schema introspection will
-- show a drift — acceptable, documented here.

CREATE UNIQUE INDEX IF NOT EXISTS "SyncJob_one_running_per_shop"
  ON "SyncJob"("shop")
  WHERE status = 'running';
