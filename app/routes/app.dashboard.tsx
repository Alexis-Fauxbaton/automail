import { useEffect, useState, Suspense, lazy } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getPeriodBounds,
  getKpiStats,
  getDailyBreakdown,
  getDailyActivityBreakdown,
  getCurrentThreadStates,
  getConversationStats,
  getIntentBreakdown,
  type DailyPoint,
  type DailyActivityPoint,
  type ThreadStateCounts,
  type IntentCount,
} from "../lib/dashboard-stats";
import {
  Card,
  MetricCard,
  Pill,
  StatRow,
  SegmentedTabs,
  MailIcon,
  SparklesIcon,
  CheckCircleIcon,
  SendIcon,
  TrendUpIcon,
  ChartIcon,
} from "../components/ui";

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

  const [kpis, daily, dailyActivity, threadStates, conversationStats, intents] = await Promise.all([
    getKpiStats(shop, start, end, prevStart, prevEnd),
    getDailyBreakdown(shop, start, end),
    getDailyActivityBreakdown(shop, start, end),
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
    dailyActivity,
    threadStates,
    conversationStats,
    intents,
    today: new Date().toLocaleDateString("fr-FR"),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function variation(current: number, prev: number): { label: string; up: boolean } | null {
  if (prev === 0) return null;
  const diff = ((current - prev) / prev) * 100;
  const up = diff >= 0;
  return {
    label: (up ? "↑ +" : "↓ ") + Math.abs(diff).toFixed(0) + "% vs. période précédente",
    up,
  };
}

// ---------------------------------------------------------------------------
// Recharts wrapper (SSR-safe, lazy)
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
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "#64748b" }}
              tickFormatter={(v: string) => v.slice(5)}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#64748b" }}
              allowDecimals={false}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(value: number, name: string) => [
                value,
                name === "total" ? "Tous mails" : "Support client",
              ]}
              labelFormatter={(label: string) => label}
              contentStyle={{
                fontSize: 12,
                borderRadius: 12,
                border: "1px solid #e2e8f0",
                boxShadow: "0 8px 24px rgba(15,23,42,0.08)",
              }}
            />
            <Legend
              verticalAlign="top"
              align="right"
              iconSize={10}
              wrapperStyle={{ fontSize: 12, paddingBottom: 12 }}
              formatter={(v: string) => (v === "total" ? "Tous mails" : "Support client")}
            />
            <Bar dataKey="total" fill="#c7d2fe" radius={[6, 6, 0, 0]} maxBarSize={32} />
            <Line
              type="monotone"
              dataKey="support"
              stroke="#4f46e5"
              strokeWidth={2.5}
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
  if (!mounted) return <div style={{ height: 260 }} />;

  return (
    <Suspense fallback={<div style={{ height: 260 }} />}>
      <RechartsChart data={data} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Activity chart (drafts + sent)
// ---------------------------------------------------------------------------

const RechartsActivityChart = lazy(() =>
  import("recharts").then((mod) => ({
    default: function ActivityChartInner({ data }: { data: DailyActivityPoint[] }) {
      const {
        ComposedChart,
        Line,
        XAxis,
        YAxis,
        Tooltip,
        ResponsiveContainer,
        Legend,
        CartesianGrid,
      } = mod;
      return (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "#64748b" }}
              tickFormatter={(v: string) => v.slice(5)}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#64748b" }}
              allowDecimals={false}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(value: number, name: string) => [
                value,
                name === "drafts" ? "Brouillons générés" : "Mails envoyés",
              ]}
              labelFormatter={(label: string) => label}
              contentStyle={{
                fontSize: 12,
                borderRadius: 12,
                border: "1px solid #e2e8f0",
                boxShadow: "0 8px 24px rgba(15,23,42,0.08)",
              }}
            />
            <Legend
              verticalAlign="top"
              align="right"
              iconSize={10}
              wrapperStyle={{ fontSize: 12, paddingBottom: 12 }}
              formatter={(v: string) => (v === "drafts" ? "Brouillons générés" : "Mails envoyés")}
            />
            <Line
              type="monotone"
              dataKey="drafts"
              stroke="#4f46e5"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey="sent"
              stroke="#10b981"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4 }}
              strokeDasharray="4 3"
            />
          </ComposedChart>
        </ResponsiveContainer>
      );
    },
  })),
);

function ActivityChartClient({ data }: { data: DailyActivityPoint[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div style={{ height: 260 }} />;

  return (
    <Suspense fallback={<div style={{ height: 260 }} />}>
      <RechartsActivityChart data={data} />
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
  no_reply_needed: "#94a3b8",
};

const INTENT_LABELS: Record<string, string> = {
  where_is_my_order: "Où est ma commande",
  delivery_delay: "Retard de livraison",
  marked_delivered_not_received: "Livré non reçu",
  package_stuck: "Colis bloqué",
  refund_request: "Remboursement",
  unknown: "Autre",
};

const PRESETS = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7 jours" },
  { key: "30d", label: "30 jours" },
  { key: "90d", label: "90 jours" },
] as const;

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const { range, kpis, daily, dailyActivity, threadStates, conversationStats, intents, today } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  const totalVar = variation(kpis.totalEmails, kpis.prevTotalEmails);
  const supportVar = variation(kpis.supportEmails, kpis.prevSupportEmails);
  const draftsVar = variation(kpis.draftsCreated, kpis.prevDraftsCreated);

  return (
    <s-page heading="Dashboard">
      <div className="ui-page">
        {/* Hero / period switcher --------------------------------------- */}
        <div className="ui-hero">
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 24,
              alignItems: "flex-end",
              justifyContent: "space-between",
            }}
          >
            <div style={{ minWidth: 280 }}>
              <span className="ui-hero__eyebrow">
                <TrendUpIcon size={14} />
                Vue d'ensemble
              </span>
              <h2 className="ui-hero__title">Performance de votre support client</h2>
              <p className="ui-hero__lead">
                Suivez les emails reçus, les conversations qualifiées en support, l'adoption des
                brouillons IA et l'état actuel de votre boîte mail — au {today}.
              </p>
            </div>
            <SegmentedTabs
              tabs={PRESETS}
              active={range as (typeof PRESETS)[number]["key"]}
              onChange={(k) => setSearchParams({ range: k })}
            />
          </div>
        </div>

        {/* KPI grid ------------------------------------------------------ */}
        <div className="ui-grid-4">
          <MetricCard
            label="Mails reçus"
            value={kpis.totalEmails.toLocaleString("fr-FR")}
            helper={totalVar?.label ?? "—"}
            helperTone={totalVar ? (totalVar.up ? "up" : "down") : "neutral"}
            icon={<MailIcon size={20} />}
            iconTone="info"
          />
          <MetricCard
            label="Support client"
            value={kpis.supportEmails.toLocaleString("fr-FR")}
            helper={supportVar?.label ?? "—"}
            helperTone={supportVar ? (supportVar.up ? "up" : "down") : "neutral"}
            icon={<SparklesIcon size={20} />}
            iconTone="primary"
          />
          <MetricCard
            label="Brouillons créés"
            value={kpis.draftsCreated.toLocaleString("fr-FR")}
            helper={draftsVar?.label ?? "—"}
            helperTone={draftsVar ? (draftsVar.up ? "up" : "down") : "neutral"}
            icon={<CheckCircleIcon size={20} />}
            iconTone="success"
          />
          <MetricCard
            label="Mails envoyés"
            value="—"
            icon={<SendIcon size={20} />}
            iconTone="warning"
            badge={<Pill tone="info">Bientôt disponible</Pill>}
          />
        </div>

        {/* Full-width charts -------------------------------------------- */}
        <Card title="Tendances sur la période" subtitle="Emails reçus · Brouillons générés et envoyés">
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ui-slate-400)", marginBottom: 8 }}>
                Mails reçus par jour
              </div>
              <BarChartClient data={daily} />
            </div>
            <div style={{ borderTop: "1px solid var(--ui-slate-100)", paddingTop: 20, marginTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ui-slate-400)", marginBottom: 8 }}>
                Activité IA par jour
              </div>
              <ActivityChartClient data={dailyActivity} />
            </div>
          </div>
        </Card>

        {/* Stats grid --------------------------------------------------- */}
        <div className="ui-grid-2" style={{ alignItems: "start" }}>
          <Card
            title={`État actuel · ${today}`}
            subtitle="Statut opérationnel de toutes les conversations"
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {(Object.keys(STATE_LABELS) as Array<keyof ThreadStateCounts>).map((state) => (
                <StatRow
                  key={state}
                  label={STATE_LABELS[state]}
                  value={(threadStates[state] ?? 0).toLocaleString("fr-FR")}
                  dotColor={STATE_COLORS[state]}
                />
              ))}
            </div>
          </Card>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Card
              title="Conversations (période)"
              right={<ChartIcon size={18} style={{ color: "var(--ui-slate-400)" }} />}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <StatRow
                  label="Nouvelles"
                  value={conversationStats.newConversations.toLocaleString("fr-FR")}
                />
                <StatRow
                  label="Résolues"
                  value={conversationStats.resolvedConversations.toLocaleString("fr-FR")}
                />
                <StatRow
                  label="Rouvertes"
                  value={conversationStats.reopenedConversations.toLocaleString("fr-FR")}
                />
              </div>
            </Card>

            <Card title="Top intentions" subtitle="Intentions détectées les plus fréquentes">
              {intents.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--ui-slate-500)", margin: 0 }}>
                  Aucune donnée sur la période.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {intents.map(({ intent, count }: IntentCount) => (
                    <StatRow
                      key={intent}
                      label={INTENT_LABELS[intent] ?? intent}
                      value={count.toLocaleString("fr-FR")}
                    />
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </s-page>
  );
}
