import type { SevenTrackResult } from "./adapters/seventeen-track";

export interface CarrierSelection {
  chosen: SevenTrackResult | null;
  /** Chosen but its recipient country was absent, so we could not corroborate. */
  unverified: boolean;
  /** Every candidate with data contradicted the order country (likely wrong parcel). */
  corroborationMismatch: boolean;
}

/**
 * Choose the carrier whose data we trust for a tracking number.
 *
 * 1. Corroboration: drop any candidate whose recipient country is present and
 *    differs from the order country (catches another customer's parcel).
 * 2. Among survivors with data (status !== "NotFound"), pick by a STABLE rule —
 *    never recency, which would make the displayed carrier oscillate between
 *    refreshes: Delivered (terminal) > hint carrier > previously-chosen carrier
 *    > first.
 * 3. If no survivor has data, return the first NotFound survivor (still NotFound).
 */
export function selectCarrierCandidate(
  candidates: SevenTrackResult[],
  orderCountry: string | null,
  opts: { hintCarrierCode?: number | null; previousCarrierCode?: number | null } = {},
): CarrierSelection {
  if (candidates.length === 0) {
    return { chosen: null, unverified: false, corroborationMismatch: false };
  }

  const contradicts = (c: SevenTrackResult) =>
    !!orderCountry && !!c.recipientCountry && c.recipientCountry !== orderCountry;

  const withData = candidates.filter((c) => c.status !== "NotFound");
  const corroborated = withData.filter((c) => !contradicts(c));

  if (withData.length > 0 && corroborated.length === 0) {
    // Every candidate with data points to a different country → likely wrong parcel.
    return { chosen: null, unverified: false, corroborationMismatch: true };
  }

  if (corroborated.length > 0) {
    const delivered = corroborated.find((c) => c.delivered || c.status === "Delivered");
    const hinted =
      opts.hintCarrierCode != null
        ? corroborated.find((c) => c.carrierCode === opts.hintCarrierCode)
        : undefined;
    const previous =
      opts.previousCarrierCode != null
        ? corroborated.find((c) => c.carrierCode === opts.previousCarrierCode)
        : undefined;
    const chosen = delivered ?? hinted ?? previous ?? corroborated[0];
    return { chosen, unverified: chosen.recipientCountry == null, corroborationMismatch: false };
  }

  // No candidate has data → keep a NotFound (prefer a corroboration-neutral one).
  const notFound = candidates.find((c) => !contradicts(c)) ?? candidates[0];
  return { chosen: notFound, unverified: false, corroborationMismatch: false };
}
