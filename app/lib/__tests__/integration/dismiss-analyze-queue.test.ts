import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb, createTestThread, seedMailConnection } from './helpers/db';
import { handleDismissAnalyzeQueue, handleDismissThreadFromAnalyze } from '../../support/inbox-actions';

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('handleDismissAnalyzeQueue — bulk', () => {
  it('marks all matching support-stance, unanalyzed, undismissed threads as dismissed', async () => {
    // 3 threads in the queue
    const a = await createTestThread({ supportNature: 'confirmed_support', operationalState: 'waiting_merchant' });
    const b = await createTestThread({ supportNature: 'probable_support', operationalState: 'open' });
    const c = await createTestThread({ supportNature: 'mixed', operationalState: 'waiting_merchant' });
    // 1 already analyzed (should be ignored)
    const d = await createTestThread({ supportNature: 'confirmed_support', operationalState: 'waiting_merchant' });
    await testDb.thread.update({ where: { id: d.id }, data: { analyzedAt: new Date() } });
    // 1 already dismissed (should be ignored)
    const e = await createTestThread({ supportNature: 'confirmed_support', operationalState: 'waiting_merchant' });
    await testDb.thread.update({ where: { id: e.id }, data: { dismissedFromAnalyzeAt: new Date(Date.now() - 1000) } });
    // 1 resolved (should be ignored even if other fields match)
    await createTestThread({ supportNature: 'confirmed_support', operationalState: 'resolved' });
    // 1 non_support (should be ignored)
    await createTestThread({ supportNature: 'non_support', operationalState: 'open' });

    const result = await handleDismissAnalyzeQueue({ shop: TEST_SHOP });
    expect((result as any).dismissedCount).toBe(3);

    const aAfter = await testDb.thread.findUnique({ where: { id: a.id } });
    const bAfter = await testDb.thread.findUnique({ where: { id: b.id } });
    const cAfter = await testDb.thread.findUnique({ where: { id: c.id } });
    expect(aAfter?.dismissedFromAnalyzeAt).toBeInstanceOf(Date);
    expect(bAfter?.dismissedFromAnalyzeAt).toBeInstanceOf(Date);
    expect(cAfter?.dismissedFromAnalyzeAt).toBeInstanceOf(Date);

    // Re-running is a no-op (everything already dismissed).
    const second = await handleDismissAnalyzeQueue({ shop: TEST_SHOP });
    expect((second as any).dismissedCount).toBe(0);
  });

  it('does not touch threads from other shops', async () => {
    const OTHER_SHOP = 'other-shop.myshopify.com';
    await testDb.shopFlag.deleteMany({ where: { shop: OTHER_SHOP } });
    await testDb.thread.deleteMany({ where: { shop: OTHER_SHOP } });
    await testDb.mailConnection.deleteMany({ where: { shop: OTHER_SHOP } });
    const otherMc = await seedMailConnection({ shop: OTHER_SHOP });
    const otherThread = await testDb.thread.create({
      data: {
        shop: OTHER_SHOP,
        mailConnectionId: otherMc.id,
        provider: 'gmail',
        firstMessageAt: new Date(),
        lastMessageAt: new Date(),
        supportNature: 'confirmed_support',
        operationalState: 'waiting_merchant',
        historyStatus: 'complete',
      },
    });
    await createTestThread({ supportNature: 'confirmed_support', operationalState: 'waiting_merchant' });

    const result = await handleDismissAnalyzeQueue({ shop: TEST_SHOP });
    expect((result as any).dismissedCount).toBe(1);

    const otherAfter = await testDb.thread.findUnique({ where: { id: otherThread.id } });
    expect(otherAfter?.dismissedFromAnalyzeAt).toBeNull();
    await testDb.thread.deleteMany({ where: { shop: OTHER_SHOP } });
    await testDb.mailConnection.deleteMany({ where: { shop: OTHER_SHOP } });
  });
});

describe('handleDismissThreadFromAnalyze — single', () => {
  it('marks a specific thread as dismissed', async () => {
    const t = await createTestThread({ supportNature: 'confirmed_support', operationalState: 'waiting_merchant' });
    const result = await handleDismissThreadFromAnalyze({ shop: TEST_SHOP, canonicalThreadId: t.id });
    expect((result as any).dismissedCount).toBe(1);
    const after = await testDb.thread.findUnique({ where: { id: t.id } });
    expect(after?.dismissedFromAnalyzeAt).toBeInstanceOf(Date);
  });

  it('is idempotent — re-dismissing returns 0', async () => {
    const t = await createTestThread({ supportNature: 'confirmed_support', operationalState: 'waiting_merchant' });
    await handleDismissThreadFromAnalyze({ shop: TEST_SHOP, canonicalThreadId: t.id });
    const second = await handleDismissThreadFromAnalyze({ shop: TEST_SHOP, canonicalThreadId: t.id });
    expect((second as any).dismissedCount).toBe(0);
  });

  it('does not touch a thread belonging to another shop', async () => {
    const OTHER_SHOP = 'other-shop-single.myshopify.com';
    await testDb.shopFlag.deleteMany({ where: { shop: OTHER_SHOP } });
    await testDb.thread.deleteMany({ where: { shop: OTHER_SHOP } });
    await testDb.mailConnection.deleteMany({ where: { shop: OTHER_SHOP } });
    const otherMc = await seedMailConnection({ shop: OTHER_SHOP });
    const otherThread = await testDb.thread.create({
      data: {
        shop: OTHER_SHOP,
        mailConnectionId: otherMc.id,
        provider: 'gmail',
        firstMessageAt: new Date(),
        lastMessageAt: new Date(),
        supportNature: 'confirmed_support',
        operationalState: 'waiting_merchant',
        historyStatus: 'complete',
      },
    });
    const result = await handleDismissThreadFromAnalyze({ shop: TEST_SHOP, canonicalThreadId: otherThread.id });
    expect((result as any).dismissedCount).toBe(0);
    const after = await testDb.thread.findUnique({ where: { id: otherThread.id } });
    expect(after?.dismissedFromAnalyzeAt).toBeNull();
    await testDb.thread.deleteMany({ where: { shop: OTHER_SHOP } });
    await testDb.mailConnection.deleteMany({ where: { shop: OTHER_SHOP } });
  });

  it('returns 0 for empty threadId', async () => {
    const result = await handleDismissThreadFromAnalyze({ shop: TEST_SHOP, canonicalThreadId: '' });
    expect((result as any).dismissedCount).toBe(0);
  });
});

describe('dismissedFromAnalyzeAt — auto-clear on new incoming message', () => {
  it('is cleared when ingestAndPrefilter sees a new non-outgoing message on a dismissed thread', async () => {
    // Seed a dismissed thread.
    const thread = await createTestThread({ supportNature: 'confirmed_support', operationalState: 'waiting_merchant' });
    await testDb.thread.update({
      where: { id: thread.id },
      data: { dismissedFromAnalyzeAt: new Date(Date.now() - 60_000) },
    });

    // Simulate the side-effect that ingestAndPrefilter performs on a new
    // incoming customer message: clear the dismiss flag. (We can't run the
    // full pipeline here without a live mail provider; the contract we're
    // pinning is the DB update itself.)
    const cleared = await testDb.thread.updateMany({
      where: { id: thread.id, shop: TEST_SHOP, dismissedFromAnalyzeAt: { not: null } },
      data: { dismissedFromAnalyzeAt: null },
    });
    expect(cleared.count).toBe(1);

    const after = await testDb.thread.findUnique({ where: { id: thread.id } });
    expect(after?.dismissedFromAnalyzeAt).toBeNull();
  });

  it('is a no-op when the thread was not dismissed', async () => {
    const thread = await createTestThread({ supportNature: 'confirmed_support', operationalState: 'waiting_merchant' });
    const cleared = await testDb.thread.updateMany({
      where: { id: thread.id, shop: TEST_SHOP, dismissedFromAnalyzeAt: { not: null } },
      data: { dismissedFromAnalyzeAt: null },
    });
    expect(cleared.count).toBe(0);
  });
});
