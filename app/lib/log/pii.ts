import { createHash } from "crypto";

/**
 * Return a short, non-reversible identifier for a PII value (email, name…).
 * Use in logs so we retain traceability without storing plaintext PII —
 * required by GDPR data-minimization + Shopify protected-customer-data
 * guidance. The salt is the app secret, so hashes are not portable across
 * environments (defeats trivial rainbow-table lookup).
 */
export function piiHash(value: string | null | undefined): string {
  if (!value) return "none";
  const salt = process.env.SHOPIFY_API_SECRET || "";
  return createHash("sha256")
    .update(salt)
    .update(":")
    .update(value.toLowerCase().trim())
    .digest("hex")
    .slice(0, 12);
}
