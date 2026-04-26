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
    // Scenario: agent manually resolved a thread that had a prior incoming message.
    // A second call to recomputeThreadState must honour the manual resolve and NOT
    // re-open the thread, because the only incoming message is dated BEFORE the
    // resolution timestamp.
    const messageReceivedAt = new Date(Date.now() - 120_000); // 2 min ago
    const resolvedAt = new Date(Date.now() - 60_000);         // 1 min ago (after message)

    const thread = await createTestThread({
      operationalState: 'resolved',
      previousOperationalState: 'waiting_merchant',
      operationalStateUpdatedAt: resolvedAt,
    });

    // Insert the pre-existing message (received BEFORE the manual resolve).
    await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: 'msg-preresolve-001',
        canonicalThreadId: thread.id,
        fromAddress: 'client@example.com',
        subject: 'Question',
        bodyText: 'Où est ma commande ?',
        receivedAt: messageReceivedAt,
        processingStatus: 'pending',
        tier1Result: 'passed',
        tier2Result: 'support_client',
      },
    });

    // Recompute — the guard must detect no new message after resolvedAt and preserve
    // the resolved state.
    await recomputeThreadState(thread.id, { mailboxAddress: 'shop@example.com' });

    const updated = await testDb.thread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(updated.operationalState).toBe('resolved');
    // previousOperationalState is kept (the early-return path does not clear it)
    expect(updated.previousOperationalState).toBe('waiting_merchant');
  });

  it('supportNature does not regress after merge — confirmed_support beats non_support (REQ-STATE-14)', async () => {
    // Thread already classified as confirmed_support in the DB.
    // A new incoming message arrives with tier2Result = 'probable_non_client'
    // (maps to non_support). The full pipeline (recomputeThreadState) must
    // apply the sticky rule and keep confirmed_support in the DB.
    const thread = await createTestThread({ supportNature: 'confirmed_support' });

    await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: 'msg-non-client-001',
        canonicalThreadId: thread.id,
        fromAddress: 'bot@spam.com',
        subject: 'Newsletter',
        bodyText: 'Ceci est un message non-client.',
        receivedAt: new Date(),
        processingStatus: 'pending',
        tier1Result: 'passed',
        tier2Result: 'probable_non_client',
      },
    });

    await recomputeThreadState(thread.id, { mailboxAddress: 'shop@example.com' });

    const updated = await testDb.thread.findUniqueOrThrow({ where: { id: thread.id } });
    // Sticky rule: confirmed_support must never be downgraded by non_support.
    expect(updated.supportNature).toBe('confirmed_support');
  });
});
