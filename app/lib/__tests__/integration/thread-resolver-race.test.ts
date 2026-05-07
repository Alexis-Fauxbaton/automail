// Integration test for the resolveCanonicalThread race condition.
//
// When two concurrent ingestions hit resolveCanonicalThread for the same
// (shop, provider, providerThreadId) — typical case: a Promise.allSettled
// batch in the sync pipeline processing several messages of the same Zoho
// thread — both can pass the "existing mapping" lookup and then both try
// the inner thread.create, racing on the @@unique([shop, provider,
// providerThreadId]) constraint of ThreadProviderId. The loser used to
// throw a P2002, which the sync caller turned into an orphan IncomingEmail
// row (empty subject/from, no canonicalThreadId, processingStatus="error").
//
// The function is documented as "All writes are idempotent: safe to call
// multiple times for the same message". This test enforces that contract
// under concurrency.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  testDb,
  cleanTestShop,
  disconnectTestDb,
  TEST_SHOP,
} from './helpers/db';
import { resolveCanonicalThread } from '../../mail/thread-resolver';

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('resolveCanonicalThread — concurrent ingestion of same providerThreadId', () => {
  it('two concurrent calls return the same canonicalThreadId without throwing', async () => {
    const input = {
      shop: TEST_SHOP,
      provider: 'zoho',
      providerThreadId: 'race-thread-001',
      subject: 'Re: support request',
      receivedAt: new Date(),
    };

    const [a, b] = await Promise.all([
      resolveCanonicalThread({ ...input, externalMessageId: 'race-msg-a' }),
      resolveCanonicalThread({ ...input, externalMessageId: 'race-msg-b' }),
    ]);

    expect(a.canonicalThreadId).toBe(b.canonicalThreadId);

    const threads = await testDb.thread.findMany({ where: { shop: TEST_SHOP } });
    expect(threads).toHaveLength(1);

    const mappings = await testDb.threadProviderId.findMany({ where: { shop: TEST_SHOP } });
    expect(mappings).toHaveLength(1);
    expect(mappings[0].providerThreadId).toBe('race-thread-001');
    expect(mappings[0].canonicalThreadId).toBe(a.canonicalThreadId);

    // One winner must report isNew=true; the loser must report isNew=false.
    const isNewFlags = [a.isNew, b.isNew].sort();
    expect(isNewFlags).toEqual([false, true]);
  });

  it('handles a high-fan-out batch (10 concurrent calls) without orphans', async () => {
    const input = {
      shop: TEST_SHOP,
      provider: 'gmail',
      providerThreadId: 'race-thread-fanout',
      subject: 'Re: order #1234',
      receivedAt: new Date(),
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        resolveCanonicalThread({ ...input, externalMessageId: `race-msg-${i}` }),
      ),
    );

    const ids = new Set(results.map((r) => r.canonicalThreadId));
    expect(ids.size).toBe(1);

    const threads = await testDb.thread.findMany({ where: { shop: TEST_SHOP } });
    expect(threads).toHaveLength(1);

    const mappings = await testDb.threadProviderId.findMany({ where: { shop: TEST_SHOP } });
    expect(mappings).toHaveLength(1);
  });
});
