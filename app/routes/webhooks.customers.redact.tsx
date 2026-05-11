import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { piiHash } from "../lib/log/pii";
import { storage } from "../lib/attachments/storage";

/**
 * GDPR: customers/redact
 *
 * Shopify asks us to delete any PII we hold about a specific customer.
 * Fires 10 days after a customer deletion request, assuming the merchant
 * has not cancelled it.
 *
 * Strategy: any thread the customer touched in any way is wiped down to
 * a tombstone. The Thread row itself is kept (with `redactedAt` set) so
 * the merchant inbox shows a placeholder instead of a confusing gap, but
 * every PII-bearing field is cleared and all child rows (IncomingEmail,
 * ReplyDraft, LlmCallLog, attachments on disk) are deleted.
 *
 * A thread is considered "touched" when any of the following hold:
 *   - an IncomingEmail has fromAddress == customer email
 *   - an IncomingEmail has bodyText / subject / snippet / extractedIdentifiers
 *     containing the customer email
 *   - Thread.resolvedEmail == customer email
 *
 * That is broader than just `fromAddress` and protects against PII
 * leaking through cited quotes, signatures, or analysis JSON blobs.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const body = payload as {
    customer?: { email?: string };
    orders_to_redact?: unknown;
  };
  const email = body.customer?.email?.toLowerCase().trim();

  console.log(
    `[webhook] ${topic} shop=${shop} customerHash=${piiHash(email)}`,
  );

  if (!email) {
    return new Response();
  }

  // 1. Find every thread that mentions the customer in any way.
  const ci = "insensitive" as const;
  const threadsFromEmails = await db.incomingEmail.findMany({
    where: {
      shop,
      OR: [
        { fromAddress: { equals: email, mode: ci } },
        { bodyText: { contains: email, mode: ci } },
        { snippet: { contains: email, mode: ci } },
        { subject: { contains: email, mode: ci } },
        { extractedIdentifiers: { contains: email, mode: ci } },
        { analysisResult: { contains: email, mode: ci } },
      ],
      canonicalThreadId: { not: null },
    },
    select: { canonicalThreadId: true },
  });
  const threadsFromResolved = await db.thread.findMany({
    where: { shop, resolvedEmail: { equals: email, mode: ci } },
    select: { id: true },
  });
  const threadIds = Array.from(
    new Set<string>([
      ...threadsFromEmails
        .map((e) => e.canonicalThreadId)
        .filter((x): x is string => Boolean(x)),
      ...threadsFromResolved.map((t) => t.id),
    ]),
  );

  if (threadIds.length === 0) {
    console.log(
      `[webhook] customers/redact: no matching threads shop=${shop} customerHash=${piiHash(email)}`,
    );
    return new Response();
  }

  // 2. Collect every IncomingEmail.id under those threads — we need them
  //    to look up attachments on disk and LLM logs before deletion.
  const emailsToWipe = await db.incomingEmail.findMany({
    where: { shop, canonicalThreadId: { in: threadIds } },
    select: { id: true },
  });
  const emailIds = emailsToWipe.map((e) => e.id);

  // 3. Wipe files on disk first — Prisma cascade will then drop the rows.
  if (emailIds.length > 0) {
    const draftAttachments = await db.draftAttachment.findMany({
      where: {
        shop,
        replyDraft: { emailId: { in: emailIds } },
        storagePath: { not: null },
      },
      select: { storagePath: true },
    });
    for (const att of draftAttachments) {
      if (!att.storagePath) continue;
      try {
        await storage.remove(att.storagePath);
      } catch (err) {
        console.error(
          `[webhook] customers/redact: failed to remove file ${att.storagePath}:`,
          err,
        );
      }
    }
  }

  // 4. Delete LLM logs by both emailId and threadId — some calls are
  //    thread-scoped (summary, draft) without an explicit emailId.
  await db.llmCallLog.deleteMany({
    where: {
      shop,
      OR: [
        ...(emailIds.length > 0 ? [{ emailId: { in: emailIds } }] : []),
        { threadId: { in: threadIds } },
      ],
    },
  });

  // 5. Delete every IncomingEmail in those threads (cascades to
  //    IncomingEmailAttachment + ReplyDraft + DraftAttachment).
  if (emailIds.length > 0) {
    await db.incomingEmail.deleteMany({
      where: { shop, id: { in: emailIds } },
    });
  }

  // 6. Tombstone the threads themselves: clear every PII-bearing column
  //    but keep the row so the merchant inbox shows a placeholder.
  const now = new Date();
  await db.thread.updateMany({
    where: { shop, id: { in: threadIds } },
    data: {
      subjectKey: "",
      resolvedOrderNumber: null,
      resolvedTrackingNumber: null,
      resolvedEmail: null,
      resolvedCustomerName: null,
      resolvedFromMessageId: null,
      resolutionConfidence: "none",
      lastMessageId: null,
      messageCount: 0,
      structuredState: "{}",
      summaryText: null,
      summaryUpdatedAt: null,
      preservedManualOverridesJson: null,
      operationalState: "resolved",
      supportNature: "non_support",
      redactedAt: now,
      redactedReason: "gdpr_customer_request",
    },
  });

  console.log(
    `[webhook] customers/redact: tombstoned threads=${threadIds.length} wiped emails=${emailIds.length} shop=${shop} customerHash=${piiHash(email)}`,
  );

  return new Response();
};
