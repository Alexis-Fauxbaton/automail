import { useEffect, useState, Suspense, lazy } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getPeriodBounds,
  getKpiStats,
  getDailyBreakdown,
  getCurrentThreadStates,
  getConversationStats,
  getIntentBreakdown,
  type DailyPoint,
  type ThreadStateCounts,
  type IntentCount,
} from "../lib/dashboard-stats";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "30d";
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;

  const bounds = getPeriodBounds(range, from, to);
  const { start, end, prevStart, prevEnd } = bounds;

  const [kpis, daily, threadStates, conversationStats, intents] = await Promise.all([
    getKpiStats(shop, start, end, prevStart, prevEnd),
    getDailyBreakdown(shop, start, end),
    getCurrentThreadStates(shop),
    getConversationStats(shop, start, end),
    getIntentBreakdown(shop, start, end),
  ]);

  return {
    range,
    from: from ?? null,
    to: to ?? null,
    kpis,
    daily,
    threadStates,
    conversationStats,
    intents,
    today: new Date().toLocaleDateString("fr-FR"),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(current: number, prev: number): { label: string; up: boolean } | null {
  if (prev === 0) return null;
  const diff = ((current - prev) / prev) * 100;
  const up = diff >= 0;
  return {
    label: (up ? "↑ +" : "↓ ") + Math.abs(diff).toFixed(0) + "%",
    up,
  };
}

// ---------------------------------------------------------------------------
// KpiCard
// ---------------------------------------------------------------------------

function KpiCard({
  label,
  value,
  prev,
  accentColor,
  comingSoon,
}: {
  label: string;
  value: number | null;
  prev?: number;
  accentColor?: string;
  comingSoon?: boolean;
}) {
  const variation = value !== null && prev !== undefined ? pct(value, prev) : null;
  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid var(--p-color-border)",
        borderLeft: accentColor ? `3px solid ${accentColor}` : undefined,
        background: comingSoon ? "var(--p-color-bg-surface-secondary)" : "var(--p-color-bg-surface)",
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <s-text variant="bodySm" tone="subdued">
        {label.toUpperCase()}
      </s-text>
      {value !== null ? (
        <>
          <s-text variant="headingLg">{value.toLocaleString("fr-FR")}</s-text>
          {variation ? (
            <s-text
              variant="bodySm"
              tone={variation.up ? "success" : "critical"}
              title="vs. période précédente"
            >
              {variation.label}
            </s-text>
          ) : (
            <s-text variant="bodySm" tone="subdued">&nbsp;</s-text>
          )}
        </>
      ) : (
        <>
          <s-text variant="headingLg" tone="subdued">—</s-text>
          {comingSoon && (
            <span style={{ marginTop: 2 }}>
              <s-badge tone="info">Bientôt disponible</s-badge>
            </span>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BarChartClient — SSR-safe Recharts wrapper
// ---------------------------------------------------------------------------

const RechartsChart = lazy(() =>
  import("recharts").then((mod) => ({
    default: function RechartsChartInner({ data }: { data: DailyPoint[] }) {
      const {
        ComposedChart,
        Bar,
        Line,
        XAxis,
        YAxis,
        Tooltip,
        ResponsiveContainer,
        Legend,
        CartesianGrid,
      } = mod;
      return (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--p-color-border)" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10 }}
              tickFormatter={(v: string) => v.slice(5)}
              axisLine={false}
              tickLine={false}
            />
            <YAxis tick={{ fontSize: 10 }} allowDecimals={false} axisLine={false} tickLine={false} />
            <Tooltip
              formatter={(value: number, name: string) => [
                value,
                name === "total" ? "Tous mails" : "Support client",
              ]}
              labelFormatter={(label: string) => label}
              contentStyle={{ fontSize: 12, borderRadius: 6 }}
            />
            <Legend
              verticalAlign="top"
              align="right"
              iconSize={10}
              wrapperStyle={{ fontSize: 11, paddingBottom: 8 }}
              formatter={(v: string) => (v === "total" ? "Tous mails" : "Support client")}
            />
            <Bar dataKey="total" fill="#B5BAE5" radius={[2, 2, 0, 0]} maxBarSize={32} />
            <Line
              type="monotone"
              dataKey="support"
              stroke="#5C6AC4"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      );
    },
  })),
);

function BarChartClient({ data }: { data: DailyPoint[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div style={{ height: 220 }} />;

  return (
    <Suspense fallback={<div style={{ height: 220 }} />}>
      <RechartsChart data={data} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_LABELS: Record<string, string> = {
  open: "Ouvert",
  waiting_customer: "Attente client",
  waiting_merchant: "Attente nous",
  resolved: "Résolu",
  no_reply_needed: "Sans réponse requise",
};

const STATE_COLORS: Record<string, string> = {
  open: "#ef4444",
  waiting_customer: "#f59e0b",
  waiting_merchant: "#3b82f6",
  resolved: "#22c55e",
  no_reply_needed: "#9ca3af",
};

const INTENT_LABELS: Record<string, string> = {
  where_is_my_order: "Où est ma commande",
  delivery_delay: "Retard de livraison",
  marked_delivered_not_received: "Livré non reçu",
  package_stuck: "Colis bloqué",
  refund_request: "Remboursement",
  unknown: "Autre",
};

// ---------------------------------------------------------------------------
// StatRow — small row primitive used by the right-column lists
// ---------------------------------------------------------------------------

function StatRow({
  label,
  value,
  dotColor,
}: {
  label: string;
  value: number | string;
  dotColor?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {dotColor && (
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: dotColor,
              flex: "0 0 auto",
            }}
          />
        )}
        <s-text variant="bodySm">{label}</s-text>
      </span>
      <s-text variant="headingSm">{value}</s-text>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const { range, kpis, daily, threadStates, conversationStats, intents, today } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  const presets = ["24h", "7d", "30d", "90d"] as const;

  function selectPreset(r: string) {
    setSearchParams({ range: r });
  }

  return (
    <s-page heading="Dashboard">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-200">
          {presets.map((p) => (
            <s-button
              key={p}
              variant={range === p ? "primary" : "tertiary"}
              onClick={() => selectPreset(p)}
            >
              {p}
            </s-button>
          ))}
        </s-stack>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 360px",
            gap: 16,
            alignItems: "start",
          }}
        >
          <s-stack direction="block" gap="base">
            <s-section>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <KpiCard label="Mails reçus" value={kpis.totalEmails} prev={kpis.prevTotalEmails} accentColor="#5C6AC4" />
                <KpiCard label="Support client" value={kpis.supportEmails} prev={kpis.prevSupportEmails} accentColor="#8C6AC4" />
                <KpiCard label="Brouillons créés" value={kpis.draftsCreated} prev={kpis.prevDraftsCreated} accentColor="#22c55e" />
                <KpiCard label="Mails envoyés" value={null} comingSoon />
              </div>
            </s-section>

            <s-section heading="Mails reçus par jour">
              <BarChartClient data={daily} />
            </s-section>
          </s-stack>

          <s-stack direction="block" gap="base">
            <s-section heading={`État actuel · ${today}`}>
              <s-stack direction="block" gap="small-200">
                {(Object.keys(STATE_LABELS) as Array<keyof ThreadStateCounts>).map((state) => (
                  <StatRow
                    key={state}
                    label={STATE_LABELS[state]}
                    value={threadStates[state] ?? 0}
                    dotColor={STATE_COLORS[state]}
                  />
                ))}
              </s-stack>
            </s-section>

            <s-section heading="Conversations (période)">
              <s-stack direction="block" gap="small-200">
                <StatRow label="Nouvelles" value={conversationStats.newConversations} />
                <StatRow label="Résolues" value={conversationStats.resolvedConversations} />
                <StatRow label="Rouvertes" value={conversationStats.reopenedConversations} />
              </s-stack>
            </s-section>

            <s-section heading="Top intentions">
              {intents.length === 0 ? (
                <s-paragraph>
                  <s-text tone="subdued">Aucune donnée sur la période.</s-text>
                </s-paragraph>
              ) : (
                <s-stack direction="block" gap="small-200">
                  {intents.map(({ intent, count }: IntentCount) => (
                    <StatRow key={intent} label={INTENT_LABELS[intent] ?? intent} value={count} />
                  ))}
                </s-stack>
              )}
            </s-section>
          </s-stack>
        </div>
      </s-stack>
    </s-page>
  );
}