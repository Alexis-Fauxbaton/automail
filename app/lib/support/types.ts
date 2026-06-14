// Domain types for the support copilot.
// Keep contracts explicit: every module produces/consumes these shapes.

export type Confidence = "high" | "medium" | "low";

export const SUPPORT_INTENTS = [
  "where_is_my_order",
  "delivery_delay",
  "marked_delivered_not_received",
  "damaged_product",
  "order_error",
  "refund_request",
  "pre_purchase_question",
  "unknown",
] as const;

export type SupportIntent = (typeof SUPPORT_INTENTS)[number];

export interface ParsedEmail {
  subject: string;
  body: string;
  /** Combined lowercased text useful for keyword matching. */
  normalized: string;
}

export type MessageDirection = "incoming" | "outgoing" | "unknown";

export interface ConversationMessage {
  direction: MessageDirection;
  fromAddress: string;
  receivedAt: string;
  subject: string;
  body: string;
  isLatest: boolean;
  /** File names of non-inline attachments sent with this message. */
  attachmentFileNames?: string[];
}

export interface ConversationMeta {
  messageCount: number;
  incomingCount: number;
  outgoingCount: number;
  lastMessageDirection: MessageDirection;
  noReplyNeeded: boolean;
  noReplyReason?: string;
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
  /** Items included in this specific fulfillment (from Shopify). */
  lineItems: OrderLineItemFacts[];
}

export interface OrderFacts {
  id: string;                       // GID
  name: string;                     // e.g. "#1234"
  createdAt: string;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  /** Destination country (Alpha-2) + postal code. Minimal address data, used
   *  only to satisfy 17track's `param` requirement for carriers that need a
   *  destination to register a tracking number. */
  destinationCountry?: string | null;
  destinationZip?: string | null;
  lineItems: OrderLineItemFacts[];
  fulfillments: OrderFulfillmentFacts[];
}

/**
 * Tracking facts specific to one fulfillment in an order.
 * A single order can have multiple fulfillments (split shipments).
 */
export interface FulfillmentTrackingFacts extends TrackingFacts {
  /** Zero-based index within order.fulfillments (for display). */
  fulfillmentIndex: number;
  /** Items shipped in this fulfillment (from Shopify). */
  lineItems: OrderLineItemFacts[];
}

export interface TrackingAgentStatus {
  lastEvent: string;
  lastLocation: string | null;
  estimatedDelivery: string | null;
  delivered: boolean;
}

export interface TrackingFacts {
  source: "shopify_url" | "shopify_carrier" | "pattern_guess" | "seventeen_track" | "none";
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  status?: string | null;
  /** When true, these facts were inferred rather than verified by a carrier API. */
  inferred: boolean;
  /** Enriched status fetched and parsed by the tracking agent (LLM + page fetch). */
  agentStatus?: TrackingAgentStatus | null;
  /** Live events from 17track (most recent first). */
  events?: Array<{ date: string | null; description: string | null; location: string | null }>;
  lastEvent?: string | null;
  lastLocation?: string | null;
  lastEventDate?: string | null;
  delivered?: boolean;
  /**
   * Outcome of the *last* 17track attempt for this fulfillment.
   * - "ok"      → 17track returned usable data; `source === "seventeen_track"`.
   * - "pending" → 17track registered the number but data not ready yet.
   * - "error"   → 17track HTTP / parse failure; we fell back to Shopify/pattern.
   * - "skipped" → 17track disabled (no API key) or breaker open or no tracking number.
   * Used by refreshStaleAnalysesForShop to pick a tighter cutoff for retry.
   */
  last17trackAttempt?: "ok" | "pending" | "error" | "skipped";
  /** ISO-8601 timestamp of the last attempt. */
  last17trackAttemptAt?: string | null;
}

export interface Warning {
  code: string;
  message: string;
}

export interface ManualOverrideMarker {
  /** ISO-8601 timestamp of when the user last edited this field. */
  editedAt: string;
}

export interface ManualOverrides {
  intents?: ManualOverrideMarker;
  order?: ManualOverrideMarker;
}

export interface SupportAnalysis {
  /** Primary intent used for prioritization, filters, and draft generation. */
  intent: SupportIntent;
  /** All detected intents, ordered by priority. Falls back to [intent] for legacy analyses. */
  intents?: SupportIntent[];
  identifiers: ExtractedIdentifiers;
  order: OrderFacts | null;
  /** If several orders match the identifiers. */
  orderCandidates: OrderFacts[];
  /** Tracking facts per fulfillment (one entry per shipment). */
  trackings: FulfillmentTrackingFacts[];
  confidence: Confidence;
  warnings: Warning[];
  draftReply: string;
  conversation: ConversationMeta;
  /**
   * Per-field markers indicating that the user manually set this field.
   * Used by the UI ("modified manually" badge) and by the auto-refresh
   * to skip recomputation. The value itself lives in the canonical field
   * (intent / intents / order) — this struct only records the edit.
   */
  manualOverrides?: ManualOverrides;
}
