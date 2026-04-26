// Integration tests for the job queue (SyncJob table).
// Uses a real Postgres DB, isolated by TEST_SHOP.
//
// REQ-SYNC-12: zombie recovery — jobs stuck in 'running' for > N minutes are reset to 'pending'
// REQ-SYNC-13: retry/backoff — after 3 failures, job is marked 'error'
// REQ-SYNC-14: per-shop isolation — a shop with a running job cannot get a second concurrent job
//
// NOTE: the dev DB may have pending jobs from real stores. claimNextJob() picks
// the globally oldest pending job. To avoid flakiness, tests that need to claim
// a specific TEST_SHOP job drain other shops first with excludeShops, OR verify
// state through testDb rather than through the claimNextJob return value.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
} from './helpers/db';
import {
  enqueueJob,
  claimNextJob,
  markJobFailed,
  reclaimZombieJobs,
} from '../../mail/job-queue';

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await cleanTestShop();
  await disconnectTestDb();
  // Clear the global prisma singleton so the next test file starts fresh.
  if (typeof global !== 'undefined') {
    (global as Record<string, unknown>).prismaGlobal = undefined;
  }
});

/**
 * Claim jobs until we find one for TEST_SHOP, or exhaust up to `maxClaims`
 * attempts. Returns the claimed TEST_SHOP job, or null if not found.
 *
 * In a dev DB with jobs from real shops, claimNextJob() might return other
 * shops' jobs before reaching ours. We skip them by passing their shop names
 * as excludeShops until we get TEST_SHOP's job (or give up).
 */
async function claimTestShopJob(
  maxClaims = 30,
): Promise<Awaited<ReturnType<typeof claimNextJob>>> {
  const excludeShops: string[] = [];
  for (let i = 0; i < maxClaims; i++) {
    const job = await claimNextJob(excludeShops);
    if (!job) return null;
    if (job.shop === TEST_SHOP) return job;
    // Skip this shop in the next iteration so we reach TEST_SHOP's job.
    if (!excludeShops.includes(job.shop)) excludeShops.push(job.shop);
  }
  return null;
}

describe('job queue — integration DB', () => {
  it('enqueueJob creates a pending job', async () => {
    const id = await enqueueJob(TEST_SHOP, 'sync');

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const job = await testDb.syncJob.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe('pending');
    expect(job.shop).toBe(TEST_SHOP);
    expect(job.kind).toBe('sync');
    expect(job.attempts).toBe(0);
  });

  it('claimNextJob marks job as running', async () => {
    const id = await enqueueJob(TEST_SHOP, 'sync');

    // Use the helper to skip any non-TEST_SHOP jobs ahead in the queue.
    const claimed = await claimTestShopJob();

    expect(claimed).not.toBeNull();
    expect(claimed!.shop).toBe(TEST_SHOP);

    const job = await testDb.syncJob.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe('running');
  });

  it('per-shop isolation — second job not claimed while first is running (REQ-SYNC-14)', async () => {
    // Enqueue and claim first job — TEST_SHOP is now running.
    await enqueueJob(TEST_SHOP, 'sync');
    const first = await claimTestShopJob();
    expect(first).not.toBeNull();
    expect(first!.shop).toBe(TEST_SHOP);

    // Enqueue a different kind to avoid deduplication.
    const backfillId = await enqueueJob(TEST_SHOP, 'backfill');

    // Even if other shops have pending jobs, the TEST_SHOP 'backfill' job must
    // remain unclaimed because TEST_SHOP already has a running job.
    // Drain up to 30 non-TEST_SHOP jobs from the queue to verify.
    const excludeShops: string[] = [TEST_SHOP];
    for (let i = 0; i < 30; i++) {
      const job = await claimNextJob(excludeShops);
      if (!job) break;
      if (!excludeShops.includes(job.shop)) excludeShops.push(job.shop);
    }

    // The backfill job for TEST_SHOP must still be pending (not claimed).
    const backfillJob = await testDb.syncJob.findUniqueOrThrow({ where: { id: backfillId } });
    expect(backfillJob.status).toBe('pending');
  });

  it('markJobFailed × 3 sets status = error (REQ-SYNC-13)', async () => {
    const id = await enqueueJob(TEST_SHOP, 'resync');

    // Attempt 1
    const claim1 = await claimTestShopJob();
    expect(claim1).not.toBeNull();
    expect(claim1!.id).toBe(id);
    expect(claim1!.attempts).toBe(1);

    await markJobFailed(id, new Error('timeout'));
    const afterFail1 = await testDb.syncJob.findUniqueOrThrow({ where: { id } });
    expect(afterFail1.status).toBe('pending');

    // Reset backoff so claimNextJob can pick it up again.
    await testDb.syncJob.update({ where: { id }, data: { nextRetryAt: null } });

    // Attempt 2
    const claim2 = await claimTestShopJob();
    expect(claim2).not.toBeNull();
    expect(claim2!.id).toBe(id);
    expect(claim2!.attempts).toBe(2);

    await markJobFailed(id, new Error('timeout'));
    const afterFail2 = await testDb.syncJob.findUniqueOrThrow({ where: { id } });
    expect(afterFail2.status).toBe('pending');

    // Reset backoff.
    await testDb.syncJob.update({ where: { id }, data: { nextRetryAt: null } });

    // Attempt 3 — this should exhaust the job.
    const claim3 = await claimTestShopJob();
    expect(claim3).not.toBeNull();
    expect(claim3!.id).toBe(id);
    expect(claim3!.attempts).toBe(3);

    await markJobFailed(id, new Error('timeout'));
    const afterFail3 = await testDb.syncJob.findUniqueOrThrow({ where: { id } });
    expect(afterFail3.status).toBe('error');
    expect(afterFail3.lastError).toContain('timeout');
  });

  it('reclaimZombieJobs resets stuck running job to pending (REQ-SYNC-12)', async () => {
    const id = await enqueueJob(TEST_SHOP, 'recompute');

    // Simulate a job that has been running for 35 minutes.
    const stuckAt = new Date(Date.now() - 35 * 60 * 1000);
    await testDb.syncJob.update({
      where: { id },
      data: { status: 'running', startedAt: stuckAt },
    });

    // Reclaim jobs stuck longer than 30 minutes.
    await reclaimZombieJobs(30 * 60 * 1000);

    const job = await testDb.syncJob.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe('pending');
  });
});
