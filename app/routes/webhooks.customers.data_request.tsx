import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
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
 * We log the request for traceability and surface it via a (future) admin
 * tool; the merchant is responsible for fulfilling the customer request
 * using that data export.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const customer = (payload as { customer?: { email?: string; id?: number } })
    .customer;

  console.log(
    `[webhook] ${topic} shop=${shop} customerHash=${piiHash(customer?.email)} customerId=${customer?.id ?? "?"}`,
  );

  // The webhook is authenticated (signature verified by authenticate.webhook).
  // Acknowledge with 200 — fulfillment is offline.
  return new Response();
};
