import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { invalidateCache as invalidateSubscriptionCache } from "../lib/billing/subscription";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await db.$transaction([
    db.syncJob.deleteMany({ where: { shop } }),
    db.llmCallLog.deleteMany({ where: { shop } }),
    // Cascades: IncomingEmail → IncomingEmailAttachment + ReplyDraft → DraftAttachment.
    db.incomingEmail.deleteMany({ where: { shop } }),
    // Cascades: Thread → ThreadProviderId + ThreadStateHistory.
    db.thread.deleteMany({ where: { shop } }),
    db.mailConnection.deleteMany({ where: { shop } }),
    db.supportSettings.deleteMany({ where: { shop } }),
    db.userPreference.deleteMany({ where: { shop } }),
    db.billingScheduledChange.deleteMany({ where: { shop } }),
    db.rateLimitBucket.deleteMany({ where: { key: shop } }),
    db.session.deleteMany({ where: { shop } }),
    // Clear onboarding state so a reinstall re-shows the wizard.
    // firstInstallDate is preserved on purpose: it anchors the trial and
    // must not reset on uninstall/reinstall (otherwise trial is abusable).
    // BillingUsage is also kept: usage history is required for billing
    // audit even after uninstall. The full delete happens at shop/redact (48h later).
    db.shopFlag.updateMany({
      where: { shop },
      data: { onboardingCompletedAt: null, checklistDismissedAt: null },
    }),
  ]);

  // Drop the in-process subscription cache for this shop so a reinstall
  // within the cache TTL doesn't see stale entitlements.
  invalidateSubscriptionCache(shop);

  return new Response();
};
