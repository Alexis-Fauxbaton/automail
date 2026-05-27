// Integration tests for new dashboard stats queries.
// Uses a real Postgres DB, isolated by TEST_SHOP.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  testDb,
  cleanTestShop,
  createTestThread,
  disconnectTestDb,
  TEST_SHOP,
} from './helpers/db';
import {
  getPeriodBounds,
  getResponseTimeStats,
  getDraftUsageStats,
} from '../../dashboard-stats';

const NOW = new Date('2026-04-26T12:00:00Z');

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('getPeriodBounds', () => {
  it('calcule les bornes sur 30j par défaut', () => {
    const { start, end } = getPeriodBounds('30d', undefined, undefined, NOW);
    expect(end.toISOString()).toBe(NOW.toISOString());
    const diff = end.getTime() - start.getTime();
    expect(diff).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('getResponseTimeStats', () => {
  it('calcule le médian pour un thread avec une réponse sortante (REQ-DASH-RT-01)', async () => {
    const { start, end, prevStart, prevEnd } = getPeriodBounds('7d', undefined, undefined, NOW);

    const thread = await createTestThread({
      supportNature: 'confirmed_support',
      firstMessageAt: new Date('2026-04-22T08:00:00Z'),
    });

    // Incoming customer message
    await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        mailConnectionId: thread.mailConnectionId,
        externalMessageId: 'rt-in-1',
        canonicalThreadId: thread.id,
        fromAddress: 'customer@example.com',
        subject: 'Help',
        bodyText: 'I need help',
        receivedAt: new Date('2026-04-22T08:00:00Z'),
        processingStatus: 'analyzed',
      },
    });

    // Merchant reply 2 hours later
    await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        mailConnectionId: thread.mailConnectionId,
        externalMessageId: 'rt-out-1',
        canonicalThreadId: thread.id,
        fromAddress: 'shop@example.com',
        subject: 'Re: Help',
        bodyText: 'Here is help',
        receivedAt: new Date('2026-04-22T10:00:00Z'),
        processingStatus: 'outgoing',
      },
    });

    const stats = await getResponseTimeStats(TEST_SHOP, start, end, prevStart, prevEnd);

    // 2 hours = 7_200_000 ms
    expect(stats.medianMs).toBe(7_200_000);
    expect(stats.p90Ms).toBe(7_200_000); // single value, same at all percentiles
  });

  it('retourne null quand aucun thread qualifié (REQ-DASH-RT-02)', async () => {
    const { start, end, prevStart, prevEnd } = getPeriodBounds('7d', undefined, undefined, NOW);

    const stats = await getResponseTimeStats(TEST_SHOP, start, end, prevStart, prevEnd);

    expect(stats.medianMs).toBeNull();
    expect(stats.p90Ms).toBeNull();
    expect(stats.prevMedianMs).toBeNull();
  });

  it('exclut les threads où le marchand a envoyé en premier (REQ-DASH-RT-03)', async () => {
    const { start, end, prevStart, prevEnd } = getPeriodBounds('7d', undefined, undefined, NOW);

    const thread = await createTestThread({
      supportNature: 'confirmed_support',
      firstMessageAt: new Date('2026-04-22T08:00:00Z'),
    });

    // Merchant initiates (outgoing first)
    await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        mailConnectionId: thread.mailConnectionId,
        externalMessageId: 'merchant-first',
        canonicalThreadId: thread.id,
        fromAddress: 'shop@example.com',
        subject: 'Following up',
        bodyText: 'Just checking in',
        receivedAt: new Date('2026-04-22T08:00:00Z'),
        processingStatus: 'outgoing',
      },
    });

    const stats = await getResponseTimeStats(TEST_SHOP, start, end, prevStart, prevEnd);

    // Thread excluded because merchant went first
    expect(stats.medianMs).toBeNull();
  });
});

describe('getDraftUsageStats', () => {
  it('calcule le % de drafts utilisés depuis les buckets (REQ-DASH-DR-01)', async () => {
    const { start, end, prevStart, prevEnd } = getPeriodBounds('7d', undefined, undefined, NOW);

    const thread = await createTestThread();

    // Each ReplyDraft needs its own IncomingEmail (emailId is @unique)
    const email1 = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        mailConnectionId: thread.mailConnectionId,
        externalMessageId: 'draft-email-1',
        canonicalThreadId: thread.id,
        fromAddress: 'c@example.com',
        subject: 'S',
        bodyText: 'B',
        receivedAt: new Date('2026-04-22T08:00:00Z'),
        processingStatus: 'analyzed',
      },
    });

    const email2 = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        mailConnectionId: thread.mailConnectionId,
        externalMessageId: 'draft-email-2',
        canonicalThreadId: thread.id,
        fromAddress: 'c@example.com',
        subject: 'S2',
        bodyText: 'B2',
        receivedAt: new Date('2026-04-22T08:01:00Z'),
        processingStatus: 'analyzed',
      },
    });

    const email3 = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        mailConnectionId: thread.mailConnectionId,
        externalMessageId: 'draft-email-3',
        canonicalThreadId: thread.id,
        fromAddress: 'c@example.com',
        subject: 'S3',
        bodyText: 'B3',
        receivedAt: new Date('2026-04-22T08:02:00Z'),
        processingStatus: 'analyzed',
      },
    });

    // 1 as_is + 1 edited + 1 ignored = 3 classified, sentPct = 67%
    await testDb.replyDraft.create({
      data: {
        shop: TEST_SHOP,
        emailId: email1.id,
        heuristicBucket: 'as_is',
        heuristicComputedAt: new Date(),
        createdAt: new Date('2026-04-22T09:00:00Z'),
      },
    });

    await testDb.replyDraft.create({
      data: {
        shop: TEST_SHOP,
        emailId: email2.id,
        heuristicBucket: 'edited',
        heuristicComputedAt: new Date(),
        createdAt: new Date('2026-04-23T09:00:00Z'),
      },
    });

    await testDb.replyDraft.create({
      data: {
        shop: TEST_SHOP,
        emailId: email3.id,
        heuristicBucket: 'ignored',
        heuristicComputedAt: new Date(),
        createdAt: new Date('2026-04-24T09:00:00Z'),
      },
    });

    const stats = await getDraftUsageStats(TEST_SHOP, start, end, prevStart, prevEnd);

    expect(stats.asIs).toBe(1);
    expect(stats.edited).toBe(1);
    expect(stats.ignored).toBe(1);
    expect(stats.pending).toBe(0);
    expect(stats.sentPct).toBe(67); // round((1+1)/3 * 100)
  });

  it('retourne sentPct null quand aucun draft classifié (REQ-DASH-DR-02)', async () => {
    const { start, end, prevStart, prevEnd } = getPeriodBounds('7d', undefined, undefined, NOW);

    const stats = await getDraftUsageStats(TEST_SHOP, start, end, prevStart, prevEnd);

    expect(stats.sentPct).toBeNull();
    expect(stats.asIs).toBe(0);
    expect(stats.edited).toBe(0);
    expect(stats.ignored).toBe(0);
  });

  it('compte les drafts pending séparément (REQ-DASH-DR-03)', async () => {
    const { start, end, prevStart, prevEnd } = getPeriodBounds('7d', undefined, undefined, NOW);

    const thread = await createTestThread();

    const email1 = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        mailConnectionId: thread.mailConnectionId,
        externalMessageId: 'pending-email-1',
        canonicalThreadId: thread.id,
        fromAddress: 'c@example.com',
        subject: 'S',
        bodyText: 'B',
        receivedAt: new Date('2026-04-22T08:00:00Z'),
        processingStatus: 'analyzed',
      },
    });

    const email2 = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        mailConnectionId: thread.mailConnectionId,
        externalMessageId: 'pending-email-2',
        canonicalThreadId: thread.id,
        fromAddress: 'c@example.com',
        subject: 'S2',
        bodyText: 'B2',
        receivedAt: new Date('2026-04-22T08:01:00Z'),
        processingStatus: 'analyzed',
      },
    });

    // 2 pending drafts (heuristicBucket = null)
    await testDb.replyDraft.create({
      data: {
        shop: TEST_SHOP,
        emailId: email1.id,
        heuristicBucket: null,
        createdAt: new Date('2026-04-22T09:00:00Z'),
      },
    });

    await testDb.replyDraft.create({
      data: {
        shop: TEST_SHOP,
        emailId: email2.id,
        heuristicBucket: null,
        createdAt: new Date('2026-04-23T09:00:00Z'),
      },
    });

    const stats = await getDraftUsageStats(TEST_SHOP, start, end, prevStart, prevEnd);

    expect(stats.pending).toBe(2);
    expect(stats.sentPct).toBeNull(); // denom = 0 because no classified drafts
  });
});
