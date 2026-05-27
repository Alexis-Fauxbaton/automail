/**
 * Shopify Protected Customer Data (PCD) gating.
 *
 * Even when an app declares the `read_customers` scope, Shopify withholds
 * customer PII (email, phone, firstName, lastName, defaultAddress, ...) from
 * the GraphQL response until the app is explicitly approved for PCD via the
 * Partners dashboard. Unapproved apps see GraphQL `errors[]` entries with
 * `extensions.code === "ACCESS_DENIED"` and `path` pointing into the
 * customer block — and Shopify continues to return the rest of the document
 * (orders, line items, fulfillments, tracking) so the response still has
 * useful data.
 *
 * This module turns those PCD-shaped errors into a soft signal so the
 * caller can keep going instead of aborting the whole order search.
 *
 * Spec: https://shopify.dev/docs/apps/build/customer-data/protected-customer-data
 */

export interface ShopifyGraphqlError {
  message: string;
  path?: Array<string | number>;
  extensions?: { code?: string };
}

// PCD field names that Shopify gates. Conservative list — adding extras
// here just means we treat more ACCESS_DENIED errors as "PCD soft fail"
// instead of "fatal", which is the safe direction.
const PCD_FIELD_NAMES = new Set([
  "customer",
  "email",
  "phone",
  "firstName",
  "lastName",
  "defaultAddress",
  "addresses",
  "displayName",
  "billingAddress",
  "shippingAddress",
]);

/**
 * Returns true when an individual GraphQL error is a PCD restriction.
 * Two signals must both line up:
 *   1. `extensions.code === "ACCESS_DENIED"` — Shopify's documented marker
 *      for "you're not allowed to see this field". (Scope-missing errors
 *      get a different code, so we don't confuse the two.)
 *   2. The error's path ends on a known PCD field. Required because
 *      ACCESS_DENIED can also fire for other forbidden surfaces (e.g.
 *      protected price rules) where the right behaviour is to fail loud.
 */
export function isProtectedCustomerDataError(err: ShopifyGraphqlError): boolean {
  if (err.extensions?.code !== "ACCESS_DENIED") return false;
  const tail = err.path?.[err.path.length - 1];
  return typeof tail === "string" && PCD_FIELD_NAMES.has(tail);
}

/**
 * Partition a GraphQL `errors[]` array into PCD-soft and "real" errors.
 * A response is salvageable as long as `realErrors` is empty.
 */
export function partitionGraphqlErrors(errors: ShopifyGraphqlError[]): {
  pcdErrors: ShopifyGraphqlError[];
  realErrors: ShopifyGraphqlError[];
} {
  const pcdErrors: ShopifyGraphqlError[] = [];
  const realErrors: ShopifyGraphqlError[] = [];
  for (const e of errors) {
    (isProtectedCustomerDataError(e) ? pcdErrors : realErrors).push(e);
  }
  return { pcdErrors, realErrors };
}

// One-time log per shop so a heavy sync doesn't spam the log with the same
// PCD warning hundreds of times. The Set is process-local; if the worker
// restarts the warning fires again, which is exactly when ops cares.
const warnedShops = new Set<string>();

export function warnPcdOnce(shop: string, context: string): void {
  const key = `${shop}|${context}`;
  if (warnedShops.has(key)) return;
  warnedShops.add(key);
  console.warn(
    `[pcd] shop=${shop} context=${context} — Shopify withheld protected ` +
      `customer fields; the app is not approved for protected customer data yet. ` +
      `Continuing with partial order data (customer object will be null).`,
  );
}
