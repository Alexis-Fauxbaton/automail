import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveActivePlan } from "../lib/billing/subscription";
import { cancelSubscription } from "../lib/billing/shopify-billing";
import { scheduleDowngrade, cancelScheduledChange } from "../lib/billing/scheduled-changes";
import { checkRateLimit } from "../lib/rate-limit";

const VALID_DOWNGRADE_TARGETS = ['starter'] as const;

// Tight cap: cancellation/downgrade is a once-in-a-lifetime user action.
// 10/min is enough for human retries after a network blip but bounds spam.
const RATE_LIMIT_PER_SHOP_PER_MIN = 10;

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

  const limit = await checkRateLimit({
    key: session.shop,
    kind: "billing-cancel",
    limit: RATE_LIMIT_PER_SHOP_PER_MIN,
    windowMs: 60_000,
  });
  if (!limit.ok) {
    return new Response(
      JSON.stringify({ error: "rate_limited" }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": Math.ceil(limit.resetMs / 1000).toString(),
        },
      },
    );
  }

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

  if (mode === 'cancel_scheduled') {
    await cancelScheduledChange(session.shop);
    console.log(`[billing] ${session.shop} cancelled their scheduled change`);
    return new Response(JSON.stringify({ cancelledScheduled: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "invalid_mode" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
};
