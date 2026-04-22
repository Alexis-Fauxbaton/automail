-- Durable background job queue. Web actions enqueue rows; the
-- auto-sync loop claims and processes them. Jobs survive process
-- restarts, which fire-and-forget Promises do not.
CREATE TABLE "SyncJob" (
  "id"         TEXT NOT NULL,
  "shop"       TEXT NOT NULL,
  "kind"       TEXT NOT NULL,
  "params"     TEXT NOT NULL DEFAULT '{}',
  "status"     TEXT NOT NULL DEFAULT 'pending',
  "attempts"   INTEGER NOT NULL DEFAULT 0,
  "lastError"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"  TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SyncJob_shop_status_idx"   ON "SyncJob" ("shop", "status");
CREATE INDEX "SyncJob_status_createdAt_idx" ON "SyncJob" ("status", "createdAt");

-- Promote the analysis intent to a first-class column so
-- dashboards / rules / ad-hoc SQL don't have to JSON-parse
-- analysisResult. Populated alongside the JSON blob; nullable
-- until the next reanalyze for historical rows.
ALTER TABLE "IncomingEmail"
  ADD COLUMN "detectedIntent" TEXT;

CREATE INDEX "IncomingEmail_shop_detectedIntent_idx"
  ON "IncomingEmail" ("shop", "detectedIntent");
