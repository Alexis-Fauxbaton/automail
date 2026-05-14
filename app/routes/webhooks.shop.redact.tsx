import type { ActionFunctionArgs } from "react-router";
import path from "node:path";
import fs from "node:fs/promises";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { storage } from "../lib/attachments/storage";
import { invalidateCache as invalidateSubscriptionCache } from "../lib/billing/subscription";
import { invalidateCustomerEmailsCache } from "../lib/gmail/customers";

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

  // 2. GDPR exports written by customers/data_request live under
  //    data-requests/{shop}/... — these contain personal data and must be
  //    wiped along with the rest. Guard against path traversal via a
  //    base-directory check, identical to what storage.removeShopDir does.
  try {
    const dataRequestsBase = path.resolve(process.cwd(), "data-requests");
    const shopDir = path.resolve(dataRequestsBase, shop);
    if (
      shopDir.startsWith(dataRequestsBase + path.sep) ||
      shopDir === dataRequestsBase
    ) {
      // Refuse if the resolved path somehow equals the base (e.g. empty shop).
      if (shopDir !== dataRequestsBase) {
        await fs.rm(shopDir, { recursive: true, force: true });
      }
    } else {
      console.warn(
        `[webhook] shop/redact: refused to remove data-requests path outside base for shop=${shop}`,
      );
    }
  } catch (err) {
    console.error(`[webhook] shop/redact: failed to remove data-requests dir for ${shop}:`, err);
  }

  // 3. DB tables. Order matters only where cascades exist.
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

  invalidateSubscriptionCache(shop);
  invalidateCustomerEmailsCache(shop);

  return new Response();
};
