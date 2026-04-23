import type { ReactNode } from "react";
import type { SupportAnalysisExtended } from "../lib/support/orchestrator";
import type { FulfillmentTrackingFacts, TrackingFacts } from "../lib/support/types";

// Normalize tracking data across schema versions.
// Old analyses: `tracking: TrackingFacts | null` (singular).
// New analyses: `trackings: FulfillmentTrackingFacts[]` (plural).
function resolveTrackings(analysis: SupportAnalysisExtended): FulfillmentTrackingFacts[] {
  if (Array.isArray(analysis.trackings) && analysis.trackings.length > 0) {
    return analysis.trackings;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacy = (analysis as any).tracking as TrackingFacts | null | undefined;
  if (legacy && legacy.source !== "none") {
    return [{ ...legacy, fulfillmentIndex: 0, lineItems: [] }];
  }
  return analysis.trackings ?? [];
}

function formatIntent(intent: string): string {
  return intent
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ─── Primitives ──────────────────────────────────────────────────────────────

export function ConfidenceBadge({ confidence }: { confidence: SupportAnalysisExtended["confidence"] }) {
  const tone = confidence === "high" ? "success" : confidence === "medium" ? "info" : "warning";
  return <s-badge tone={tone}>{confidence.toUpperCase()}</s-badge>;
}

// Rounded card with an optional header strip
function Card({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div style={{
      border: "1px solid #e1e3e5",
      borderRadius: "10px",
      overflow: "hidden",
      background: "#fff",
    }}>
      <div style={{
        padding: "7px 14px",
        background: "#f6f6f7",
        borderBottom: "1px solid #e1e3e5",
        fontSize: "11px",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "#6d7175",
      }}>
        {title}
      </div>
      <div style={{ padding: "14px 16px" }}>
        {children}
      </div>
      {footer && (
        <div style={{ padding: "8px 16px", borderTop: "1px solid #e1e3e5", background: "#fafafa" }}>
          {footer}
        </div>
      )}
    </div>
  );
}

// Two-column key/value grid. Uses `display: contents` so dt/dd are direct
// grid children while we can still key on the wrapper div.
function KVGrid({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "max-content 1fr", gap: "5px 16px", alignItems: "baseline" }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "contents" }}>
          <dt style={{ margin: 0, fontWeight: 600, color: "#8c9196", fontSize: "13px", whiteSpace: "nowrap" }}>{label}</dt>
          <dd style={{ margin: 0, fontSize: "13px" }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ─── Sections ────────────────────────────────────────────────────────────────

export function IdentifiersList({ identifiers }: { identifiers: SupportAnalysisExtended["identifiers"] }) {
  const rows = ([
    ["Order", identifiers.orderNumber ? `#${identifiers.orderNumber}` : null],
    ["Email", identifiers.email ?? null],
    ["Customer", identifiers.customerName ?? null],
    ["Tracking", identifiers.trackingNumber ?? null],
  ] as [string, string | null][]).filter(([, v]) => v !== null) as [string, string][];

  if (rows.length === 0) {
    return <span style={{ fontSize: "13px", color: "#8c9196" }}>No identifiers extracted.</span>;
  }
  return <KVGrid rows={rows} />;
}

export function OrderBlock({ order }: { order: SupportAnalysisExtended["order"] }) {
  if (!order) return <span style={{ fontSize: "13px", color: "#8c9196" }}>No matching order found.</span>;

  const rows: [string, ReactNode][] = [
    ["Order", <strong key="name">{order.name}</strong>],
    ["Date", new Date(order.createdAt).toLocaleString()],
    ["Customer", `${order.customerName ?? "—"} (${order.customerEmail ?? "no email"})`],
    ["Fulfillment", order.displayFulfillmentStatus ?? "—"],
    ["Payment", order.displayFinancialStatus ?? "—"],
  ];

  const items = order.lineItems.length > 0
    ? order.lineItems.map((li) => `${li.quantity} × ${li.title}`).join(" · ")
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <KVGrid rows={rows} />
      {items && (
        <div style={{ fontSize: "12px", color: "#6d7175", background: "#f6f6f7", borderRadius: "6px", padding: "6px 10px" }}>
          {items}
        </div>
      )}
    </div>
  );
}

function TrackingSourceBadge({ t }: { t: FulfillmentTrackingFacts }) {
  if (t.source === "seventeen_track") return <s-badge tone="success">17track</s-badge>;
  if (t.source === "shopify_url" || t.source === "shopify_carrier") return <s-badge tone="info">Shopify</s-badge>;
  if (t.source === "pattern_guess") return <s-badge tone="warning">Inferred</s-badge>;
  return <s-badge>No tracking</s-badge>;
}

function SingleFulfillmentTracking({ t, label }: { t: FulfillmentTrackingFacts; label?: string }) {
  const kvRows: [string, ReactNode][] = [];
  if (t.lineItems.length > 0) kvRows.push(["Items", t.lineItems.map((li) => `${li.quantity}× ${li.title}`).join(", ")]);
  if (t.carrier) kvRows.push(["Carrier", t.carrier]);
  if (t.trackingNumber) kvRows.push(["Number", t.trackingNumber]);
  if (t.status) kvRows.push(["Status", t.status]);
  if (t.lastEvent) kvRows.push(["Last event", `${t.lastEvent}${t.lastEventDate ? ` (${t.lastEventDate})` : ""}`]);
  if (t.lastLocation) kvRows.push(["Location", t.lastLocation]);

  const badges = (
    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center", marginBottom: kvRows.length > 0 ? "10px" : 0 }}>
      {label && <span style={{ fontSize: "12px", fontWeight: 600 }}>{label}</span>}
      <TrackingSourceBadge t={t} />
      {t.delivered && <s-badge tone="success">Delivered</s-badge>}
      {t.inferred && <s-badge tone="warning">Unverified carrier</s-badge>}
    </div>
  );

  const link = t.trackingUrl
    ? <s-link href={t.trackingUrl} target="_blank">Open tracking page →</s-link>
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {badges}
      {t.source === "none"
        ? <span style={{ fontSize: "13px", color: "#8c9196" }}>No tracking data available yet.</span>
        : <KVGrid rows={kvRows} />
      }
      {link && (
        <div style={{ marginTop: "10px", fontSize: "13px" }}>{link}</div>
      )}
    </div>
  );
}

export function TrackingsBlock({ trackings }: { trackings: FulfillmentTrackingFacts[] }) {
  if (trackings.length === 0) {
    return <span style={{ fontSize: "13px", color: "#8c9196" }}>No tracking data available yet.</span>;
  }
  const multi = trackings.length > 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {trackings.map((t, i) => (
        <div key={i}>
          {multi && i > 0 && <hr style={{ margin: "0 0 12px", border: "none", borderTop: "1px solid #e1e3e5" }} />}
          <SingleFulfillmentTracking t={t} label={multi ? `Shipment ${i + 1}` : undefined} />
        </div>
      ))}
    </div>
  );
}

export function CrawledContextsBlock({ contexts }: { contexts: SupportAnalysisExtended["crawledContexts"] }) {
  const successful = (contexts ?? []).filter((c) => c.success);
  if (successful.length === 0) return null;
  return (
    <Card title="Live context retrieved">
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {successful.map((ctx, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600 }}>{ctx.purpose}</span>
            <span style={{ fontSize: "13px" }}>{ctx.extractedText}</span>
            <s-link href={ctx.url} target="_blank">Source</s-link>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function WarningsBlock({ warnings }: { warnings: SupportAnalysisExtended["warnings"] }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {warnings.map((w) => (
        <s-banner key={w.code} tone="warning">{w.message}</s-banner>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AnalysisDisplay({ analysis }: { analysis: SupportAnalysisExtended }) {
  // Defensive fallbacks for analyses stored before certain fields were added
  // to the schema. Any of these being undefined would crash the render and
  // silently swallow the entire analysis block (and everything after it).
  const conversation = analysis.conversation ?? {
    messageCount: 1,
    incomingCount: 1,
    outgoingCount: 0,
    lastMessageDirection: "unknown" as const,
    noReplyNeeded: false,
  };
  const orderCandidates = analysis.orderCandidates ?? [];
  const crawledContexts = analysis.crawledContexts ?? [];
  const warnings = analysis.warnings ?? [];

  const directionLabel =
    conversation.lastMessageDirection === "incoming" ? "Incoming"
    : conversation.lastMessageDirection === "outgoing" ? "Outgoing"
    : "Unknown";

  const totalMessages = conversation.incomingCount + conversation.outgoingCount;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>

      {/* Status pill */}
      <div style={{
        display: "inline-flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "8px",
        padding: "7px 14px",
        background: "#f6f6f7",
        border: "1px solid #e1e3e5",
        borderRadius: "20px",
        alignSelf: "flex-start",
        fontSize: "13px",
      }}>
        <span style={{ color: "#6d7175" }}>Intent</span>
        <span style={{ fontWeight: 600 }}>{formatIntent(analysis.intent)}</span>
        <span style={{ color: "#c9cccf" }}>·</span>
        <span style={{ color: "#6d7175" }}>Confidence</span>
        <ConfidenceBadge confidence={analysis.confidence} />
        <span style={{ color: "#c9cccf" }}>·</span>
        <span style={{ color: "#6d7175" }}>{directionLabel} · {totalMessages} msg{totalMessages > 1 ? "s" : ""}</span>
        {conversation.noReplyNeeded && <s-badge tone="success">No reply needed</s-badge>}
      </div>

      {conversation.noReplyNeeded && conversation.noReplyReason && (
        <s-banner tone="info">{conversation.noReplyReason}</s-banner>
      )}

      {/* Top row: Identifiers + Order side by side */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        <Card title="Identifiers">
          <IdentifiersList identifiers={analysis.identifiers} />
        </Card>

        <Card
          title="Matched order"
          footer={orderCandidates.length > 1
            ? <span style={{ fontSize: "12px", color: "#b98900" }}>⚠ {orderCandidates.length} orders matched — verify before replying.</span>
            : undefined
          }
        >
          <OrderBlock order={analysis.order} />
        </Card>
      </div>

      {/* Tracking card */}
      <Card title="Tracking">
        <TrackingsBlock trackings={resolveTrackings(analysis)} />
      </Card>

      <CrawledContextsBlock contexts={crawledContexts} />

      <WarningsBlock warnings={warnings} />

    </div>
  );
}
