import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { storage } from "../lib/attachments/storage";

/**
 * GDPR: shop/redact
 *
 * Fires 48 hours after a shop uninstalls the app. We must delete every
 * piece of shop-scoped data we hold — both database rows AND files on
 * disk (attachment uploads).
 *
 * Order:
 *  1. Wipe attachment files on disk under uploads/{shop}/ before any DB
 *     row goes away (otherwise we lose the storagePaths needed to find
 *     the files).
 *  2. Delete every shop-keyed table. Where Prisma cascades exist
 *     (Thread → ThreadProviderId, ThreadStateHistory; IncomingEmail →
 *     IncomingEmailAttachment, ReplyDraft → DraftAttachment), parent
 *     deletion is enough. Tables not on a cascade chain are deleted
 *     explicitly.
 *
 * RateLimitBucket is keyed on (key, kind) where `key` is the shop domain
 * for per-shop limits — wipe rows whose key matches the shop.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  console.log(`[webhook] ${topic} shop=${shop} — wiping all shop data and files`);

  // 1. Files on disk first.
  try {
    await storage.removeShopDir(shop);
  } catch (err) {
    console.error(`[webhook] shop/redact: failed to remove uploads dir for ${shop}:`, err);
    // Continue with DB teardown — we don't want to block the redact on a
    // disk failure. Operator must clean up uploads/{shop}/ manually.
  }

  // 2. DB tables. Order matters only where cascades exist.
  await db.llmCallLog.deleteMany({ where: { shop } });
  // Deleting IncomingEmail cascades → IncomingEmailAttachment + ReplyDraft → DraftAttachment.
  await db.incomingEmail.deleteMany({ where: { shop } });
  // Deleting Thread cascades → ThreadProviderId + ThreadStateHistory.
  await db.thread.deleteMany({ where: { shop } });
  await db.syncJob.deleteMany({ where: { shop } });
  await db.mailConnection.deleteMany({ where: { shop } });
  await db.supportSettings.deleteMany({ where: { shop } });
  await db.userPreference.deleteMany({ where: { shop } });
  await db.billingUsage.deleteMany({ where: { shop } });
  await db.billingScheduledChange.deleteMany({ where: { shop } });
  await db.rateLimitBucket.deleteMany({ where: { key: shop } });
  await db.session.deleteMany({ where: { shop } });
  // GDPR: full teardown. ShopFlag holds firstInstallDate, onboarding state,
  // and the isInternal bypass — none of which we may keep after redact.
  await db.shopFlag.deleteMany({ where: { shop } });

  return new Response();
};
