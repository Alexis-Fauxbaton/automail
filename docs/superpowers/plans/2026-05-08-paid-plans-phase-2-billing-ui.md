# Paid Plans Phase 2 — Billing UI & Shopify Flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the merchant-facing billing surface (page, top bar counter, banners, modals) and the Shopify Billing API plumbing (subscribe, cancel, webhook). After this phase, a merchant can choose a plan, complete Shopify's confirmation flow, see their plan and quota status everywhere in the app — but the entitlements aren't yet enforced at draft-generation call sites (Phase 3).

**Architecture:** All flows use `resolveEntitlements` from Phase 1 (`app/lib/billing/entitlements.ts`) as their single source of truth. Subscribe/cancel actions call Shopify's `appSubscriptionCreate`/`appSubscriptionCancel` mutations via a thin helper. The root layout (`app.tsx`) loads entitlements once per request and injects them into a React context consumed by banners and counter.

**Tech Stack:** TypeScript, React, React Router 7, Shopify Admin GraphQL, App Bridge (web components `s-app-nav`, `s-link`), vitest. The app is embedded in Shopify admin.

**Reference spec:** [docs/superpowers/specs/2026-05-08-paid-plans-design.md](docs/superpowers/specs/2026-05-08-paid-plans-design.md)
**Phase 1 plan:** [docs/superpowers/plans/2026-05-08-paid-plans-phase-1-foundations.md](docs/superpowers/plans/2026-05-08-paid-plans-phase-1-foundations.md)

---

## File Structure

| File | Responsibility |
|---|---|
| `app/lib/billing/shopify-billing.ts` | Wraps `appSubscriptionCreate` and `appSubscriptionCancel` GraphQL mutations |
| `app/lib/billing/__tests__/shopify-billing.test.ts` | Unit tests with mocked admin client |
| `app/routes/api.billing.subscribe.tsx` | Action route: receives plan choice, calls Shopify, returns confirmationUrl |
| `app/routes/api.billing.cancel.tsx` | Action route: cancels subscription (immediate) or schedules downgrade |
| `app/routes/webhooks.app_subscriptions.update.tsx` | Webhook handler: invalidates cache when Shopify pushes a subscription update |
| `app/routes/app.billing.tsx` | Page UI: plan selector, current plan display, comparison table, scheduled change indicator |
| `app/lib/billing/entitlements-context.tsx` | React context provider + `useEntitlements()` hook |
| `app/components/billing/TopBarCounter.tsx` | Permanent counter widget |
| `app/components/billing/QuotaBanner.tsx` | Warning/critical/exceeded banners |
| `app/components/billing/TrialBanner.tsx` | Trial countdown banner |
| `app/components/billing/QuotaExceededModal.tsx` | Modal shown when generation is blocked |
| `app/lib/__tests__/integration/billing-subscribe-route.test.ts` | Integration test for the subscribe action |
| `app/lib/__tests__/integration/billing-cancel-route.test.ts` | Integration test for the cancel action |
| `app/lib/__tests__/integration/billing-webhook-update.test.ts` | Integration test for the webhook |
| `app/routes/app.tsx` | Modify: load entitlements + inject context + mount banners + mount counter |
| `app/i18n/locales/en.json` | Modify: add `billing.*` keys |
| `app/i18n/locales/fr.json` | Modify: add `billing.*` keys |
| `shopify.app.toml` | Modify: register `app_subscriptions/update` webhook |

---

## Task 1: `shopify-billing.ts` — Shopify Billing GraphQL helper

**Files:**
- Create: `app/lib/billing/shopify-billing.ts`
- Test: `app/lib/billing/__tests__/shopify-billing.test.ts`

The helper exposes 3 functions:
- `createSubscription({ admin, planId, returnUrl, test })` → returns `{ confirmationUrl, subscriptionId }`
- `cancelSubscription({ admin, subscriptionId })` → returns `{ subscriptionId, status }`
- Pricing strategy: monthly recurring (`AppRecurringPricingDetails`), no usage component for v1.

- [ ] **Step 1: Write the failing test**

Create `app/lib/billing/__tests__/shopify-billing.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createSubscription, cancelSubscription } from '../shopify-billing';

function makeAdmin(graphqlImpl: (query: string, opts?: any) => Promise<any>) {
  return { graphql: vi.fn(graphqlImpl) };
}

describe('createSubscription', () => {
  it('calls appSubscriptionCreate with starter pricing', async () => {
    const admin = makeAdmin(async () => ({
      json: async () => ({
        data: {
          appSubscriptionCreate: {
            confirmationUrl: 'https://example.myshopify.com/admin/charges/123/confirm',
            appSubscription: { id: 'gid://shopify/AppSubscription/123' },
            userErrors: [],
          },
        },
      }),
    }));

    const result = await createSubscription({
      admin: admin as any,
      planId: 'starter',
      returnUrl: 'https://app.example.com/app/billing?subscribed=1',
      test: true,
    });

    expect(result.confirmationUrl).toBe(
      'https://example.myshopify.com/admin/charges/123/confirm'
    );
    expect(result.subscriptionId).toBe('gid://shopify/AppSubscription/123');

    // Verify the mutation includes correct plan name and amount
    const callArgs = admin.graphql.mock.calls[0];
    const variables = callArgs[1]?.variables;
    expect(variables.name).toBe('starter');
    expect(variables.lineItems[0].plan.appRecurringPricingDetails.price.amount).toBe(9);
    expect(variables.test).toBe(true);
    expect(variables.trialDays).toBe(14);
  });

  it('calls appSubscriptionCreate with pro pricing', async () => {
    const admin = makeAdmin(async () => ({
      json: async () => ({
        data: {
          appSubscriptionCreate: {
            confirmationUrl: 'https://x/confirm',
            appSubscription: { id: 'gid://1' },
            userErrors: [],
          },
        },
      }),
    }));

    await createSubscription({
      admin: admin as any,
      planId: 'pro',
      returnUrl: 'https://x',
      test: true,
    });

    const variables = admin.graphql.mock.calls[0][1]?.variables;
    expect(variables.name).toBe('pro');
    expect(variables.lineItems[0].plan.appRecurringPricingDetails.price.amount).toBe(49);
  });

  it('throws on userErrors from Shopify', async () => {
    const admin = makeAdmin(async () => ({
      json: async () => ({
        data: {
          appSubscriptionCreate: {
            confirmationUrl: null,
            appSubscription: null,
            userErrors: [{ field: ['name'], message: 'Invalid plan name' }],
          },
        },
      }),
    }));

    await expect(
      createSubscription({
        admin: admin as any,
        planId: 'starter',
        returnUrl: 'https://x',
        test: true,
      })
    ).rejects.toThrow(/Invalid plan name/);
  });
});

describe('cancelSubscription', () => {
  it('calls appSubscriptionCancel with the right id', async () => {
    const admin = makeAdmin(async () => ({
      json: async () => ({
        data: {
          appSubscriptionCancel: {
            appSubscription: { id: 'gid://shopify/AppSubscription/123', status: 'CANCELLED' },
            userErrors: [],
          },
        },
      }),
    }));

    const result = await cancelSubscription({
      admin: admin as any,
      subscriptionId: 'gid://shopify/AppSubscription/123',
    });

    expect(result.subscriptionId).toBe('gid://shopify/AppSubscription/123');
    expect(result.status).toBe('CANCELLED');
  });

  it('throws on userErrors', async () => {
    const admin = makeAdmin(async () => ({
      json: async () => ({
        data: {
          appSubscriptionCancel: {
            appSubscription: null,
            userErrors: [{ field: ['id'], message: 'Subscription not found' }],
          },
        },
      }),
    }));

    await expect(
      cancelSubscription({ admin: admin as any, subscriptionId: 'gid://x' })
    ).rejects.toThrow(/Subscription not found/);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run app/lib/billing/__tests__/shopify-billing.test.ts`
Expected: FAIL — `Cannot find module '../shopify-billing'`.

- [ ] **Step 3: Implement `shopify-billing.ts`**

Create `app/lib/billing/shopify-billing.ts`:

```typescript
/**
 * Thin wrapper around Shopify's Billing API GraphQL mutations.
 *
 * - createSubscription: kicks off the merchant subscription flow. Returns
 *   the Shopify confirmationUrl that the merchant must visit to complete
 *   the purchase. The route handler redirects them.
 * - cancelSubscription: cancels an active subscription immediately
 *   (Shopify keeps it active until the end of the paid period).
 *
 * Trial handling: Shopify's `trialDays` field is honored on first install
 * for new subscriptions. We pass 14 to grant a fresh trial when applicable;
 * Shopify automatically refuses extra trials per its own rules, so this is
 * safe to always pass.
 */

import { PLANS, type PlanId } from './plans';

interface AdminClient {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<{
    json: () => Promise<any>;
  }>;
}

const CREATE_MUTATION = `#graphql
  mutation AppSubscriptionCreate(
    $name: String!
    $returnUrl: URL!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $trialDays: Int
    $test: Boolean
    $replacementBehavior: AppSubscriptionReplacementBehavior
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      lineItems: $lineItems
      trialDays: $trialDays
      test: $test
      replacementBehavior: $replacementBehavior
    ) {
      confirmationUrl
      appSubscription { id }
      userErrors { field message }
    }
  }
`;

const CANCEL_MUTATION = `#graphql
  mutation AppSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status }
      userErrors { field message }
    }
  }
`;

export async function createSubscription(input: {
  admin: AdminClient;
  planId: Exclude<PlanId, 'trial'>;
  returnUrl: string;
  test?: boolean;
  trialDays?: number;
}): Promise<{ confirmationUrl: string; subscriptionId: string }> {
  const plan = PLANS[input.planId];
  const response = await input.admin.graphql(CREATE_MUTATION, {
    variables: {
      name: input.planId,
      returnUrl: input.returnUrl,
      trialDays: input.trialDays ?? 14,
      test: input.test ?? false,
      replacementBehavior: 'STANDARD',
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: plan.priceUsd, currencyCode: 'USD' },
              interval: 'EVERY_30_DAYS',
            },
          },
        },
      ],
    },
  });

  const body = await response.json();
  const result = body?.data?.appSubscriptionCreate;
  if (!result) throw new Error('Invalid Shopify response (no appSubscriptionCreate)');
  if (result.userErrors?.length) {
    throw new Error(
      `Shopify userErrors: ${result.userErrors.map((e: any) => e.message).join('; ')}`
    );
  }
  if (!result.confirmationUrl || !result.appSubscription?.id) {
    throw new Error('Shopify did not return a confirmation URL');
  }
  return {
    confirmationUrl: result.confirmationUrl,
    subscriptionId: result.appSubscription.id,
  };
}

export async function cancelSubscription(input: {
  admin: AdminClient;
  subscriptionId: string;
}): Promise<{ subscriptionId: string; status: string }> {
  const response = await input.admin.graphql(CANCEL_MUTATION, {
    variables: { id: input.subscriptionId },
  });
  const body = await response.json();
  const result = body?.data?.appSubscriptionCancel;
  if (!result) throw new Error('Invalid Shopify response (no appSubscriptionCancel)');
  if (result.userErrors?.length) {
    throw new Error(
      `Shopify userErrors: ${result.userErrors.map((e: any) => e.message).join('; ')}`
    );
  }
  if (!result.appSubscription) {
    throw new Error('Shopify did not return a subscription');
  }
  return {
    subscriptionId: result.appSubscription.id,
    status: result.appSubscription.status,
  };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run app/lib/billing/__tests__/shopify-billing.test.ts`
Expected: PASS — 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add app/lib/billing/shopify-billing.ts app/lib/billing/__tests__/shopify-billing.test.ts
git commit -m "feat(billing): Shopify Billing API helper (create/cancel subscription)"
```

---

## Task 2: Webhook handler `webhooks.app_subscriptions.update.tsx`

**Files:**
- Create: `app/routes/webhooks.app_subscriptions.update.tsx`
- Test: `app/lib/__tests__/integration/billing-webhook-update.test.ts`
- Modify: `shopify.app.toml` (register webhook)

- [ ] **Step 1: Update `shopify.app.toml`**

In `shopify.app.toml`, in the `[webhooks]` section, append a new subscription block (after the existing `app/scopes_update` one):

```toml
  [[webhooks.subscriptions]]
  uri = "/webhooks/app_subscriptions/update"
  topics = [ "app_subscriptions/update" ]
```

- [ ] **Step 2: Write the failing integration test**

Create `app/lib/__tests__/integration/billing-webhook-update.test.ts`:

```typescript
import { describe, it, expect, vi, afterAll } from 'vitest';
import { disconnectTestDb } from './helpers/db';
import { invalidateCache } from '../../billing/subscription';

afterAll(async () => {
  await disconnectTestDb();
});

// We test the handler logic by importing the action directly and mocking authenticate.webhook.
// The handler should: (1) authenticate, (2) call invalidateCache(shop), (3) return 200.

vi.mock('../../../shopify.server', () => ({
  authenticate: {
    webhook: vi.fn(),
  },
}));

describe('webhooks.app_subscriptions.update', () => {
  it('invalidates the subscription cache for the shop and returns 200', async () => {
    const { authenticate } = await import('../../../shopify.server');
    (authenticate.webhook as any).mockResolvedValue({
      shop: 'webhook-test.myshopify.com',
      topic: 'APP_SUBSCRIPTIONS_UPDATE',
      payload: { app_subscription: { status: 'ACTIVE' } },
    });

    // Spy on invalidateCache
    const spy = vi.spyOn(await import('../../billing/subscription'), 'invalidateCache');

    const { action } = await import('../../../routes/webhooks.app_subscriptions.update');
    const response = await action({ request: new Request('https://x/webhooks/app_subscriptions/update', { method: 'POST' }) } as any);

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('webhook-test.myshopify.com');
  });
});
```

- [ ] **Step 3: Run test, verify failure**

Run: `npm run test:integration -- billing-webhook-update`
Expected: FAIL — `Cannot find module '../../../routes/webhooks.app_subscriptions.update'`.

- [ ] **Step 4: Implement the webhook handler**

Create `app/routes/webhooks.app_subscriptions.update.tsx`:

```typescript
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { invalidateCache } from "../lib/billing/subscription";

/**
 * Webhook: app_subscriptions/update
 *
 * Fires when a merchant's subscription status changes (created, activated,
 * cancelled, frozen, expired). We use this purely to invalidate our 5min
 * in-memory cache so the next request sees the fresh state.
 *
 * The actual subscription state remains read from Shopify's API on demand
 * (see `subscription.ts`). We don't mirror state in our DB — Shopify is
 * the source of truth.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  invalidateCache(shop);
  return new Response(null, { status: 200 });
};
```

- [ ] **Step 5: Run test, verify pass**

Run: `npm run test:integration -- billing-webhook-update`
Expected: PASS — 1 test passing.

- [ ] **Step 6: Commit**

```bash
git add app/routes/webhooks.app_subscriptions.update.tsx app/lib/__tests__/integration/billing-webhook-update.test.ts shopify.app.toml
git commit -m "feat(billing): app_subscriptions/update webhook for cache invalidation"
```

---

## Task 3: API route `api.billing.subscribe.tsx`

**Files:**
- Create: `app/routes/api.billing.subscribe.tsx`
- Test: `app/lib/__tests__/integration/billing-subscribe-route.test.ts`

The action accepts a POST with a `planId` form field (`starter` or `pro`), calls `createSubscription`, returns the confirmationUrl. The browser then navigates the merchant there.

- [ ] **Step 1: Write the failing integration test**

Create `app/lib/__tests__/integration/billing-subscribe-route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
});

vi.mock('../../../shopify.server', () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

describe('api.billing.subscribe action', () => {
  it('returns confirmationUrl for valid plan', async () => {
    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          appSubscriptionCreate: {
            confirmationUrl: 'https://x.myshopify.com/admin/charges/1/confirm',
            appSubscription: { id: 'gid://shopify/AppSubscription/1' },
            userErrors: [],
          },
        },
      }),
    });

    const { authenticate } = await import('../../../shopify.server');
    (authenticate.admin as any).mockResolvedValue({
      session: { shop: TEST_SHOP },
      admin: { graphql: adminGraphql },
    });

    const { action } = await import('../../../routes/api.billing.subscribe');

    const formData = new FormData();
    formData.set('planId', 'starter');
    const response = await action({
      request: new Request('https://x/api/billing/subscribe', { method: 'POST', body: formData }),
    } as any);

    const json = await response.json();
    expect(json.confirmationUrl).toBe('https://x.myshopify.com/admin/charges/1/confirm');
    expect(adminGraphql).toHaveBeenCalled();
  });

  it('returns 400 for missing planId', async () => {
    const { authenticate } = await import('../../../shopify.server');
    (authenticate.admin as any).mockResolvedValue({
      session: { shop: TEST_SHOP },
      admin: { graphql: vi.fn() },
    });

    const { action } = await import('../../../routes/api.billing.subscribe');

    const response = await action({
      request: new Request('https://x/api/billing/subscribe', { method: 'POST', body: new FormData() }),
    } as any);

    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid planId', async () => {
    const { authenticate } = await import('../../../shopify.server');
    (authenticate.admin as any).mockResolvedValue({
      session: { shop: TEST_SHOP },
      admin: { graphql: vi.fn() },
    });

    const { action } = await import('../../../routes/api.billing.subscribe');

    const formData = new FormData();
    formData.set('planId', 'enterprise');
    const response = await action({
      request: new Request('https://x/api/billing/subscribe', { method: 'POST', body: formData }),
    } as any);

    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm run test:integration -- billing-subscribe-route`
Expected: FAIL — `Cannot find module '../../../routes/api.billing.subscribe'`.

- [ ] **Step 3: Implement the route**

Create `app/routes/api.billing.subscribe.tsx`:

```typescript
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createSubscription } from "../lib/billing/shopify-billing";

const VALID_PLAN_IDS = ['starter', 'pro'] as const;
type ValidPlanId = (typeof VALID_PLAN_IDS)[number];

function isValidPlanId(id: string): id is ValidPlanId {
  return (VALID_PLAN_IDS as readonly string[]).includes(id);
}

/**
 * POST /api/billing/subscribe
 *
 * Body: planId=starter|pro
 *
 * Returns: { confirmationUrl: string }
 *
 * The client should navigate to confirmationUrl (top-level redirect, not iframe)
 * to let the merchant complete the Shopify confirmation flow. Shopify will
 * redirect back to returnUrl after.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const planId = String(formData.get("planId") ?? "");

  if (!planId || !isValidPlanId(planId)) {
    return new Response(JSON.stringify({ error: "invalid_plan_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST || "";
  const returnUrl = `${appUrl}/app/billing?subscribed=1`;
  // eslint-disable-next-line no-undef
  const isTest = process.env.NODE_ENV !== "production";

  const result = await createSubscription({
    admin,
    planId,
    returnUrl,
    test: isTest,
  });

  console.log(`[billing] ${session.shop} subscribed to ${planId} (test=${isTest})`);

  return new Response(JSON.stringify({ confirmationUrl: result.confirmationUrl }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm run test:integration -- billing-subscribe-route`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add app/routes/api.billing.subscribe.tsx app/lib/__tests__/integration/billing-subscribe-route.test.ts
git commit -m "feat(billing): /api/billing/subscribe action route"
```

---

## Task 4: API route `api.billing.cancel.tsx`

This route handles two cases:
- **Immediate cancel** (no body or `mode=immediate`): cancels the active Shopify subscription.
- **Scheduled downgrade** (`mode=downgrade&toPlan=starter`): records a `BillingScheduledChange` to apply at the end of the current period; doesn't touch Shopify.

**Files:**
- Create: `app/routes/api.billing.cancel.tsx`
- Test: `app/lib/__tests__/integration/billing-cancel-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/__tests__/integration/billing-cancel-route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { testDb, TEST_SHOP, cleanTestShop, disconnectTestDb } from './helpers/db';

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanTestShop();
});

vi.mock('../../../shopify.server', () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

describe('api.billing.cancel — immediate', () => {
  it('cancels the active Shopify subscription', async () => {
    const adminGraphql = vi.fn()
      // First call: query to find active subscription id
      .mockResolvedValueOnce({
        json: async () => ({
          data: {
            currentAppInstallation: {
              activeSubscriptions: [
                { id: 'gid://shopify/AppSubscription/77', name: 'pro', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
              ],
            },
          },
        }),
      })
      // Second call: cancel mutation
      .mockResolvedValueOnce({
        json: async () => ({
          data: {
            appSubscriptionCancel: {
              appSubscription: { id: 'gid://shopify/AppSubscription/77', status: 'CANCELLED' },
              userErrors: [],
            },
          },
        }),
      });

    const { authenticate } = await import('../../../shopify.server');
    (authenticate.admin as any).mockResolvedValue({
      session: { shop: TEST_SHOP },
      admin: { graphql: adminGraphql },
    });

    const { action } = await import('../../../routes/api.billing.cancel');

    const fd = new FormData();
    fd.set('mode', 'immediate');
    const response = await action({
      request: new Request('https://x/api/billing/cancel', { method: 'POST', body: fd }),
    } as any);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.cancelled).toBe(true);
  });
});

describe('api.billing.cancel — scheduled downgrade', () => {
  it('creates a BillingScheduledChange row', async () => {
    // For scheduled downgrade we need the current period end from active subscription.
    const adminGraphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              { id: 'gid://1', name: 'pro', status: 'ACTIVE', trialDays: 14, createdAt: '2026-05-01T00:00:00Z', currentPeriodEnd: '2026-06-01T00:00:00Z' },
            ],
          },
        },
      }),
    });

    const { authenticate } = await import('../../../shopify.server');
    (authenticate.admin as any).mockResolvedValue({
      session: { shop: TEST_SHOP },
      admin: { graphql: adminGraphql },
    });

    const { action } = await import('../../../routes/api.billing.cancel');

    const fd = new FormData();
    fd.set('mode', 'downgrade');
    fd.set('toPlan', 'starter');
    const response = await action({
      request: new Request('https://x/api/billing/cancel', { method: 'POST', body: fd }),
    } as any);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.scheduled).toBe(true);
    expect(json.effectiveAt).toBeDefined();

    const change = await testDb.billingScheduledChange.findFirst({
      where: { shop: TEST_SHOP, appliedAt: null, cancelledAt: null },
    });
    expect(change).not.toBeNull();
    expect(change?.fromPlan).toBe('pro');
    expect(change?.toPlan).toBe('starter');
  });

  it('returns 400 for invalid toPlan', async () => {
    const { authenticate } = await import('../../../shopify.server');
    (authenticate.admin as any).mockResolvedValue({
      session: { shop: TEST_SHOP },
      admin: { graphql: vi.fn() },
    });

    const { action } = await import('../../../routes/api.billing.cancel');

    const fd = new FormData();
    fd.set('mode', 'downgrade');
    fd.set('toPlan', 'enterprise');
    const response = await action({
      request: new Request('https://x/api/billing/cancel', { method: 'POST', body: fd }),
    } as any);

    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm run test:integration -- billing-cancel-route`
Expected: FAIL — `Cannot find module '../../../routes/api.billing.cancel'`.

- [ ] **Step 3: Implement the route**

Create `app/routes/api.billing.cancel.tsx`:

```typescript
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveActivePlan } from "../lib/billing/subscription";
import { cancelSubscription } from "../lib/billing/shopify-billing";
import { scheduleDowngrade } from "../lib/billing/scheduled-changes";

const VALID_DOWNGRADE_TARGETS = ['starter'] as const;

/**
 * POST /api/billing/cancel
 *
 * Body:
 *   mode=immediate           → cancel active Shopify subscription now
 *   mode=downgrade&toPlan=starter → schedule downgrade at end of period
 *
 * For "immediate": Shopify keeps the subscription active until the end of
 * the paid period, then de-activates. Our entitlements naturally reflect
 * this via the cache + 5min TTL or the webhook.
 *
 * For "downgrade": we record a BillingScheduledChange. A separate cron job
 * (Phase 4 or later) will apply it by calling appSubscriptionCreate with
 * the new plan at the effectiveAt.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const mode = String(formData.get("mode") ?? "immediate");

  const active = await resolveActivePlan({ shop: session.shop, admin });
  if (active.plan === 'none') {
    return new Response(JSON.stringify({ error: "no_active_subscription" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (mode === 'immediate') {
    const result = await cancelSubscription({ admin, subscriptionId: active.subscriptionId });
    console.log(`[billing] ${session.shop} cancelled ${active.plan} (${result.status})`);
    return new Response(JSON.stringify({ cancelled: true, status: result.status }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (mode === 'downgrade') {
    const toPlan = String(formData.get("toPlan") ?? "");
    if (!(VALID_DOWNGRADE_TARGETS as readonly string[]).includes(toPlan)) {
      return new Response(JSON.stringify({ error: "invalid_to_plan" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const change = await scheduleDowngrade({
      shop: session.shop,
      fromPlan: active.plan,
      toPlan,
      effectiveAt: active.currentPeriodEnd,
    });
    console.log(`[billing] ${session.shop} scheduled downgrade ${active.plan} → ${toPlan} at ${change.effectiveAt.toISOString()}`);
    return new Response(JSON.stringify({
      scheduled: true,
      effectiveAt: change.effectiveAt.toISOString(),
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "invalid_mode" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
};
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm run test:integration -- billing-cancel-route`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add app/routes/api.billing.cancel.tsx app/lib/__tests__/integration/billing-cancel-route.test.ts
git commit -m "feat(billing): /api/billing/cancel action route (immediate + scheduled downgrade)"
```

---

## Task 5: Entitlements React context

**Files:**
- Create: `app/lib/billing/entitlements-context.tsx`

This module provides a React context to make `Entitlements` available throughout the embedded app without prop drilling.

- [ ] **Step 1: Implement the context (no test — pure plumbing)**

Create `app/lib/billing/entitlements-context.tsx`:

```typescript
import { createContext, useContext, type ReactNode } from "react";
import type { Entitlements } from "./entitlements";

const EntitlementsContext = createContext<Entitlements | null>(null);

export function EntitlementsProvider({
  value,
  children,
}: {
  value: Entitlements;
  children: ReactNode;
}) {
  return (
    <EntitlementsContext.Provider value={value}>
      {children}
    </EntitlementsContext.Provider>
  );
}

/**
 * Hook to read the current shop's entitlements. Throws if used outside
 * a provider — defensive: every page rendered under `/app/*` must have
 * the provider mounted by the root loader (`app.tsx`).
 */
export function useEntitlements(): Entitlements {
  const ctx = useContext(EntitlementsContext);
  if (!ctx) {
    throw new Error("useEntitlements must be used within EntitlementsProvider");
  }
  return ctx;
}
```

- [ ] **Step 2: Commit**

```bash
git add app/lib/billing/entitlements-context.tsx
git commit -m "feat(billing): React context provider for entitlements"
```

---

## Task 6: UI components — top bar counter, banners, modal

**Files:**
- Create: `app/components/billing/TopBarCounter.tsx`
- Create: `app/components/billing/QuotaBanner.tsx`
- Create: `app/components/billing/TrialBanner.tsx`
- Create: `app/components/billing/QuotaExceededModal.tsx`

These are presentational components that read from `useEntitlements()`. No tests in this task — they are tested visually via the manual end-to-end pass at the end of Phase 3.

- [ ] **Step 1: Create the components directory if absent**

Run: `New-Item -ItemType Directory -Path app\components\billing -Force | Out-Null`

- [ ] **Step 2: Create `TopBarCounter.tsx`**

```typescript
import { useEntitlements } from "../../lib/billing/entitlements-context";
import { useTranslation } from "react-i18next";

/**
 * Permanent counter visible on every page of the app.
 * Shows: "47 / 50 drafts" with color pastille, or "Trial — 9 days left", or "0 / 50 — quota reached".
 *
 * Internal shops (state=internal) hide the widget entirely (would always read 0/∞).
 */
export function TopBarCounter() {
  const ent = useEntitlements();
  const { t } = useTranslation();

  if (ent.state === 'internal') return null;

  if (ent.state === 'trial_active') {
    return (
      <div style={styles.wrapper}>
        <span style={styles.dotInfo} />
        <span style={styles.label}>
          {t('billing.trialDaysLeft', { count: ent.trialDaysRemaining ?? 0 })}
        </span>
      </div>
    );
  }

  if (ent.state === 'trial_expired') {
    return (
      <div style={styles.wrapper}>
        <span style={styles.dotExceeded} />
        <span style={styles.label}>{t('billing.trialExpired')}</span>
      </div>
    );
  }

  // paid_active
  const { used, limit, level } = ent.quotaStatus;
  const dot = level === 'exceeded' ? styles.dotExceeded
            : level === 'critical' ? styles.dotCritical
            : level === 'warning'  ? styles.dotWarning
            : styles.dotOk;

  return (
    <div style={styles.wrapper}>
      <span style={dot} />
      <span style={styles.label}>
        {t('billing.draftsCount', { used, limit: Number.isFinite(limit) ? limit : '∞' })}
      </span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    fontSize: 13,
    fontFamily: 'system-ui, sans-serif',
    color: '#1f2937',
  },
  label: { fontVariantNumeric: 'tabular-nums' },
  dotOk:        { width: 8, height: 8, borderRadius: '50%', background: '#16a34a' },
  dotWarning:   { width: 8, height: 8, borderRadius: '50%', background: '#eab308' },
  dotCritical:  { width: 8, height: 8, borderRadius: '50%', background: '#f97316' },
  dotExceeded:  { width: 8, height: 8, borderRadius: '50%', background: '#dc2626' },
  dotInfo:      { width: 8, height: 8, borderRadius: '50%', background: '#2563eb' },
};
```

- [ ] **Step 3: Create `QuotaBanner.tsx`**

```typescript
import { useEntitlements } from "../../lib/billing/entitlements-context";
import { useTranslation } from "react-i18next";
import { useState, useEffect } from "react";

const DISMISS_KEY = (shop: string, periodStart: string, level: string) =>
  `automail_quota_dismiss_${shop}_${periodStart}_${level}`;

/**
 * Top-of-page banner reflecting the quota level.
 * - warning (80%): yellow, dismissible per period
 * - critical (95%): orange, dismissible per period
 * - exceeded (100%): red, NOT dismissible
 *
 * Hidden during trial (use TrialBanner instead).
 */
export function QuotaBanner() {
  const ent = useEntitlements();
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);

  const periodKey = ent.quotaStatus.periodStart.toISOString();
  const level = ent.quotaStatus.level;
  const storageKey = DISMISS_KEY(ent.shop, periodKey, level);

  useEffect(() => {
    if (level === 'exceeded') {
      setDismissed(false);
      return;
    }
    setDismissed(localStorage.getItem(storageKey) === '1');
  }, [storageKey, level]);

  if (ent.state !== 'paid_active') return null;
  if (level === 'ok') return null;
  if (dismissed && level !== 'exceeded') return null;

  const handleDismiss = () => {
    localStorage.setItem(storageKey, '1');
    setDismissed(true);
  };

  const palette = {
    warning: { bg: '#fef9c3', fg: '#854d0e', border: '#fde047' },
    critical: { bg: '#ffedd5', fg: '#9a3412', border: '#fdba74' },
    exceeded: { bg: '#fee2e2', fg: '#991b1b', border: '#fca5a5' },
    ok: { bg: '', fg: '', border: '' },
  }[level];

  return (
    <div role="alert" style={{
      background: palette.bg,
      color: palette.fg,
      border: `1px solid ${palette.border}`,
      padding: '8px 14px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      fontSize: 14,
    }}>
      <span>{t(`billing.banner.${level}`, { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit })}</span>
      <span style={{ display: 'flex', gap: 12 }}>
        <a href="/app/billing" style={{ color: 'inherit', fontWeight: 600 }}>
          {t('billing.upgradeCta')}
        </a>
        {level !== 'exceeded' && (
          <button onClick={handleDismiss} style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
          }}>×</button>
        )}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Create `TrialBanner.tsx`**

```typescript
import { useEntitlements } from "../../lib/billing/entitlements-context";
import { useTranslation } from "react-i18next";

/**
 * Banner shown during trial states.
 * - trial_active: blue info banner with countdown + CTA to choose plan
 * - trial_expired: red blocking banner with CTA
 */
export function TrialBanner() {
  const ent = useEntitlements();
  const { t } = useTranslation();

  if (ent.state === 'trial_active') {
    return (
      <div role="status" style={{
        background: '#dbeafe',
        color: '#1e3a8a',
        border: '1px solid #93c5fd',
        padding: '8px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 14,
      }}>
        <span>{t('billing.trial.activeBanner', { count: ent.trialDaysRemaining ?? 0 })}</span>
        <a href="/app/billing" style={{ color: 'inherit', fontWeight: 600 }}>
          {t('billing.choosePlan')}
        </a>
      </div>
    );
  }

  if (ent.state === 'trial_expired') {
    return (
      <div role="alert" style={{
        background: '#fee2e2',
        color: '#991b1b',
        border: '1px solid #fca5a5',
        padding: '8px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 14,
      }}>
        <span>{t('billing.trial.expiredBanner')}</span>
        <a href="/app/billing" style={{ color: 'inherit', fontWeight: 600 }}>
          {t('billing.choosePlan')}
        </a>
      </div>
    );
  }

  return null;
}
```

- [ ] **Step 5: Create `QuotaExceededModal.tsx`**

```typescript
import { useTranslation } from "react-i18next";
import { useState } from "react";

/**
 * Controlled modal shown by call sites when a generation attempt is blocked.
 * Caller passes `open` and `onClose` and optionally a custom message variant.
 */
export function QuotaExceededModal(props: {
  open: boolean;
  onClose: () => void;
  variant?: 'exceeded' | 'just_used_last';
  used?: number;
  limit?: number;
}) {
  const { t } = useTranslation();
  if (!props.open) return null;

  const variant = props.variant ?? 'exceeded';
  const titleKey = variant === 'just_used_last' ? 'billing.modal.lastUsedTitle' : 'billing.modal.exceededTitle';
  const bodyKey = variant === 'just_used_last' ? 'billing.modal.lastUsedBody' : 'billing.modal.exceededBody';

  return (
    <div style={overlay} onClick={props.onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>
          {t(titleKey, { used: props.used ?? 0, limit: props.limit ?? 0 })}
        </h2>
        <p style={{ margin: '0 0 20px', fontSize: 14, color: '#374151' }}>
          {t(bodyKey, { used: props.used ?? 0, limit: props.limit ?? 0 })}
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button onClick={props.onClose} style={btnSecondary}>
            {t('billing.modal.later')}
          </button>
          <a href="/app/billing" style={btnPrimary}>
            {t('billing.modal.viewPlans')}
          </a>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
};

const modal: React.CSSProperties = {
  background: 'white',
  borderRadius: 8,
  padding: '24px 28px',
  maxWidth: 460,
  width: '90%',
  boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
  fontFamily: 'system-ui, sans-serif',
};

const btnPrimary: React.CSSProperties = {
  background: '#1f2937',
  color: 'white',
  padding: '8px 16px',
  borderRadius: 6,
  textDecoration: 'none',
  fontSize: 14,
  fontWeight: 600,
};

const btnSecondary: React.CSSProperties = {
  background: 'transparent',
  color: '#374151',
  padding: '8px 16px',
  borderRadius: 6,
  fontSize: 14,
  border: '1px solid #d1d5db',
  cursor: 'pointer',
};
```

- [ ] **Step 6: Commit**

```bash
git add app/components/billing/
git commit -m "feat(billing): UI components (counter, banners, modal)"
```

---

## Task 7: Page `app.billing.tsx`

**Files:**
- Create: `app/routes/app.billing.tsx`

The page renders:
- Current plan + state (trial active/expired, paid, scheduled downgrade pending)
- Comparison table Starter vs Pro with current plan highlighted
- Subscribe / Upgrade / Downgrade / Cancel buttons posting to the API routes
- Success banner if `?subscribed=1` is in the URL (after Shopify confirmation redirect)

- [ ] **Step 1: Implement the page**

Create `app/routes/app.billing.tsx`:

```typescript
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useEffect } from "react";

import { authenticate } from "../shopify.server";
import { resolveEntitlements } from "../lib/billing/entitlements";
import { getPendingChange } from "../lib/billing/scheduled-changes";
import { PLANS } from "../lib/billing/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const ent = await resolveEntitlements({ shop: session.shop, admin });
  const pendingChange = await getPendingChange(session.shop);
  return {
    entitlements: {
      state: ent.state,
      planId: ent.planId,
      trialDaysRemaining: ent.trialDaysRemaining,
      trialExpiresAt: ent.trialExpiresAt?.toISOString() ?? null,
      quotaStatus: { ...ent.quotaStatus, periodStart: ent.quotaStatus.periodStart.toISOString() },
      mailboxStatus: ent.mailboxStatus,
    },
    pendingChange: pendingChange
      ? {
          fromPlan: pendingChange.fromPlan,
          toPlan: pendingChange.toPlan,
          effectiveAt: pendingChange.effectiveAt.toISOString(),
        }
      : null,
  };
};

export default function BillingPage() {
  const { entitlements, pendingChange } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const subscribeFetcher = useFetcher<{ confirmationUrl?: string; error?: string }>();
  const cancelFetcher = useFetcher<{ cancelled?: boolean; scheduled?: boolean; error?: string }>();
  const [searchParams] = useSearchParams();
  const justSubscribed = searchParams.get('subscribed') === '1';

  // After subscribe action returns confirmationUrl, redirect top-level so Shopify can render the confirmation.
  useEffect(() => {
    const url = subscribeFetcher.data?.confirmationUrl;
    if (url) window.top!.location.href = url;
  }, [subscribeFetcher.data]);

  const subscribe = (planId: 'starter' | 'pro') => {
    const fd = new FormData();
    fd.set('planId', planId);
    subscribeFetcher.submit(fd, { method: 'POST', action: '/api/billing/subscribe' });
  };

  const cancel = (mode: 'immediate' | 'downgrade', toPlan?: string) => {
    const fd = new FormData();
    fd.set('mode', mode);
    if (toPlan) fd.set('toPlan', toPlan);
    cancelFetcher.submit(fd, { method: 'POST', action: '/api/billing/cancel' });
  };

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0 }}>{t('billing.page.title')}</h1>

      {justSubscribed && (
        <div style={{ background: '#dcfce7', color: '#14532d', padding: '10px 14px', borderRadius: 6, marginBottom: 20 }}>
          {t('billing.page.subscribedSuccess')}
        </div>
      )}

      {pendingChange && (
        <div style={{ background: '#fef9c3', color: '#854d0e', padding: '10px 14px', borderRadius: 6, marginBottom: 20 }}>
          {t('billing.page.scheduledChangeNotice', {
            fromPlan: pendingChange.fromPlan,
            toPlan: pendingChange.toPlan,
            date: new Date(pendingChange.effectiveAt).toLocaleDateString(),
          })}
          <button
            onClick={() => cancelFetcher.submit(new FormData(), { method: 'POST', action: '/api/billing/cancel-scheduled' })}
            style={{ marginLeft: 16, fontWeight: 600 }}
          >
            {t('billing.page.cancelScheduled')}
          </button>
        </div>
      )}

      <p>{t('billing.page.currentState', { state: entitlements.state, plan: entitlements.planId ?? '—' })}</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 32 }}>
        <PlanCard
          planId="starter"
          isCurrent={entitlements.planId === 'starter'}
          onSubscribe={() => subscribe('starter')}
          onDowngrade={() => cancel('downgrade', 'starter')}
          loading={subscribeFetcher.state !== 'idle' || cancelFetcher.state !== 'idle'}
          showDowngrade={entitlements.planId === 'pro'}
        />
        <PlanCard
          planId="pro"
          isCurrent={entitlements.planId === 'pro'}
          onSubscribe={() => subscribe('pro')}
          onDowngrade={() => {}}
          loading={subscribeFetcher.state !== 'idle' || cancelFetcher.state !== 'idle'}
          showDowngrade={false}
        />
      </div>

      {(entitlements.state === 'paid_active') && (
        <div style={{ marginTop: 32 }}>
          <button onClick={() => cancel('immediate')} style={{ color: '#991b1b' }}>
            {t('billing.page.cancelSubscription')}
          </button>
        </div>
      )}
    </div>
  );
}

function PlanCard(props: {
  planId: 'starter' | 'pro';
  isCurrent: boolean;
  onSubscribe: () => void;
  onDowngrade: () => void;
  loading: boolean;
  showDowngrade: boolean;
}) {
  const { t } = useTranslation();
  const plan = PLANS[props.planId];

  return (
    <div style={{
      border: props.isCurrent ? '2px solid #1f2937' : '1px solid #d1d5db',
      borderRadius: 8,
      padding: '20px 24px',
    }}>
      <h2 style={{ marginTop: 0, textTransform: 'capitalize' }}>{props.planId}</h2>
      <p style={{ fontSize: 28, fontWeight: 700 }}>${plan.priceUsd}<span style={{ fontSize: 14, fontWeight: 400 }}>/mo</span></p>
      <ul style={{ paddingLeft: 18 }}>
        <li>{t('billing.plan.draftsPerMonth', { count: plan.draftsPerMonth })}</li>
        <li>{t('billing.plan.maxMailboxes', { count: plan.maxMailboxes })}</li>
        <li>{plan.advancedDashboard ? t('billing.plan.advancedDashboard') : t('billing.plan.basicDashboard')}</li>
        <li>{t('billing.plan.dashboardRange', { count: plan.dashboardMaxRangeDays })}</li>
      </ul>
      {props.isCurrent ? (
        <p style={{ color: '#16a34a', fontWeight: 600 }}>{t('billing.plan.currentPlan')}</p>
      ) : props.showDowngrade ? (
        <button onClick={props.onDowngrade} disabled={props.loading} style={{ width: '100%' }}>
          {t('billing.plan.downgradeBtn')}
        </button>
      ) : (
        <button onClick={props.onSubscribe} disabled={props.loading} style={{ width: '100%', background: '#1f2937', color: 'white', padding: '8px 16px', borderRadius: 6 }}>
          {props.loading ? t('billing.plan.processing') : t('billing.plan.subscribeBtn')}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/routes/app.billing.tsx
git commit -m "feat(billing): /app/billing page with plan selector"
```

---

## Task 8: i18n strings (EN + FR)

**Files:**
- Modify: `app/i18n/locales/en.json`
- Modify: `app/i18n/locales/fr.json`

- [ ] **Step 1: Open `app/i18n/locales/en.json` and add a `billing` namespace**

Add the following at the top level of the JSON object (alongside existing keys like `nav`, `inbox`, etc.):

```json
"billing": {
  "trialDaysLeft_one": "Trial — {{count}} day left",
  "trialDaysLeft_other": "Trial — {{count}} days left",
  "trialExpired": "Trial expired",
  "draftsCount": "{{used}} / {{limit}} drafts",
  "upgradeCta": "Upgrade",
  "choosePlan": "Choose a plan",
  "trial": {
    "activeBanner_one": "You have {{count}} day left in your trial. Choose a plan to continue past it.",
    "activeBanner_other": "You have {{count}} days left in your trial. Choose a plan to continue past it.",
    "expiredBanner": "Your trial has ended. Choose a plan to continue using Automail."
  },
  "banner": {
    "warning": "You've used {{used}} of {{limit}} drafts this month.",
    "critical": "Almost out of quota: {{used}} of {{limit}} drafts used this month.",
    "exceeded": "Quota reached ({{used}} / {{limit}}) — sync paused. Upgrade to continue."
  },
  "modal": {
    "exceededTitle": "Quota reached for this month ({{used}} / {{limit}} drafts)",
    "exceededBody": "Upgrade to Pro to continue immediately, or wait until next month for the reset.",
    "lastUsedTitle": "You just used your last draft of the month",
    "lastUsedBody": "{{used}} of {{limit}} drafts used. Generation is paused until next month or upgrade.",
    "later": "Later",
    "viewPlans": "View plans"
  },
  "page": {
    "title": "Billing",
    "subscribedSuccess": "Subscription activated. Welcome aboard!",
    "scheduledChangeNotice": "Plan {{fromPlan}} active until {{date}}. Switching to {{toPlan}} after.",
    "cancelScheduled": "Cancel this change",
    "currentState": "Current state: {{state}} — plan: {{plan}}",
    "cancelSubscription": "Cancel subscription"
  },
  "plan": {
    "draftsPerMonth_one": "{{count}} draft / month",
    "draftsPerMonth_other": "{{count}} drafts / month",
    "maxMailboxes_one": "{{count}} connected mailbox",
    "maxMailboxes_other": "{{count}} connected mailboxes",
    "advancedDashboard": "Full dashboard (heatmap, alerts, reopened, comparisons)",
    "basicDashboard": "Basic dashboard (KPIs only)",
    "dashboardRange_one": "Up to {{count}} day of history",
    "dashboardRange_other": "Up to {{count}} days of history",
    "currentPlan": "Your current plan",
    "subscribeBtn": "Subscribe",
    "downgradeBtn": "Downgrade",
    "processing": "Processing…"
  }
}
```

- [ ] **Step 2: Open `app/i18n/locales/fr.json` and add the same namespace with French translations**

```json
"billing": {
  "trialDaysLeft_one": "Essai — {{count}} jour restant",
  "trialDaysLeft_other": "Essai — {{count}} jours restants",
  "trialExpired": "Essai terminé",
  "draftsCount": "{{used}} / {{limit}} brouillons",
  "upgradeCta": "Passer à Pro",
  "choosePlan": "Choisir un plan",
  "trial": {
    "activeBanner_one": "Il te reste {{count}} jour d'essai. Choisis un plan pour continuer au-delà.",
    "activeBanner_other": "Il te reste {{count}} jours d'essai. Choisis un plan pour continuer au-delà.",
    "expiredBanner": "Ton essai est terminé. Choisis un plan pour continuer à utiliser Automail."
  },
  "banner": {
    "warning": "Tu as utilisé {{used}} de tes {{limit}} brouillons ce mois-ci.",
    "critical": "Presque à court : {{used}} brouillons utilisés sur {{limit}} ce mois-ci.",
    "exceeded": "Quota atteint ({{used}} / {{limit}}) — sync suspendue. Upgrade pour continuer."
  },
  "modal": {
    "exceededTitle": "Quota atteint pour ce mois ({{used}} / {{limit}} brouillons)",
    "exceededBody": "Upgrade vers Pro pour continuer immédiatement, ou attends le 1er du mois prochain pour le reset.",
    "lastUsedTitle": "Tu viens d'utiliser ton dernier brouillon du mois",
    "lastUsedBody": "{{used}} brouillons utilisés sur {{limit}}. Génération en pause jusqu'au prochain mois ou upgrade.",
    "later": "Plus tard",
    "viewPlans": "Voir les plans"
  },
  "page": {
    "title": "Abonnement",
    "subscribedSuccess": "Abonnement activé. Bienvenue !",
    "scheduledChangeNotice": "Plan {{fromPlan}} actif jusqu'au {{date}}. Passage à {{toPlan}} ensuite.",
    "cancelScheduled": "Annuler ce changement",
    "currentState": "État courant : {{state}} — plan : {{plan}}",
    "cancelSubscription": "Annuler l'abonnement"
  },
  "plan": {
    "draftsPerMonth_one": "{{count}} brouillon / mois",
    "draftsPerMonth_other": "{{count}} brouillons / mois",
    "maxMailboxes_one": "{{count}} boîte mail connectée",
    "maxMailboxes_other": "{{count}} boîtes mail connectées",
    "advancedDashboard": "Dashboard complet (heatmap, alertes, reopened, comparaisons)",
    "basicDashboard": "Dashboard basique (KPIs uniquement)",
    "dashboardRange_one": "Jusqu'à {{count}} jour d'historique",
    "dashboardRange_other": "Jusqu'à {{count}} jours d'historique",
    "currentPlan": "Ton plan actuel",
    "subscribeBtn": "S'abonner",
    "downgradeBtn": "Downgrade",
    "processing": "Traitement…"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add app/i18n/locales/
git commit -m "feat(billing): EN+FR i18n strings for billing UI"
```

---

## Task 9: Wire entitlements into root layout `app.tsx`

**Files:**
- Modify: `app/routes/app.tsx`

The root layout needs to:
1. Load entitlements once per request (cached for the duration of the request)
2. Inject them via `EntitlementsProvider`
3. Mount `<TopBarCounter>`, `<TrialBanner>`, `<QuotaBanner>` above the page content
4. Add a billing nav link

- [ ] **Step 1: Update `app.tsx`**

Read the current file `app/routes/app.tsx`. Apply these specific changes:

**a) Update the loader** to also fetch entitlements:

Replace the existing loader return:

```typescript
return { apiKey: process.env.SHOPIFY_API_KEY || "", uiLanguage, isE2E };
```

With:

```typescript
const { resolveEntitlements } = await import("../lib/billing/entitlements");
const ent = await resolveEntitlements({ shop: session.shop, admin: (await authenticate.admin(effectiveRequest)).admin });
return {
  apiKey: process.env.SHOPIFY_API_KEY || "",
  uiLanguage,
  isE2E,
  entitlements: {
    shop: ent.shop,
    state: ent.state,
    planId: ent.planId,
    plan: ent.plan,
    canGenerateDraft: ent.canGenerateDraft,
    canConnectMailbox: ent.canConnectMailbox,
    canViewAdvancedDashboard: ent.canViewAdvancedDashboard,
    trialDaysRemaining: ent.trialDaysRemaining,
    trialExpiresAt: ent.trialExpiresAt?.toISOString() ?? null,
    quotaStatus: { ...ent.quotaStatus, periodStart: ent.quotaStatus.periodStart.toISOString() },
    mailboxStatus: ent.mailboxStatus,
    dashboardMaxRangeDays: ent.dashboardMaxRangeDays,
  },
};
```

**Important note on the loader**: the existing code calls `authenticate.admin(effectiveRequest)` once at the top to get `session, sessionToken`. We need the `admin` graphql client too. Modify the destructure:

```typescript
const { session, sessionToken, admin } = await authenticate.admin(effectiveRequest);
```

Then in the entitlements call use that `admin` directly:

```typescript
const { resolveEntitlements } = await import("../lib/billing/entitlements");
const ent = await resolveEntitlements({ shop: session.shop, admin });
```

**b) In the default export `App()`**, wrap `<Outlet />` in `<EntitlementsProvider>` and mount the banners + counter:

Replace the existing return statement with:

```tsx
return (
  <AppProvider embedded={!isE2E} apiKey={apiKey}>
    {/* @ts-expect-error react-i18next default mistypes children */}
    <EntitlementsProvider value={{
      ...entitlements,
      // Re-hydrate Date objects from ISO strings
      trialExpiresAt: entitlements.trialExpiresAt ? new Date(entitlements.trialExpiresAt) : null,
      quotaStatus: { ...entitlements.quotaStatus, periodStart: new Date(entitlements.quotaStatus.periodStart) },
    }}>
      <s-app-nav name="Automail">
        <s-link href="/app">{t("nav.home")}</s-link>
        <s-link href="/app/inbox">{t("nav.emailInbox")}</s-link>
        <s-link href="/app/dashboard">{t("nav.dashboard")}</s-link>
        <s-link href="/app/settings">{t("nav.settings")}</s-link>
        <s-link href="/app/billing">{t("nav.billing")}</s-link>
        <s-link href="/app/help">{t("nav.help")}</s-link>
      </s-app-nav>
      <div style={{ position: 'sticky', top: 0, zIndex: 100, background: 'white' }}>
        <TrialBanner />
        <QuotaBanner />
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 14px' }}>
          <TopBarCounter />
        </div>
      </div>
      <Outlet />
    </EntitlementsProvider>
  </AppProvider>
);
```

**c) Add the imports at the top of the file**:

```typescript
import { EntitlementsProvider } from "../lib/billing/entitlements-context";
import { TopBarCounter } from "../components/billing/TopBarCounter";
import { QuotaBanner } from "../components/billing/QuotaBanner";
import { TrialBanner } from "../components/billing/TrialBanner";
```

**d) Add a `billing` nav key in i18n**: in both `en.json` and `fr.json`, inside the `nav` namespace, add:

```json
"billing": "Billing"  // or "Abonnement" in fr.json
```

- [ ] **Step 2: Run typecheck and existing tests**

Run: `npm run typecheck`
Expected: No new errors. Pre-existing errors (unrelated routes) remain.

Run: `npm test`
Expected: All existing unit tests still pass.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.tsx app/i18n/locales/
git commit -m "feat(billing): wire entitlements into root layout (counter + banners + nav)"
```

---

## Phase 2 wrap-up

- [ ] **Step 1: Verify all tests still green**

```bash
npm test
npm run test:integration -- billing
```

Expected:
- Unit billing tests: all passing (was 20 after Phase 1, now should be 25 — added 5 in Task 1)
- Integration billing tests: all passing (was 27 after Phase 1, now should be 34 — added 1+3+3 in Tasks 2-4)

- [ ] **Step 2: Sanity-check the file structure**

Run (PowerShell):

```
Get-ChildItem -Recurse app\components\billing | Select-Object -ExpandProperty FullName
Get-ChildItem -Recurse app\lib\billing | Select-Object -ExpandProperty FullName
Get-ChildItem app\routes\*billing* , app\routes\*subscriptions* | Select-Object -ExpandProperty Name
```

Expected file presence:
- `TopBarCounter.tsx`, `QuotaBanner.tsx`, `TrialBanner.tsx`, `QuotaExceededModal.tsx`
- `shopify-billing.ts`, `entitlements-context.tsx`
- `api.billing.subscribe.tsx`, `api.billing.cancel.tsx`, `app.billing.tsx`, `webhooks.app_subscriptions.update.tsx`

- [ ] **Step 3: Verify the webhook is registered**

Read `shopify.app.toml` and confirm the new `app_subscriptions/update` block exists.

---

## Out of scope for Phase 2

- **Phase 3:** Wire `entitlements.canGenerateDraft` into `api.reply-draft.tsx`, `app.support.tsx`, `refine-draft.ts`, `mail-auth.tsx`, `app.dashboard.tsx`. The actual quota counter doesn't change yet at draft time.
- **Phase 4:** auto-sync suspend/resume + 48h zone catch-up + folder "À analyser" UI.
- **Phase 5:** migration of existing shops, full UI cleanup of autoDraft references in `app.settings.tsx`, privacy policy update.

## Self-review notes

- Spec coverage: Shopify Billing flows (Tasks 1, 3, 4), webhook for cache invalidation (Task 2), context plumbing (Task 5), all UI components for quota communication (Task 6), billing page (Task 7), i18n (Task 8), root layout integration (Task 9). ✅
- Type consistency: `Entitlements`, `PlanId`, `QuotaStatus`, `QuotaLevel` re-used from Phase 1 throughout.
- No "TBD" or placeholder code — all UI components have full inline styles or ref to imported styles.
- One small dependency between tasks: Task 9 depends on Tasks 5, 6 (context + components must exist). Tasks 1-4 can run in any order. Task 7 depends on Task 5 (context — actually no, the page reads from loader directly, not context — clarified inline).
- Tests for components are intentionally deferred to manual end-to-end (Phase 3 wrap-up). Unit-testing React components with full styling and i18n is high overhead for low value at this stage.
