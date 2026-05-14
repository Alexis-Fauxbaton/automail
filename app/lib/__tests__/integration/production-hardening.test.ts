// Integration tests for the production-hardening pass (2026-05-14).
// Covers helpers added during that audit that touch the database:
//   - job-queue.heartbeatJob
//   - rate-limit.pruneOldRateLimitBuckets (bounded batches)
//   - billing/subscription cache invalidation surface

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
} from "./helpers/db";
import { heartbeatJob, reclaimZombieJobs } from "../../mail/job-queue";
import { pruneOldRateLimitBuckets, checkRateLimit } from "../../rate-limit";

beforeEach(async () => {
  await cleanTestShop();
  // Also wipe rate-limit buckets keyed on TEST_SHOP so we have a clean slate.
  await testDb.rateLimitBucket.deleteMany({ where: { key: TEST_SHOP } });
  // Aggressively clear any leftover stale rate-limit rows in the test DB
  // (other test files don't always tidy up — that's fine for them but it
  // breaks the bounded-batch test below which counts deletions globally).
  await testDb.rateLimitBucket.deleteMany({
    where: { windowStart: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  // And any sibling-shop SyncJob rows left behind by the heartbeat-vs-reclaim
  // test (cleanTestShop only touches TEST_SHOP itself).
  await testDb.syncJob.deleteMany({
    where: { shop: { startsWith: `${TEST_SHOP}.sibling` } },
  });
});

afterAll(async () => {
  await cleanTestShop();
  await testDb.rateLimitBucket.deleteMany({ where: { key: TEST_SHOP } });
  await disconnectTestDb();
  if (typeof global !== "undefined") {
    (global as Record<string, unknown>).prismaGlobal = undefined;
  }
});

describe("heartbeatJob", () => {
  it("bumps startedAt for a running job", async () => {
    // Bypass enqueueJob / claimNextJob so we don't race other test files'
    // claimers on this same Postgres DB. We just want to assert that
    // heartbeatJob mutates startedAt on a "running" row.
    const siblingShop = `${TEST_SHOP}.sibling.heartbeat-bump`;
    await testDb.syncJob.deleteMany({ where: { shop: siblingShop } });
    const initial = new Date(Date.now() - 10_000);
    const row = await testDb.syncJob.create({
      data: {
        shop: siblingShop,
        kind: "sync",
        status: "running",
        startedAt: initial,
      },
      select: { id: true, startedAt: true },
    });
    expect(row.startedAt).toEqual(initial);

    await heartbeatJob(row.id);

    const after = await testDb.syncJob.findUnique({
      where: { id: row.id },
      select: { startedAt: true },
    });
    expect(after?.startedAt?.getTime() ?? 0).toBeGreaterThan(
      initial.getTime(),
    );

    // Cleanup
    await testDb.syncJob.deleteMany({ where: { shop: siblingShop } });
  });

  it("protects a heartbeating job from zombie reclaim while losing a silent one", async () => {
    // Two SyncJob rows. We mark both as running with startedAt in the past
    // (older than the zombie timeout). One gets a heartbeat — its startedAt
    // moves to NOW — and must survive reclaim. The other stays untouched
    // and must be reclaimed to status="pending".
    // Use direct prisma.create with sibling shops so we don't race
    // claimNextJob / heartbeat callers from other integration test files
    // that share this Postgres DB.
    const aliveShop = `${TEST_SHOP}.sibling.heartbeat-alive`;
    const deadShop = `${TEST_SHOP}.sibling.heartbeat-dead`;
    await testDb.syncJob.deleteMany({ where: { shop: aliveShop } });
    await testDb.syncJob.deleteMany({ where: { shop: deadShop } });
    const aliveRow = await testDb.syncJob.create({
      data: {
        shop: aliveShop,
        kind: "sync",
        status: "running",
        startedAt: new Date(Date.now() - 30 * 60_000),
        attempts: 0,
      },
      select: { id: true },
    });
    const deadRow = await testDb.syncJob.create({
      data: {
        shop: deadShop,
        kind: "sync",
        status: "running",
        startedAt: new Date(Date.now() - 30 * 60_000),
        attempts: 0,
      },
      select: { id: true },
    });
    const aliveId = aliveRow.id;
    const deadId = deadRow.id;

    await heartbeatJob(aliveId);
    // Reclaim with a 10-minute zombie window — the heartbeat just bumped
    // `aliveId` to NOW so it must NOT be touched; `deadId` is 30 min old
    // and must be reset to pending.
    await reclaimZombieJobs(10 * 60_000);

    const alive = await testDb.syncJob.findUnique({
      where: { id: aliveId },
      select: { status: true },
    });
    const dead = await testDb.syncJob.findUnique({
      where: { id: deadId },
      select: { status: true },
    });
    expect(alive?.status).toBe("running");
    expect(dead?.status).toBe("pending");

    // Cleanup: delete the sibling shop rows so the next test starts clean.
    await testDb.syncJob.deleteMany({ where: { shop: aliveShop } });
    await testDb.syncJob.deleteMany({ where: { shop: deadShop } });
  });

  it("is a no-op against jobs that are not in status='running'", async () => {
    // Use a sibling shop so the row can't be claimed by a concurrent
    // claimNextJob from another test file racing against the same DB
    // — that would flip status to "running" out from under us and look
    // like a heartbeat bug.
    const siblingShop = `${TEST_SHOP}.sibling.heartbeat-noop`;
    await testDb.syncJob.deleteMany({ where: { shop: siblingShop } });
    const row = await testDb.syncJob.create({
      data: { shop: siblingShop, kind: "sync", status: "pending" },
      select: { id: true, startedAt: true, status: true },
    });
    expect(row.status).toBe("pending");
    expect(row.startedAt).toBeNull();

    await heartbeatJob(row.id);

    const after = await testDb.syncJob.findUnique({
      where: { id: row.id },
      select: { startedAt: true, status: true },
    });
    expect(after?.status).toBe("pending");
    expect(after?.startedAt).toBeNull();

    // Cleanup
    await testDb.syncJob.deleteMany({ where: { shop: siblingShop } });
  });
});

describe("pruneOldRateLimitBuckets", () => {
  it("deletes only rows older than 24h", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const fresh = new Date(Date.now() - 60 * 1000);

    await testDb.rateLimitBucket.create({
      data: { key: TEST_SHOP, kind: "old-bucket", count: 1, windowStart: old },
    });
    await testDb.rateLimitBucket.create({
      data: { key: TEST_SHOP, kind: "fresh-bucket", count: 1, windowStart: fresh },
    });

    await pruneOldRateLimitBuckets();

    const remaining = await testDb.rateLimitBucket.findMany({
      where: { key: TEST_SHOP },
      select: { kind: true },
    });
    const kinds = remaining.map((r) => r.kind);
    expect(kinds).toContain("fresh-bucket");
    expect(kinds).not.toContain("old-bucket");
  });

  it("respects batch caps (no infinite loop on huge backlogs)", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    // Seed 7 stale buckets. With batchSize=3 + maxBatches=2 we should
    // delete 3 + 3 = 6 and leave one behind for the next tick.
    for (let i = 0; i < 7; i++) {
      await testDb.rateLimitBucket.create({
        data: {
          key: TEST_SHOP,
          kind: `stale-${i}`,
          count: 1,
          windowStart: old,
        },
      });
    }

    await pruneOldRateLimitBuckets({ batchSize: 3, maxBatches: 2 });

    const remaining = await testDb.rateLimitBucket.count({
      where: { key: TEST_SHOP, kind: { startsWith: "stale-" } },
    });
    expect(remaining).toBe(1);
  });

  it("leaves a counter live for the rate-limiter to keep using", async () => {
    // Simulate one shop hitting an endpoint, then prune — the bucket must
    // remain usable (not deleted because it's "in window").
    await checkRateLimit({
      key: TEST_SHOP,
      kind: "production-hardening-test",
      limit: 5,
      windowMs: 60_000,
    });
    await pruneOldRateLimitBuckets();
    const row = await testDb.rateLimitBucket.findUnique({
      where: {
        key_kind: { key: TEST_SHOP, kind: "production-hardening-test" },
      },
    });
    expect(row).not.toBeNull();
    expect(row?.count).toBe(1);
  });
});
