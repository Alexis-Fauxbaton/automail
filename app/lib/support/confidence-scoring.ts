import type {
  Confidence,
  ExtractedIdentifiers,
  FulfillmentTrackingFacts,
  OrderFacts,
  Warning,
} from "./types";

export interface ScoringInput {
  identifiers: ExtractedIdentifiers;
  matchedBy:
    | "orderNumber"
    | "email"
    | "customerName"
    | "trackingNumber"
    | null;
  order: OrderFacts | null;
  candidatesCount: number;
  trackings: FulfillmentTrackingFacts[];
}

export interface ScoringOutput {
  confidence: Confidence;
  warnings: Warning[];
}

export function scoreConfidence(input: ScoringInput): ScoringOutput {
  const warnings: Warning[] = [];

  if (!input.order) {
    if (
      !input.identifiers.orderNumber &&
      !input.identifiers.email &&
      !input.identifiers.customerName &&
      !input.identifiers.trackingNumber
    ) {
      warnings.push({
        code: "no_identifiers",
        message:
          "No order number, email, name, or tracking number was found in the message.",
      });
    } else {
      warnings.push({
        code: "no_order_match",
        message:
          "No Shopify order matched the identifiers extracted from the message.",
      });
    }
    return { confidence: "low", warnings };
  }

  if (input.candidatesCount > 1) {
    warnings.push({
      code: "ambiguous_match",
      message: `Multiple orders matched (${input.candidatesCount}). Verify the right one before replying.`,
    });
  }

  // Warn if any fulfillment has an inferred carrier
  const inferredCount = input.trackings.filter((t) => t.inferred).length;
  if (inferredCount > 0) {
    warnings.push({
      code: "inferred_carrier",
      message:
        inferredCount === 1
          ? "Carrier was inferred from the tracking number pattern and is not verified."
          : `Carrier was inferred for ${inferredCount} shipment(s) and is not verified.`,
    });
  }

  if (input.order.fulfillments.length === 0) {
    warnings.push({
      code: "no_fulfillment",
      message: "The order has no fulfillment yet.",
    });
  }

  // Confidence calculation — use the best-quality tracking entry
  const primaryTracking = input.trackings[0] ?? null;
  let confidence: Confidence = "low";
  const hardMatch = input.matchedBy === "orderNumber" || input.matchedBy === "email";
  const hasTracking = !!primaryTracking && primaryTracking.source !== "none";
  const noAmbiguity = input.candidatesCount <= 1;

  if (hardMatch && noAmbiguity && hasTracking && !primaryTracking?.inferred) {
    confidence = "high";
  } else if (hardMatch && noAmbiguity) {
    confidence = "medium";
  } else if (input.matchedBy && noAmbiguity) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return { confidence, warnings };
}

