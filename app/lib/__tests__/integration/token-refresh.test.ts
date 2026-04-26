// Integration tests for Gmail token refresh (REQ-SYNC-04).
// Uses a real Postgres DB, isolated by TEST_SHOP.
//
// REQ-SYNC-04: expired token triggers refresh and DB update
//              valid token skips refresh entirely

import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

// These variables must start with 'mock' so Vitest's vi.mock hoisting
// can reference them from the outer scope without "Cannot access before
// initialization" errors.
const mockRefreshAccessToken = vi.fn();
const mockSetCredentials = vi.fn();

vi.mock('googleapis', () => {
  function MockOAuth2() {
    return {
      setCredentials: mockSetCredentials,
      refreshAccessToken: mockRefreshAccessToken,
      generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth'),
    };
  }
  return {
    google: {
      auth: {
        OAuth2: MockOAuth2,
      },
    },
  };
});

// Bypass real AES-GCM encryption — the real crypto module requires an
// ENCRYPTION_KEY env var and would fail in test.  We use identity-like
// functions: encrypt prefixes "enc:", decrypt strips it.
vi.mock('../../gmail/crypto', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
}));

// Module imports MUST come after vi.mock declarations.
import { testDb, cleanTestShop, disconnectTestDb, TEST_SHOP } from './helpers/db';
import { getAuthenticatedClient } from '../../gmail/auth';

beforeAll(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
});

beforeEach(async () => {
  await cleanTestShop();
  mockRefreshAccessToken.mockReset();
  mockSetCredentials.mockReset();
});

afterAll(async () => {
  await cleanTestShop();
  await disconnectTestDb();
  // Clear the global prisma singleton so the next test file starts fresh.
  if (typeof global !== 'undefined') {
    (global as Record<string, unknown>).prismaGlobal = undefined;
  }
});

describe('Gmail token refresh — integration DB (REQ-SYNC-04)', () => {
  it('expired token triggers refreshAccessToken and updates DB tokenExpiry', async () => {
    // Insert a MailConnection with a token that expired 5 minutes ago.
    const expiredAt = new Date(Date.now() - 5 * 60_000);
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        email: 'test@example.com',
        accessToken: 'enc:test-access-token',
        refreshToken: 'enc:test-refresh-token',
        tokenExpiry: expiredAt,
      },
    });

    const newExpiry = Date.now() + 3600_000;
    mockRefreshAccessToken.mockResolvedValueOnce({
      credentials: {
        access_token: 'new-access-token',
        expiry_date: newExpiry,
        refresh_token: undefined,
      },
    });

    await getAuthenticatedClient(TEST_SHOP);

    // refreshAccessToken must have been called exactly once.
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);

    // The DB tokenExpiry must now be in the future.
    const updated = await testDb.mailConnection.findUniqueOrThrow({
      where: { shop: TEST_SHOP },
    });
    expect(updated.tokenExpiry.getTime()).toBeGreaterThan(Date.now());
    expect(updated.tokenExpiry.getTime()).toBeCloseTo(newExpiry, -3);
  });

  it('valid token skips refreshAccessToken', async () => {
    // Insert a MailConnection with a token that expires 1 hour from now.
    const validExpiry = new Date(Date.now() + 3600_000);
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        email: 'test@example.com',
        accessToken: 'enc:test-access-token',
        refreshToken: 'enc:test-refresh-token',
        tokenExpiry: validExpiry,
      },
    });

    await getAuthenticatedClient(TEST_SHOP);

    // refreshAccessToken must NOT have been called.
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });
});
