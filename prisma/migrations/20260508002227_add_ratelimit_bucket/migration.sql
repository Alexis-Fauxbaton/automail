-- Sliding-window rate-limit bucket. (key, kind) is the composite primary key.
CREATE TABLE IF NOT EXISTS "RateLimitBucket" (
  "key"         TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "count"       INTEGER NOT NULL DEFAULT 0,
  "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key", "kind")
);

CREATE INDEX IF NOT EXISTS "RateLimitBucket_windowStart_idx" ON "RateLimitBucket" ("windowStart");
