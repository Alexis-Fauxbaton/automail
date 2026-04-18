// Domain types for the support copilot.
// Keep contracts explicit: every module produces/consumes these shapes.

export type Confidence = "high" | "medium" | "low";

export type SupportIntent =
  | "where_is_my_order"
  | "delivery_delay"
  | "marked_delivered_not_received"
  | "package_stuck"
  | "refund_request"
  | "unknown";

export interface ParsedEmail {
  subject: string;
  body: string;
  /** Combined lowercased text useful for keyword matching. */
  normalized: string;
}

export interface ExtractedIdentifiers {
  orderNumber?: string;      // e.g. "1234" (without #)
  email?: string;
  customerName?: string;
  trackingNumber?: string;
}

export interface OrderLineItemFacts {
  title: string;
  quantity: number;
}

export interface OrderFulfillmentFacts {
  status?: string | null;          // e.g. SUCCESS, IN_TRANSIT
  trackingNumbers: string[];
  trackingUrls: string[];
  carrier?: string | null;
  updatedAt?: string | null;
  estimatedDeliveryAt?: string | null;
}

export interface OrderFacts {
  id: string;                       // GID
  name: string;                     // e.g. "#1234"
  createdAt: string;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  lineItems: OrderLineItemFacts[];
  fulfillments: OrderFulfillmentFacts[];
}

export interface TrackingAgentStatus {
  lastEvent: string;
  lastLocation: string | null;
  estimatedDelivery: string | null;
  delivered: boolean;
}

export interface TrackingFacts {
  source: "shopify_url" | "shopify_carrier" | "pattern_guess" | "none";
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  status?: string | null;
  /** When true, these facts were inferred rather than verified by a carrier API. */
  inferred: boolean;
  /** Enriched status fetched and parsed by the tracking agent (LLM + page fetch). */
  agentStatus?: TrackingAgentStatus | null;
}

export interface Warning {
  code: string;
  message: string;
}

export interface SupportAnalysis {
  intent: SupportIntent;
  identifiers: ExtractedIdentifiers;
  order: OrderFacts | null;
  /** If several orders match the identifiers. */
  orderCandidates: OrderFacts[];
  tracking: TrackingFacts | null;
  confidence: Confidence;
  warnings: Warning[];
  draftReply: string;
}
