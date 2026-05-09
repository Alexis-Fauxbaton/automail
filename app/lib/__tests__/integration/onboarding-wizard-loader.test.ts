import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
});

vi.mock('../../../shopify.server', () => ({
  authenticate: { admin: vi.fn() },
}));

// Stub the OAuth URL helpers so we don't need real provider credentials.
vi.mock('../../gmail/auth', () => ({
  getAuthUrl: () => 'https://example.test/gmail-oauth',
}));
vi.mock('../../zoho/auth', () => ({
  getZohoAuthUrl: () => 'https://example.test/zoho-oauth',
}));
vi.mock('../../outlook/auth', () => ({
  getAuthUrl: () => 'https://example.test/outlook-oauth',
}));

async function runLoader() {
  const { authenticate } = await import('../../../shopify.server');
  (authenticate.admin as any).mockResolvedValue({
    session: { shop: TEST_SHOP },
    admin: {},
  });

  const { loader } = await import('../../../routes/app.onboarding');
  return loader({
    request: new Request('https://x/app/onboarding'),
  } as any);
}

describe('app.onboarding loader', () => {
  it('redirects to /app/inbox when shop is already onboarded', async () => {
    await testDb.shopFlag.create({
      data: {
        shop: TEST_SHOP,
        installDate: new Date(),
        onboardingCompletedAt: new Date(),
      },
    });

    await expect(runLoader()).rejects.toMatchObject({
      status: 302,
      headers: expect.any(Headers),
    });
    const result = await runLoader().catch((r) => r);
    expect((result as Response).headers.get('Location')).toBe('/app/inbox');
  });

  it('auto-completes onboarding and redirects to /app/inbox when MailConnection already exists', async () => {
    await testDb.shopFlag.create({
      data: { shop: TEST_SHOP, installDate: new Date() },
    });
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        provider: 'zoho',
        email: 't@e.com',
        accessToken: 'x',
        refreshToken: 'x',
        tokenExpiry: new Date(Date.now() + 3_600_000),
      },
    });

    const result = await runLoader().catch((r) => r);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get('Location')).toBe('/app/inbox');

    // The loader should have set onboardingCompletedAt server-side.
    const flag = await testDb.shopFlag.findUnique({ where: { shop: TEST_SHOP } });
    expect(flag?.onboardingCompletedAt).not.toBeNull();
  });

  it('renders the wizard (returns auth URLs) when not onboarded and no MailConnection', async () => {
    await testDb.shopFlag.create({
      data: { shop: TEST_SHOP, installDate: new Date() },
    });

    const result = await runLoader();
    expect(result).toMatchObject({
      gmailAuthUrl: 'https://example.test/gmail-oauth',
      zohoAuthUrl: 'https://example.test/zoho-oauth',
      outlookAuthUrl: 'https://example.test/outlook-oauth',
    });

    // onboardingCompletedAt must NOT be set when no MailConnection exists.
    const flag = await testDb.shopFlag.findUnique({ where: { shop: TEST_SHOP } });
    expect(flag?.onboardingCompletedAt).toBeNull();
  });
});
