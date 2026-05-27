// Integration tests for GDPR webhook handlers.
// Uses a real Postgres DB, isolated by TEST_SHOP.
//
// REQ-GDPR-01: customers/data_request acknowledges with 200
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
import { action as customersDataRequestAction } from '../../../routes/webhooks.customers.data_request';
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
  it('customers/data_request acknowledges with 200 (REQ-GDPR-01)', async () => {
    vi.mocked(authenticate.webhook).mockResolvedValueOnce({
      topic: 'customers/data_request',
      shop: TEST_SHOP,
      payload: {
        customer: { id: 456, email: 'user@example.com' },
      },
    } as any);

    const response = await customersDataRequestAction({
      request: makeRequest(),
      params: {},
      context: {} as any,
    } as any);

    expect(response.status).toBe(200);
  });

  it('customers/redact deletes emails from the redacted customer (REQ-GDPR-02)', async () => {
    // The GDPR rewrite (78f86e2) deletes every email in any thread the
    // customer touched, then tombstones the thread itself. Seed two
    // SEPARATE threads — one belonging to the victim, one to a different
    // customer — so we can verify the "other" thread is untouched.
    const victimThread = await createTestThread();
    const otherThread = await createTestThread();

    const baseEmail = {
      shop: TEST_SHOP,
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
        {
          ...baseEmail,
          mailConnectionId: victimThread.mailConnectionId,
          threadId: victimThread.id,
          canonicalThreadId: victimThread.id,
          externalMessageId: 'msg-victim-1',
          fromAddress: 'victim@example.com',
        },
        {
          ...baseEmail,
          mailConnectionId: otherThread.mailConnectionId,
          threadId: otherThread.id,
          canonicalThreadId: otherThread.id,
          externalMessageId: 'msg-other-1',
          fromAddress: 'other@example.com',
        },
      ],
    });

    vi.mocked(authenticate.webhook).mockResolvedValueOnce({
      topic: 'customers/redact',
      shop: TEST_SHOP,
      payload: {
        customer: { id: 123, email: 'victim@example.com' },
        orders_to_redact: [],
      },
    } as any);

    const response = await customersRedactAction({
      request: makeRequest(),
      params: {},
      context: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(response.status).toBe(200);

    // Victim's email + thread emails wiped; other-thread email survives.
    const remaining = await testDb.incomingEmail.findMany({
      where: { shop: TEST_SHOP },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].fromAddress).toBe('other@example.com');

    // The victim thread is tombstoned, not deleted: row stays, PII cleared,
    // redactedAt set so the inbox can render a placeholder.
    const victimThreadAfter = await testDb.thread.findUnique({
      where: { id: victimThread.id },
    });
    expect(victimThreadAfter).not.toBeNull();
    expect(victimThreadAfter?.redactedAt).not.toBeNull();
    expect(victimThreadAfter?.redactedReason).toBe('gdpr_customer_request');
    expect(victimThreadAfter?.resolvedEmail).toBeNull();

    // The other thread is untouched.
    const otherThreadAfter = await testDb.thread.findUnique({
      where: { id: otherThread.id },
    });
    expect(otherThreadAfter?.redactedAt).toBeNull();
  });

  it('shop/redact deletes all shop data (REQ-GDPR-03)', async () => {
    // 1. Seed: thread + mailConnection + supportSettings + incomingEmail.
    const thread = await createTestThread();

    await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        mailConnectionId: thread.mailConnectionId,
        canonicalThreadId: thread.id,
        externalMessageId: 'msg-shop-redact',
        fromAddress: 'customer@example.com',
        fromName: '',
        subject: 'Test',
        snippet: '',
        bodyText: '',
        receivedAt: new Date(),
        extractedIdentifiers: '{}',
        labelIds: '[]',
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
    const [threadCount, mailConnectionCount, supportSettingsCount, emailCount] =
      await Promise.all([
        testDb.thread.count({ where: { shop: TEST_SHOP } }),
        testDb.mailConnection.count({ where: { shop: TEST_SHOP } }),
        testDb.supportSettings.count({ where: { shop: TEST_SHOP } }),
        testDb.incomingEmail.count({ where: { shop: TEST_SHOP } }),
      ]);

    expect(threadCount).toBe(0);
    expect(mailConnectionCount).toBe(0);
    expect(supportSettingsCount).toBe(0);
    expect(emailCount).toBe(0);
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
