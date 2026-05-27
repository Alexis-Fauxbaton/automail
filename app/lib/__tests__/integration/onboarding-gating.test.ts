import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';
import { requireOnboardingComplete } from '../../onboarding/guard';
import { markOnboardingComplete, markChecklistDismissed, getShopFlag, ensureShopFlag } from '../../onboarding/repo';

beforeEach(() => cleanTestShop());
afterAll(disconnectTestDb);

describe('requireOnboardingComplete', () => {
  it('throws a redirect Response when onboarding is not complete', async () => {
    await ensureShopFlag(TEST_SHOP);
    await expect(requireOnboardingComplete(TEST_SHOP)).rejects.toMatchObject({
      status: 302,
      headers: expect.any(Headers),
    });
  });

  it('returns silently when onboardingCompletedAt is set', async () => {
    await ensureShopFlag(TEST_SHOP);
    await markOnboardingComplete(TEST_SHOP);
    await expect(requireOnboardingComplete(TEST_SHOP)).resolves.toBeUndefined();
  });
});

describe('markOnboardingComplete', () => {
  it('is idempotent across concurrent calls', async () => {
    await ensureShopFlag(TEST_SHOP);
    const [a, b] = await Promise.all([
      markOnboardingComplete(TEST_SHOP),
      markOnboardingComplete(TEST_SHOP),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.getTime()).toBe(b!.getTime());
  });
});

describe('markChecklistDismissed', () => {
  it('persists across reads', async () => {
    await ensureShopFlag(TEST_SHOP);
    await markChecklistDismissed(TEST_SHOP);
    const flag = await getShopFlag(TEST_SHOP);
    expect(flag?.checklistDismissedAt).not.toBeNull();
  });
});

describe('migration backfill regression', () => {
  it('shop with MailConnection + onboardingCompletedAt set passes the guard', async () => {
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        email: 't@e.com',
        accessToken: 'x',
        refreshToken: 'x',
        tokenExpiry: new Date(Date.now() + 3_600_000),
      },
    });
    await markOnboardingComplete(TEST_SHOP);
    await expect(requireOnboardingComplete(TEST_SHOP)).resolves.toBeUndefined();
  });
});
