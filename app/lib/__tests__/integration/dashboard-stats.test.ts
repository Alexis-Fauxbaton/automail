// Integration tests for dashboard stats queries.
// Uses a real Postgres DB, isolated by TEST_SHOP.
//
// REQ-DASH-01: totalEmails counts incoming emails in period
// REQ-DASH-06: getDailyBreakdown zero-fills days with no activity
// REQ-DASH-09: getConversationStats counts reopened threads
// REQ-DASH-13: empty period returns zeros without error

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
  getKpiStats,
  getDailyBreakdown,
  getConversationStats,
} from '../../dashboard-stats';

// Fixed reference point for all tests.
const NOW = new Date('2026-04-26T12:00:00Z');

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('dashboard-stats — queries KPI en intégration', () => {
  it('totalEmails compte les emails entrants de la période (REQ-DASH-01)', async () => {
    const { start, end, prevStart, prevEnd } = getPeriodBounds('7d', undefined, undefined, NOW);
    const thread = await createTestThread();

    // 3 emails inside the 7-day window, 1 outside (too old)
    await testDb.incomingEmail.createMany({
      data: [
        { shop: TEST_SHOP, externalMessageId: 'e1', canonicalThreadId: thread.id, fromAddress: 'a@b.com', subject: 'S', bodyText: 'B', receivedAt: new Date('2026-04-20T10:00:00Z'), processingStatus: 'analyzed' },
        { shop: TEST_SHOP, externalMessageId: 'e2', canonicalThreadId: thread.id, fromAddress: 'a@b.com', subject: 'S', bodyText: 'B', receivedAt: new Date('2026-04-21T10:00:00Z'), processingStatus: 'analyzed' },
        { shop: TEST_SHOP, externalMessageId: 'e3', canonicalThreadId: thread.id, fromAddress: 'a@b.com', subject: 'S', bodyText: 'B', receivedAt: new Date('2026-04-22T10:00:00Z'), processingStatus: 'analyzed' },
        { shop: TEST_SHOP, externalMessageId: 'e-old', canonicalThreadId: thread.id, fromAddress: 'a@b.com', subject: 'S', bodyText: 'B', receivedAt: new Date('2026-03-01T10:00:00Z'), processingStatus: 'analyzed' },
      ],
    });

    const stats = await getKpiStats(TEST_SHOP, start, end, prevStart, prevEnd);
    expect(stats.totalEmails).toBe(3);
  });

  it('jours sans activité → valeur 0 dans la série (REQ-DASH-06)', async () => {
    const { start, end } = getPeriodBounds('7d', undefined, undefined, NOW);
    const thread = await createTestThread();

    // Only one email on Apr 20 — all other days should be zero-filled
    await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: 'gap-test',
        canonicalThreadId: thread.id,
        fromAddress: 'a@b.com',
        subject: 'S',
        bodyText: 'B',
        receivedAt: new Date('2026-04-20T10:00:00Z'),
        processingStatus: 'analyzed',
      },
    });

    const breakdown = await getDailyBreakdown(TEST_SHOP, start, end);

    // Series must span the full period with no gaps
    expect(breakdown.length).toBeGreaterThanOrEqual(7);

    // At least 6 days must have total = 0
    const zeroDays = breakdown.filter((d) => d.total === 0);
    expect(zeroDays.length).toBeGreaterThanOrEqual(6);

    // The email day must have total = 1
    const emailDay = breakdown.find((d) => d.date === '2026-04-20');
    expect(emailDay).toBeDefined();
    expect(emailDay!.total).toBe(1);
  });

  it('réouvertures = transitions resolved→waiting_merchant dans ThreadStateHistory (REQ-DASH-09)', async () => {
    const { start, end } = getPeriodBounds('7d', undefined, undefined, NOW);
    const thread = await createTestThread({ operationalState: 'resolved' });

    // One reopened transition in the period
    await testDb.threadStateHistory.create({
      data: {
        shop: TEST_SHOP,
        threadId: thread.id,
        fromState: 'resolved',
        toState: 'waiting_merchant',
        changedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    const stats = await getConversationStats(TEST_SHOP, start, end);
    expect(stats.reopenedConversations).toBe(1);
  });

  it('période sans données → tous les KPIs à 0 sans erreur (REQ-DASH-13)', async () => {
    const { start, end, prevStart, prevEnd } = getPeriodBounds('7d', undefined, undefined, NOW);

    const [kpis, breakdown] = await Promise.all([
      getKpiStats(TEST_SHOP, start, end, prevStart, prevEnd),
      getDailyBreakdown(TEST_SHOP, start, end),
    ]);

    expect(kpis.totalEmails).toBe(0);
    expect(kpis.supportEmails).toBe(0);
    expect(kpis.draftsCreated).toBe(0);
    expect(breakdown.length).toBeGreaterThanOrEqual(7);
    breakdown.forEach((d) => {
      expect(d.total).toBe(0);
      expect(d.support).toBe(0);
    });
  });
});
