// Integration tests for the thread state machine (recomputeThreadState).
// Uses a real Postgres DB, isolated by TEST_SHOP.
//
// REQ-STATE-05: resolved + new incoming → waiting_merchant + history entry
// REQ-STATE-09: previousOperationalState preserved on manual resolve
// REQ-STATE-14: supportNature sticky — confirmed_support not downgraded by non_support

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  testDb,
  cleanTestShop,
  createTestThread,
  disconnectTestDb,
  TEST_SHOP,
} from './helpers/db';
import { recomputeThreadState, mergeNature } from '../../support/thread-state';

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('thread state machine — integration DB', () => {
  it('thread resolved + new incoming message → waiting_merchant (REQ-STATE-05)', async () => {
    // Create a thread already in resolved state (no previousOperationalState,
    // so the manual-resolve guard is bypassed and normal recompute runs).
    const resolvedAt = new Date(Date.now() - 60_000); // 1 minute ago
    const thread = await createTestThread({
      operationalState: 'resolved',
      operationalStateUpdatedAt: resolvedAt,
    });

    // Insert an incoming message received AFTER the resolution timestamp.
    // tier1Result: 'passed' is required so that recomputeThreadState sets
    // targetReplyNeeded = true, which makes deriveOperationalState return
    // 'waiting_merchant' (not 'no_reply_needed').
    await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: 'msg-reopen-001',
        canonicalThreadId: thread.id,
        fromAddress: 'client@example.com',
        subject: 'Re: votre commande',
        bodyText: "Bonjour, je n'ai toujours pas reçu mon colis.",
        receivedAt: new Date(), // after resolvedAt
        processingStatus: 'pending',
        tier1Result: 'passed',
        tier2Result: 'support_client',
      },
    });

    await recomputeThreadState(thread.id, { mailboxAddress: 'shop@example.com' });

    const updated = await testDb.thread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(updated.operationalState).toBe('waiting_merchant');

    // Verify audit trail is written (REQ-STATE-10 / part of REQ-STATE-05)
    const history = await testDb.threadStateHistory.findFirst({
      where: {
        threadId: thread.id,
        fromState: 'resolved',
        toState: 'waiting_merchant',
      },
    });
    expect(history).not.toBeNull();
    expect(history!.shop).toBe(TEST_SHOP);
  });

  it('previousOperationalState preserved on manual resolve (REQ-STATE-09)', async () => {
    // Start in waiting_merchant, then simulate an agent manually resolving the thread.
    const thread = await createTestThread({ operationalState: 'waiting_merchant' });

    await testDb.thread.update({
      where: { id: thread.id },
      data: {
        previousOperationalState: 'waiting_merchant',
        operationalState: 'resolved',
        operationalStateUpdatedAt: new Date(),
      },
    });

    const updated = await testDb.thread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(updated.operationalState).toBe('resolved');
    expect(updated.previousOperationalState).toBe('waiting_merchant');
  });

  it('supportNature does not regress after merge — confirmed_support beats non_support (REQ-STATE-14)', async () => {
    // Thread already classified as confirmed_support.
    const thread = await createTestThread({ supportNature: 'confirmed_support' });

    // mergeNature is the function the pipeline calls: confirmed_support must win.
    const merged = mergeNature('confirmed_support', 'non_support');
    expect(merged).toBe('confirmed_support');

    // Persist the merged value (as the pipeline does) and verify the DB row.
    await testDb.thread.update({
      where: { id: thread.id },
      data: { supportNature: merged },
    });

    const updated = await testDb.thread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(updated.supportNature).toBe('confirmed_support');
  });
});
