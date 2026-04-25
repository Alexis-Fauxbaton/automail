import { useEffect, useState } from "react";
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
// Helper: percentage change label
// ---------------------------------------------------------------------------

function pct(current: number, prev: number): string | null {
  if (prev === 0) return null;
  const diff = ((current - prev) / prev) * 100;
  return (diff >= 0 ? "↑ +" : "↓ ") + Math.abs(diff).toFixed(0) + "%";
}

// ---------------------------------------------------------------------------
// KpiCard component
// ---------------------------------------------------------------------------

function KpiCard({
  label,
  value,
  prev,
  placeholder,
}: {
  label: string;
  value: number | null;
  prev?: number;
  placeholder?: string;
}) {
  const variation = value !== null && prev !== undefined ? pct(value, prev) : null;
  const isUp = variation?.startsWith("↑");
  return (
    <div style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 8, padding: 16 }}>
      <p style={{ margin: 0, fontSize: 12, color: "var(--p-color-text-subdued)", textTransform: "uppercase", letterSpacing: 1 }}>
        {label}
      </p>
      {value !== null ? (
        <>
          <p style={{ margin: "4px 0", fontSize: 28, fontWeight: 700 }}>{value.toLocaleString("fr-FR")}</p>
          {variation && (
            <p style={{ margin: 0, fontSize: 12, color: isUp ? "var(--p-color-text-success)" : "var(--p-color-text-critical)" }}>
              {variation}
            </p>
          )}
        </>
      ) : (
        <>
          <p style={{ margin: "4px 0", fontSize: 28, fontWeight: 700, color: "var(--p-color-text-disabled)" }}>—</p>
          {placeholder && <p style={{ margin: 0, fontSize: 12, color: "var(--p-color-text-disabled)" }}>{placeholder}</p>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BarChartClient — SSR-safe Recharts wrapper
// ---------------------------------------------------------------------------

function BarChartClient({ data }: { data: DailyPoint[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div style={{ height: 200 }} />;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } = require("recharts") as {
    BarChart: React.ComponentType<React.PropsWithChildren<{
      data: DailyPoint[];
      margin?: { top?: number; right?: number; left?: number; bottom?: number };
    }>>;
    Bar: React.ComponentType<{
      dataKey: string;
      fill?: string;
      opacity?: number;
      radius?: [number, number, number, number];
    }>;
    XAxis: React.ComponentType<{
      dataKey?: string;
      tick?: React.CSSProperties | { fontSize?: number };
      tickFormatter?: (v: string) => string;
    }>;
    YAxis: React.ComponentType<{
      tick?: React.CSSProperties | { fontSize?: number };
      allowDecimals?: boolean;
    }>;
    Tooltip: React.ComponentType<{
      formatter?: (value: number, name: string) => [number, string];
      labelFormatter?: (label: string) => string;
    }>;
    ResponsiveContainer: React.ComponentType<React.PropsWithChildren<{ width?: string | number; height?: number }>>;
    Legend: React.ComponentType<{ formatter?: (v: string) => string }>;
  };

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
        <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
        <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
        <Tooltip
          formatter={(value: number, name: string) =>
            [value, name === "total" ? "Tous mails" : "Support"]
          }
          labelFormatter={(label: string) => label}
        />
        <Legend formatter={(v: string) => (v === "total" ? "Tous mails" : "Support client")} />
        <Bar dataKey="total" fill="#6c63ff" opacity={0.5} radius={[2, 2, 0, 0]} />
        <Bar dataKey="support" fill="#6c63ff" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
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
// Dashboard page component
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
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Dashboard</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => selectPreset(p)}
              style={{
                padding: "4px 12px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                background: range === p ? "var(--p-color-bg-fill-brand)" : "var(--p-color-bg-surface-secondary)",
                color: range === p ? "#fff" : "var(--p-color-text)",
                fontWeight: range === p ? 600 : 400,
                fontSize: 13,
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* 2-column layout */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 20, alignItems: "start" }}>

        {/* Left column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* KPI cards */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <KpiCard label="Mails reçus" value={kpis.totalEmails} prev={kpis.prevTotalEmails} />
            <KpiCard label="Support client" value={kpis.supportEmails} prev={kpis.prevSupportEmails} />
            <KpiCard label="Brouillons créés" value={kpis.draftsCreated} prev={kpis.prevDraftsCreated} />
            <KpiCard label="Mails envoyés" value={null} placeholder="Bientôt disponible" />
          </div>

          {/* Bar chart */}
          <div style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 8, padding: 16 }}>
            <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>Mails reçus par jour</p>
            <BarChartClient data={daily} />
          </div>
        </div>

        {/* Right column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Thread states — TODAY snapshot */}
          <div style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 8, padding: 16 }}>
            <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>
              État actuel{" "}
              <span style={{ fontWeight: 400, color: "var(--p-color-text-subdued)", fontSize: 12 }}>
                · {today}
              </span>
            </p>
            {(Object.keys(STATE_LABELS) as Array<keyof ThreadStateCounts>).map((state) => (
              <div key={state} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: STATE_COLORS[state], fontSize: 10 }}>●</span>
                  {STATE_LABELS[state]}
                </span>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{threadStates[state] ?? 0}</span>
              </div>
            ))}
          </div>

          {/* Conversation stats — period */}
          <div style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 8, padding: 16 }}>
            <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>Conversations (période)</p>
            {[
              { label: "Nouvelles", value: conversationStats.newConversations },
              { label: "Résolues", value: conversationStats.resolvedConversations },
              { label: "Rouvertes", value: conversationStats.reopenedConversations },
            ].map(({ label, value }) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "var(--p-color-text-subdued)" }}>{label}</span>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{value}</span>
              </div>
            ))}
          </div>

          {/* Top intents */}
          <div style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 8, padding: 16 }}>
            <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>Top intentions</p>
            {intents.length === 0 && (
              <p style={{ margin: 0, fontSize: 13, color: "var(--p-color-text-subdued)" }}>Aucune donnée sur la période.</p>
            )}
            {intents.map(({ intent, count }: IntentCount) => (
              <div key={intent} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "var(--p-color-text-subdued)" }}>
                  {INTENT_LABELS[intent] ?? intent}
                </span>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
