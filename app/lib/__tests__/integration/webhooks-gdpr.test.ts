// Integration tests for GDPR webhook handlers.
// Uses a real Postgres DB, isolated by TEST_SHOP.
//
// REQ-GDPR-02: customers/redact deletes emails from the redacted customer
// REQ-GDPR-03: shop/redact deletes all shop data
// REQ-GDPR-SIG: invalid signature → action throws 401

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  testDb,
  cleanTestShop,
  createTestThread,
  disconnectTestDb,
  TEST_SHOP,
} from './helpers/db';

// Mock MUST be declared before importing anything that depends on shopify.server.
// vi.mock is hoisted to the top of the file by Vitest.
// We mock the path as the routes see it (resolved from app/routes/ as "../shopify.server").
// Vitest deduplicates by physical file, so any import resolving to app/shopify.server
// will receive this mock regardless of which relative path was used.
vi.mock('../../../shopify.server', () => ({
  authenticate: {
    webhook: vi.fn(),
  },
}));

import { authenticate } from '../../../shopify.server';
import { action as customersRedactAction } from '../../../routes/webhooks.customers.redact';
import { action as shopRedactAction } from '../../../routes/webhooks.shop.redact';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(): Request {
  return new Request('http://localhost/webhooks', { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await cleanTestShop();
  vi.resetAllMocks();
});

afterAll(async () => {
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GDPR webhooks — integration DB', () => {
  it('customers/redact deletes emails from the redacted customer (REQ-GDPR-02)', async () => {
    // 1. Seed: create a thread and two emails — one from the victim, one from someone else.
    const thread = await createTestThread();

    const baseEmail = {
      shop: TEST_SHOP,
      threadId: thread.id,
      externalMessageId: '',
      fromName: '',
      subject: 'Test',
      snippet: '',
      bodyText: '',
      receivedAt: new Date(),
      extractedIdentifiers: '{}',
      labelIds: '[]',
    };

    await testDb.incomingEmail.createMany({
      data: [
        { ...baseEmail, externalMessageId: 'msg-victim-1', fromAddress: 'victim@example.com' },
        { ...baseEmail, externalMessageId: 'msg-other-1', fromAddress: 'other@example.com' },
      ],
    });

    // 2. Mock authenticate.webhook for this call.
    vi.mocked(authenticate.webhook).mockResolvedValueOnce({
      topic: 'customers/redact',
      shop: TEST_SHOP,
      payload: {
        customer: { id: 123, email: 'victim@example.com' },
        orders_to_redact: [],
      },
    } as any);

    // 3. Call the action.
    const response = await customersRedactAction({
      request: makeRequest(),
      params: {},
      context: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // 4. Assert HTTP 200.
    expect(response.status).toBe(200);

    // 5. Only the "other" email should remain.
    const remaining = await testDb.incomingEmail.findMany({
      where: { shop: TEST_SHOP },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].fromAddress).toBe('other@example.com');
  });

  it('shop/redact deletes all shop data (REQ-GDPR-03)', async () => {
    // 1. Seed: thread + mailConnection + supportSettings.
    await createTestThread();

    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        accessToken: 'enc-access',
        refreshToken: 'enc-refresh',
        tokenExpiry: new Date(Date.now() + 3_600_000),
      },
    });

    await testDb.supportSettings.create({
      data: {
        shop: TEST_SHOP,
      },
    });

    // 2. Mock authenticate.webhook.
    vi.mocked(authenticate.webhook).mockResolvedValueOnce({
      topic: 'shop/redact',
      shop: TEST_SHOP,
    } as any);

    // 3. Call the action.
    const response = await shopRedactAction({
      request: makeRequest(),
      params: {},
      context: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // 4. Assert HTTP 200.
    expect(response.status).toBe(200);

    // 5. All shop data must be gone.
    const [threadCount, mailConnectionCount, supportSettingsCount] =
      await Promise.all([
        testDb.thread.count({ where: { shop: TEST_SHOP } }),
        testDb.mailConnection.count({ where: { shop: TEST_SHOP } }),
        testDb.supportSettings.count({ where: { shop: TEST_SHOP } }),
      ]);

    expect(threadCount).toBe(0);
    expect(mailConnectionCount).toBe(0);
    expect(supportSettingsCount).toBe(0);
  });

  it('invalid webhook signature → action throws 401 (REQ-GDPR-SIG)', async () => {
    // authenticate.webhook throws a Response(401) on bad HMAC — no try-catch in the action.
    vi.mocked(authenticate.webhook).mockImplementationOnce(() => {
      throw new Response('', { status: 401 });
    });

    let response: Response;
    try {
      response = await customersRedactAction({
        request: makeRequest(),
        params: {},
        context: {} as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    } catch (thrown: unknown) {
      response = thrown as Response;
    }

    expect(response!.status).toBe(401);
  });
});
