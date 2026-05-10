import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import {
  getShopFlag,
  ensureShopFlag,
  markOnboardingComplete,
  markChecklistDismissed,
  hasGeneratedAnyDraft,
  hasCustomizedSupportSettings,
} from '../../onboarding/repo';

beforeEach(cleanTestShop);
afterAll(disconnectTestDb);

describe('ensureShopFlag', () => {
  it('creates a row with firstInstallDate=now if none exists', async () => {
    const flag = await ensureShopFlag(TEST_SHOP);
    expect(flag.shop).toBe(TEST_SHOP);
    expect(flag.onboardingCompletedAt).toBeNull();
    expect(flag.checklistDismissedAt).toBeNull();
  });

  it('is idempotent (returns existing row, does not reset firstInstallDate)', async () => {
    const first = await ensureShopFlag(TEST_SHOP);
    await new Promise((r) => setTimeout(r, 10));
    const second = await ensureShopFlag(TEST_SHOP);
    expect(second.firstInstallDate.getTime()).toBe(first.firstInstallDate.getTime());
  });
});

describe('markOnboardingComplete', () => {
  it('sets onboardingCompletedAt only if currently null (idempotent)', async () => {
    await ensureShopFlag(TEST_SHOP);
    const t1 = await markOnboardingComplete(TEST_SHOP);
    expect(t1).not.toBeNull();
    const t2 = await markOnboardingComplete(TEST_SHOP);
    expect(t2!.getTime()).toBe(t1!.getTime());
  });
});

describe('markChecklistDismissed', () => {
  it('sets checklistDismissedAt', async () => {
    await ensureShopFlag(TEST_SHOP);
    await markChecklistDismissed(TEST_SHOP);
    const flag = await getShopFlag(TEST_SHOP);
    expect(flag?.checklistDismissedAt).not.toBeNull();
  });
});

describe('hasGeneratedAnyDraft', () => {
  it('returns false when no drafts exist', async () => {
    expect(await hasGeneratedAnyDraft(TEST_SHOP)).toBe(false);
  });

  it('returns true when at least one ReplyDraft row exists for the shop', async () => {
    const thread = await testDb.thread.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        lastMessageAt: new Date(),
        firstMessageAt: new Date(),
        operationalStateUpdatedAt: new Date(),
        operationalState: 'open',
        supportNature: 'unknown',
        historyStatus: 'complete',
      },
    });
    const email = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: 'm1',
        canonicalThreadId: thread.id,
        fromAddress: 'a@b.c',
        subject: 's',
        receivedAt: new Date(),
      },
    });
    await testDb.replyDraft.create({
      data: { shop: TEST_SHOP, emailId: email.id, body: 'x' },
    });
    expect(await hasGeneratedAnyDraft(TEST_SHOP)).toBe(true);
  });
});

describe('hasCustomizedSupportSettings', () => {
  it('returns false when no row exists', async () => {
    expect(await hasCustomizedSupportSettings(TEST_SHOP)).toBe(false);
  });

  it('returns false when row exists with default values', async () => {
    await testDb.supportSettings.create({ data: { shop: TEST_SHOP } });
    expect(await hasCustomizedSupportSettings(TEST_SHOP)).toBe(false);
  });

  it('returns true when tone differs from default', async () => {
    await testDb.supportSettings.create({ data: { shop: TEST_SHOP, tone: 'formal' } });
    expect(await hasCustomizedSupportSettings(TEST_SHOP)).toBe(true);
  });

  it('returns true when brandName is set', async () => {
    await testDb.supportSettings.create({ data: { shop: TEST_SHOP, brandName: 'ACME' } });
    expect(await hasCustomizedSupportSettings(TEST_SHOP)).toBe(true);
  });
});
