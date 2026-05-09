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
  // billing_status=pending lets the billing page distinguish "merchant came
  // back after approving" from "merchant came back after declining". The loader
  // checks whether an active subscription now exists to resolve which case it is.
  const returnUrl = `${appUrl}/app/billing?billing_status=pending`;
  // eslint-disable-next-line no-undef
  const isTest = process.env.NODE_ENV !== "production";

  console.log(`[billing] ${session.shop} subscribe attempt: planId=${planId}, returnUrl=${returnUrl}, test=${isTest}`);

  try {
    const result = await createSubscription({
      admin,
      planId,
      returnUrl,
      test: isTest,
    });

    console.log(`[billing] ${session.shop} subscribed to ${planId} (test=${isTest}) → ${result.subscriptionId}`);

    return new Response(JSON.stringify({ confirmationUrl: result.confirmationUrl }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[billing] ${session.shop} subscribe FAILED: ${message}`);
    return new Response(JSON.stringify({ error: "subscribe_failed", message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
