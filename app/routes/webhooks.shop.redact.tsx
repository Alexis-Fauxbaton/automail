import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * GDPR: shop/redact
 *
 * Fires 48 hours after a shop uninstalls the app. We must delete all data
 * we hold about that shop. Every shop-scoped table is wiped here.
 *
 * Note: app/uninstalled already clears the Session row on install removal.
 * This handler is the full teardown — everything else keyed by `shop`.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  console.log(`[webhook] ${topic} shop=${shop} — wiping all shop data`);

  // Order matters only where FK relations exist; most tables key off `shop`
  // directly. Deleting emails before threads avoids dangling FK on
  // IncomingEmail.canonicalThreadId (onDelete: SetNull handles it anyway).
  await db.llmCallLog.deleteMany({ where: { shop } });
  await db.incomingEmail.deleteMany({ where: { shop } });
  await db.threadProviderId.deleteMany({ where: { shop } });
  await db.thread.deleteMany({ where: { shop } });
  await db.syncJob.deleteMany({ where: { shop } });
  await db.mailConnection.deleteMany({ where: { shop } });
  await db.supportSettings.deleteMany({ where: { shop } });
  await db.session.deleteMany({ where: { shop } });

  return new Response();
};
