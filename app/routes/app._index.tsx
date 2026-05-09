import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { requireOnboardingComplete } from "../lib/onboarding/guard";

// `application_url` in shopify.app.toml points to /app — Shopify's install
// flow lands here. We redirect to /app/inbox which is the primary feature
// page. When no mail account is connected, /app/inbox renders ConnectionCard
// so the merchant has a clear onboarding path (Gmail / Zoho / Outlook).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireOnboardingComplete(session.shop, request);
  return redirect("/app/inbox");
};
