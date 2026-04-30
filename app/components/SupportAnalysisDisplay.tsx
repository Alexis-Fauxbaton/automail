import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SupportAnalysisExtended } from "../lib/support/orchestrator";
import type { FulfillmentTrackingFacts, TrackingFacts } from "../lib/support/types";

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

// ─── Primitives ──────────────────────────────────────────────────────────────

export function ConfidenceBadge({ confidence }: { confidence: SupportAnalysisExtended["confidence"] }) {
  const tone = confidence === "high" ? "success" : confidence === "medium" ? "info" : "warning";
  return <s-badge tone={tone}>{confidence.toUpperCase()}</s-badge>;
}

function Card({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div style={{ border: "1px solid #e1e3e5", borderRadius: "10px", overflow: "hidden", background: "#fff" }}>
      <div style={{ padding: "7px 14px", background: "#f6f6f7", borderBottom: "1px solid #e1e3e5", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#6d7175" }}>
        {title}
      </div>
      <div style={{ padding: "14px 16px" }}>{children}</div>
      {footer && (
        <div style={{ padding: "8px 16px", borderTop: "1px solid #e1e3e5", background: "#fafafa" }}>
          {footer}
        </div>
      )}
    </div>
  );
}

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
  const { t } = useTranslation();
  const rows = ([
    [t("analysis.fieldOrder"), identifiers.orderNumber ? `#${identifiers.orderNumber}` : null],
    [t("analysis.fieldCustomer"), identifiers.customerName ?? null],
    ["Email", identifiers.email ?? null],
    [t("analysis.trackingNumber"), identifiers.trackingNumber ?? null],
  ] as [string, string | null][]).filter(([, v]) => v !== null) as [string, string][];

  if (rows.length === 0) {
    return <span style={{ fontSize: "13px", color: "#8c9196" }}>{t("analysis.noIdentifiers")}</span>;
  }
  return <KVGrid rows={rows} />;
}

export function OrderBlock({ order }: { order: SupportAnalysisExtended["order"] }) {
  const { t } = useTranslation();
  if (!order) return <span style={{ fontSize: "13px", color: "#8c9196" }}>{t("analysis.noOrder")}</span>;

  const rows: [string, ReactNode][] = [
    [t("analysis.fieldOrder"), <strong key="name">{order.name}</strong>],
    [t("analysis.fieldDate"), new Date(order.createdAt).toLocaleString()],
    [t("analysis.fieldCustomer"), `${order.customerName ?? "—"} (${order.customerEmail ?? "no email"})`],
    [t("analysis.fieldFulfillment"), order.displayFulfillmentStatus ?? "—"],
    [t("analysis.fieldPayment"), order.displayFinancialStatus ?? "—"],
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

function TrackingSourceBadge({ tracking }: { tracking: FulfillmentTrackingFacts }) {
  const { t } = useTranslation();
  if (tracking.source === "seventeen_track") return <s-badge tone="success">{t("analysis.badge17track")}</s-badge>;
  if (tracking.source === "shopify_url" || tracking.source === "shopify_carrier") return <s-badge tone="info">{t("analysis.badgeShopify")}</s-badge>;
  if (tracking.source === "pattern_guess") return <s-badge tone="warning">{t("analysis.badgeInferred")}</s-badge>;
  return <s-badge>{t("analysis.badgeNoTracking")}</s-badge>;
}

function SingleFulfillmentTracking({ tracking, label }: { tracking: FulfillmentTrackingFacts; label?: string }) {
  const { t } = useTranslation();
  const kvRows: [string, ReactNode][] = [];
  if (tracking.lineItems.length > 0) kvRows.push([t("analysis.trackingItems"), tracking.lineItems.map((li) => `${li.quantity}× ${li.title}`).join(", ")]);
  if (tracking.carrier) kvRows.push([t("analysis.trackingCarrier"), tracking.carrier]);
  if (tracking.trackingNumber) kvRows.push([t("analysis.trackingNumber"), tracking.trackingNumber]);
  if (tracking.status) kvRows.push([t("analysis.trackingStatus"), tracking.status]);
  if (tracking.lastEvent) kvRows.push([t("analysis.trackingLastEvent"), `${tracking.lastEvent}${tracking.lastEventDate ? ` (${tracking.lastEventDate})` : ""}`]);
  if (tracking.lastLocation) kvRows.push([t("analysis.trackingLocation"), tracking.lastLocation]);

  const badges = (
    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center", marginBottom: kvRows.length > 0 ? "10px" : 0 }}>
      {label && <span style={{ fontSize: "12px", fontWeight: 600 }}>{label}</span>}
      <TrackingSourceBadge tracking={tracking} />
      {tracking.delivered && <s-badge tone="success">{t("analysis.badgeDelivered")}</s-badge>}
      {tracking.inferred && <s-badge tone="warning">{t("analysis.badgeUnverifiedCarrier")}</s-badge>}
    </div>
  );

  const link = tracking.trackingUrl
    ? <s-link href={tracking.trackingUrl} target="_blank">{t("analysis.openTracking")}</s-link>
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {badges}
      {tracking.source === "none"
        ? <span style={{ fontSize: "13px", color: "#8c9196" }}>{t("analysis.noTrackingData")}</span>
        : <KVGrid rows={kvRows} />
      }
      {link && <div style={{ marginTop: "10px", fontSize: "13px" }}>{link}</div>}
    </div>
  );
}

export function TrackingsBlock({ trackings }: { trackings: FulfillmentTrackingFacts[] }) {
  const { t } = useTranslation();
  if (trackings.length === 0) {
    return <span style={{ fontSize: "13px", color: "#8c9196" }}>{t("analysis.noTrackingData")}</span>;
  }
  const multi = trackings.length > 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {trackings.map((tracking, i) => (
        <div key={i}>
          {multi && i > 0 && <hr style={{ margin: "0 0 12px", border: "none", borderTop: "1px solid #e1e3e5" }} />}
          <SingleFulfillmentTracking tracking={tracking} label={multi ? t("analysis.shipment", { n: i + 1 }) : undefined} />
        </div>
      ))}
    </div>
  );
}

export function CrawledContextsBlock({ contexts }: { contexts: SupportAnalysisExtended["crawledContexts"] }) {
  const { t } = useTranslation();
  const successful = (contexts ?? []).filter((c) => c.success);
  if (successful.length === 0) return null;
  return (
    <Card title={t("analysis.liveContextTitle")}>
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {successful.map((ctx, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600 }}>{ctx.purpose}</span>
            <span style={{ fontSize: "13px" }}>{ctx.extractedText}</span>
            <s-link href={ctx.url} target="_blank">{t("analysis.source")}</s-link>
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
  const { t } = useTranslation();

  const conversation = analysis.conversation ?? {
    messageCount: 1,
    incomingCount: 1,
    outgoingCount: 0,
    lastMessageDirection: "unknown" as const,
    noReplyNeeded: false,
  };
  const orderCandidates = analysis.orderCandidates ?? [];
  const crawledContexts = (analysis.crawledContexts ?? []).filter((c) => c.success && c.url);
  const warnings = analysis.warnings ?? [];

  const trackings = resolveTrackings(analysis);

  const directionLabel =
    conversation.lastMessageDirection === "incoming" ? t("analysis.directionIncoming")
    : conversation.lastMessageDirection === "outgoing" ? t("analysis.directionOutgoing")
    : t("analysis.directionUnknown");

  const totalMessages = conversation.incomingCount + conversation.outgoingCount;
  const intentKey = `analysis.intent_${analysis.intent}` as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
        <s-badge>{t(intentKey, { defaultValue: analysis.intent })}</s-badge>
        {conversation.noReplyNeeded && <s-badge tone="success">{t("analysis.noReplyNeeded")}</s-badge>}
        <span style={{ color: "#6d7175", fontSize: "12px" }}>
          {directionLabel} · {totalMessages} {totalMessages > 1 ? t("analysis.msgPlural") : t("analysis.msgSingular")}
        </span>
      </div>

      {conversation.noReplyNeeded && conversation.noReplyReason && (
        <s-banner tone="info">{conversation.noReplyReason}</s-banner>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        <Card title={t("analysis.identifiersTitle")}>
          <IdentifiersList identifiers={analysis.identifiers} />
        </Card>

        <Card
          title={t("analysis.matchedOrderTitle")}
          footer={orderCandidates.length > 1
            ? <span style={{ fontSize: "12px", color: "#b98900" }}>⚠ {t("analysis.ordersMatchedWarning_other", { count: orderCandidates.length })}</span>
            : undefined
          }
        >
          <OrderBlock order={analysis.order} />
        </Card>
      </div>

      <Card
        title={t("analysis.trackingNumber")}
        footer={crawledContexts.length > 0
          ? <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {crawledContexts.map((ctx, i) => (
                <s-link key={i} href={ctx.url} target="_blank">{t("analysis.source")}</s-link>
              ))}
            </div>
          : undefined
        }
      >
        <TrackingsBlock trackings={trackings} />
      </Card>

      <WarningsBlock warnings={warnings} />
    </div>
  );
}
