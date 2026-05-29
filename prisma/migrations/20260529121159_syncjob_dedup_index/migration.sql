-- Covering index for the enqueueJob dedup query
-- (`findFirst where: { shop, mailConnectionId, kind, status: pending|running }`).
-- Without it, the lookup falls back to the (shop, status) index and
-- filters mailConnectionId + kind in the heap — slow on shops with
-- hundreds of pending jobs.
CREATE INDEX IF NOT EXISTS "SyncJob_shop_mailConnectionId_kind_status_idx"
  ON "SyncJob" ("shop", "mailConnectionId", "kind", "status");
