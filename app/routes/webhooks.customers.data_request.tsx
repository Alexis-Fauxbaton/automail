import type { ActionFunctionArgs } from "react-router";
import * as fs from "node:fs";
import * as path from "node:path";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { piiHash } from "../lib/log/pii";

/**
 * GDPR: customers/data_request
 *
 * Shopify forwards a merchant-initiated request for the data we hold about a
 * specific customer. We have 30 days to respond to the merchant.
 *
 * The only customer PII Automail stores is the content of support emails
 * (`IncomingEmail` rows) where the customer is the sender, plus identifiers
 * that may have been resolved at the thread level. We do not build customer
 * profiles independent of emails.
 *
 * Behaviour:
 *   1. Acknowledge the webhook (signature already verified by Shopify).
 *   2. Build a JSON export of every PII we hold for that customer:
 *        - IncomingEmail rows (subject, body, snippet, fromAddress,
 *          fromName, receivedAt, extractedIdentifiers, analysisResult).
 *        - Thread rows where resolvedEmail matches.
 *        - LlmCallLog rows linked to those emails (no body, just metadata).
 *   3. Persist the export to disk under data-requests/{shop}/{hash}/{ts}.json.
 *      The merchant's support team can retrieve and forward it within the
 *      30-day GDPR window. Folder is created with restrictive perms.
 *   4. Log a one-line audit record so operators know an export was generated.
 *
 * NOTE: There is no in-app dashboard yet for the merchant to download the
 * export themselves — operator manual fulfilment is the MVP path. The export
 * file IS the artefact; without it we have no way to comply.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const customer = (payload as { customer?: { email?: string; id?: number } })
    .customer;

  const customerEmail = customer?.email?.toLowerCase().trim();
  const customerIdHash = customer?.id != null ? piiHash(String(customer.id)) : "?";
  const customerEmailHash = piiHash(customerEmail);

  console.log(
    `[webhook] ${topic} shop=${shop} customerHash=${customerEmailHash} customerIdHash=${customerIdHash}`,
  );

  if (!customerEmail) {
    // No email to look up — nothing we can match against; acknowledge and exit.
    return new Response();
  }

  try {
    // Idempotence: Shopify retries webhooks until it gets a 2xx. Writing a
    // fresh export file on every retry would accumulate duplicates and
    // pollute the operator's fulfilment workflow. Skip if we already wrote
    // one for this customer in the last 5 minutes.
    const baseDirCheck = path.join(process.cwd(), "data-requests", shop, customerEmailHash);
    try {
      const entries = fs.readdirSync(baseDirCheck);
      const fiveMinAgo = Date.now() - 5 * 60_000;
      const hasRecent = entries.some((name) => {
        try {
          const stat = fs.statSync(path.join(baseDirCheck, name));
          return stat.mtimeMs >= fiveMinAgo;
        } catch {
          return false;
        }
      });
      if (hasRecent) {
        console.log(
          `[webhook] customers/data_request: recent export already exists, skipping (shop=${shop} customerHash=${customerEmailHash})`,
        );
        return new Response();
      }
    } catch {
      // Directory doesn't exist yet — first export for this customer, proceed.
    }

    const incomingEmails = await db.incomingEmail.findMany({
      where: {
        shop,
        fromAddress: { equals: customerEmail, mode: "insensitive" },
      },
      select: {
        id: true,
        externalMessageId: true,
        subject: true,
        snippet: true,
        bodyText: true,
        bodyHtml: true,
        fromAddress: true,
        fromName: true,
        receivedAt: true,
        extractedIdentifiers: true,
        analysisResult: true,
        detectedIntent: true,
        analysisConfidence: true,
        labelIds: true,
      },
    });

    const threads = await db.thread.findMany({
      where: {
        shop,
        resolvedEmail: { equals: customerEmail, mode: "insensitive" },
      },
      select: {
        id: true,
        subjectKey: true,
        resolvedOrderNumber: true,
        resolvedTrackingNumber: true,
        resolvedEmail: true,
        resolvedCustomerName: true,
        resolutionConfidence: true,
        firstMessageAt: true,
        lastMessageAt: true,
        messageCount: true,
        supportNature: true,
        operationalState: true,
      },
    });

    const emailIds = incomingEmails.map((e) => e.id);
    const llmCalls = emailIds.length > 0
      ? await db.llmCallLog.findMany({
          where: { shop, emailId: { in: emailIds } },
          select: {
            id: true,
            emailId: true,
            threadId: true,
            callSite: true,
            model: true,
            promptTokens: true,
            completionTokens: true,
            totalTokens: true,
            costUsd: true,
            durationMs: true,
            createdAt: true,
          },
        })
      : [];

    const exportPayload = {
      generatedAt: new Date().toISOString(),
      shop,
      customer: {
        email: customerEmail,
        shopifyCustomerId: customer?.id ?? null,
      },
      summary: {
        incomingEmails: incomingEmails.length,
        threads: threads.length,
        llmCallLogs: llmCalls.length,
      },
      incomingEmails,
      threads,
      llmCallLogs: llmCalls,
    };

    const baseDir = path.join(process.cwd(), "data-requests", shop, customerEmailHash);
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const fullPath = path.join(baseDir, filename);
    fs.writeFileSync(fullPath, JSON.stringify(exportPayload, null, 2), { mode: 0o600 });

    console.log(
      `[webhook] customers/data_request: export written shop=${shop} customerHash=${customerEmailHash} ` +
        `path=${path.relative(process.cwd(), fullPath)} ` +
        `incomingEmails=${incomingEmails.length} threads=${threads.length} llmCalls=${llmCalls.length}`,
    );
  } catch (err) {
    console.error(
      `[webhook] customers/data_request: export failed shop=${shop} customerHash=${customerEmailHash}:`,
      err,
    );
    // Still acknowledge to Shopify — they retry on non-2xx and we don't want
    // to spin on a transient DB/disk failure. Operator monitors error logs.
  }

  return new Response();
};
