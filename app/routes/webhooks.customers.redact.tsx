import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { piiHash } from "../lib/log/pii";

/**
 * GDPR: customers/redact
 *
 * Shopify asks us to delete any PII we hold about a specific customer.
 * Fires 10 days after a customer deletion request, assuming the merchant
 * has not cancelled it.
 *
 * Automail's customer PII surfaces:
 *   - IncomingEmail rows where the customer is the sender (email content,
 *     snippet, subject, body, extracted identifiers, analysis, draft).
 *   - Thread resolved identifiers that may contain the customer's email /
 *     name (resolvedEmail, resolvedCustomerName).
 *   - LlmCallLog rows linked to those emails.
 *
 * We scrub everything keyed off the customer's email address(es). Thread
 * rows themselves are kept (they may still contain merchant-side messages),
 * but any resolved identifiers matching the redacted email are cleared.
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

  // Delete emails authored by the redacted customer (case-insensitive).
  const matchingEmails = await db.incomingEmail.findMany({
    where: {
      shop,
      fromAddress: { equals: email, mode: "insensitive" },
    },
    select: { id: true },
  });
  const emailIds = matchingEmails.map((e) => e.id);

  if (emailIds.length > 0) {
    await db.llmCallLog.deleteMany({
      where: { shop, emailId: { in: emailIds } },
    });
    await db.incomingEmail.deleteMany({
      where: { shop, id: { in: emailIds } },
    });
  }

  // Scrub thread-level resolved identifiers that match the redacted email.
  await db.thread.updateMany({
    where: {
      shop,
      resolvedEmail: { equals: email, mode: "insensitive" },
    },
    data: {
      resolvedEmail: null,
      resolvedCustomerName: null,
      resolvedFromMessageId: null,
      resolutionConfidence: "none",
    },
  });

  return new Response();
};
