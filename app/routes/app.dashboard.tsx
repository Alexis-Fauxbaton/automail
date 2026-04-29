import { useEffect, useState, Suspense, lazy } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
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

function variationPct(current: number, prev: number): { pct: number; up: boolean } | null {
  if (prev === 0) return null;
  const diff = ((current - prev) / prev) * 100;
  return { pct: diff, up: diff >= 0 };
}

// ---------------------------------------------------------------------------
// Recharts wrapper (SSR-safe, lazy)
// ---------------------------------------------------------------------------

const RechartsChart = lazy(() =>
  import("recharts").then((mod) => ({
    default: function RechartsChartInner({
      data,
      labels,
    }: {
      data: DailyPoint[];
      labels: { allMails: string; support: string };
    }) {
      const { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } = mod;
      return (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(v: string) => v.slice(5)} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: "#64748b" }} allowDecimals={false} axisLine={false} tickLine={false} />
            <Tooltip
              formatter={(value: number, name: string) => [value, name === "total" ? labels.allMails : labels.support]}
              labelFormatter={(label: string) => label}
              contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #e2e8f0", boxShadow: "0 8px 24px rgba(15,23,42,0.08)" }}
            />
            <Legend verticalAlign="top" align="right" iconSize={10} wrapperStyle={{ fontSize: 12, paddingBottom: 12 }} formatter={(v: string) => v === "total" ? labels.allMails : labels.support} />
            <Bar dataKey="total" fill="#c7d2fe" radius={[6, 6, 0, 0]} maxBarSize={32} />
            <Line type="monotone" dataKey="support" stroke="#4f46e5" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
          </ComposedChart>
        </ResponsiveContainer>
      );
    },
  })),
);

function BarChartClient({ data, labels }: { data: DailyPoint[]; labels: { allMails: string; support: string } }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div style={{ height: 260 }} />;
  return (
    <Suspense fallback={<div style={{ height: 260 }} />}>
      <RechartsChart data={data} labels={labels} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Activity chart (drafts + sent)
// ---------------------------------------------------------------------------

const RechartsActivityChart = lazy(() =>
  import("recharts").then((mod) => ({
    default: function ActivityChartInner({
      data,
      labels,
    }: {
      data: DailyActivityPoint[];
      labels: { drafts: string; sent: string };
    }) {
      const { ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } = mod;
      return (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(v: string) => v.slice(5)} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: "#64748b" }} allowDecimals={false} axisLine={false} tickLine={false} />
            <Tooltip
              formatter={(value: number, name: string) => [value, name === "drafts" ? labels.drafts : labels.sent]}
              labelFormatter={(label: string) => label}
              contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #e2e8f0", boxShadow: "0 8px 24px rgba(15,23,42,0.08)" }}
            />
            <Legend verticalAlign="top" align="right" iconSize={10} wrapperStyle={{ fontSize: 12, paddingBottom: 12 }} formatter={(v: string) => v === "drafts" ? labels.drafts : labels.sent} />
            <Line type="monotone" dataKey="drafts" stroke="#4f46e5" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
            <Line type="monotone" dataKey="sent" stroke="#10b981" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} strokeDasharray="4 3" />
          </ComposedChart>
        </ResponsiveContainer>
      );
    },
  })),
);

function ActivityChartClient({ data, labels }: { data: DailyActivityPoint[]; labels: { drafts: string; sent: string } }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div style={{ height: 260 }} />;
  return (
    <Suspense fallback={<div style={{ height: 260 }} />}>
      <RechartsActivityChart data={data} labels={labels} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const { range, kpis, daily, dailyActivity, threadStates, conversationStats, intents, today } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const { t } = useTranslation();

  const totalVar = variationPct(kpis.totalEmails, kpis.prevTotalEmails);
  const supportVar = variationPct(kpis.supportEmails, kpis.prevSupportEmails);
  const draftsVar = variationPct(kpis.draftsCreated, kpis.prevDraftsCreated);

  function varLabel(v: { pct: number; up: boolean } | null): string {
    if (!v) return "—";
    return (v.up ? "↑ +" : "↓ ") + Math.abs(v.pct).toFixed(0) + t("dashboard.vsPrev");
  }

  const stateLabels: Record<string, string> = {
    open: t("dashboard.stateOpen"),
    waiting_customer: t("dashboard.stateWaitingCustomer"),
    waiting_merchant: t("dashboard.stateWaitingMerchant"),
    resolved: t("dashboard.stateResolved"),
    no_reply_needed: t("dashboard.stateNoReplyNeeded"),
  };

  const stateColors: Record<string, string> = {
    open: "#ef4444",
    waiting_customer: "#f59e0b",
    waiting_merchant: "#3b82f6",
    resolved: "#22c55e",
    no_reply_needed: "#94a3b8",
  };

  const intentLabels: Record<string, string> = {
    where_is_my_order: t("analysis.intent_where_is_my_order"),
    delivery_delay: t("analysis.intent_delivery_delay"),
    marked_delivered_not_received: t("analysis.intent_marked_delivered_not_received"),
    package_stuck: t("analysis.intent_package_stuck"),
    refund_request: t("analysis.intent_refund_request"),
    unknown: t("analysis.intent_unknown"),
  };

  const presets = [
    { key: "24h", label: t("dashboard.preset24h") },
    { key: "7d", label: t("dashboard.preset7d") },
    { key: "30d", label: t("dashboard.preset30d") },
    { key: "90d", label: t("dashboard.preset90d") },
  ] as const;

  const barLabels = { allMails: t("dashboard.chartAllMails"), support: t("dashboard.chartSupport") };
  const activityLabels = { drafts: t("dashboard.chartDrafts"), sent: t("dashboard.chartSent") };

  return (
    <s-page heading={t("dashboard.pageHeading")}>
      <div className="ui-page">
        <div className="ui-hero">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-end", justifyContent: "space-between" }}>
            <div style={{ minWidth: 280 }}>
              <span className="ui-hero__eyebrow">
                <TrendUpIcon size={14} />
                {t("dashboard.eyebrow")}
              </span>
              <h2 className="ui-hero__title">{t("dashboard.heroTitle")}</h2>
              <p className="ui-hero__lead">{t("dashboard.heroLead", { date: today })}</p>
            </div>
            <SegmentedTabs
              tabs={presets}
              active={range as (typeof presets)[number]["key"]}
              onChange={(k) => setSearchParams({ range: k })}
            />
          </div>
        </div>

        <div className="ui-grid-4">
          <MetricCard label={t("dashboard.kpiTotalEmails")} value={kpis.totalEmails.toLocaleString("fr-FR")} helper={varLabel(totalVar)} helperTone={totalVar ? (totalVar.up ? "up" : "down") : "neutral"} icon={<MailIcon size={20} />} iconTone="info" />
          <MetricCard label={t("dashboard.kpiSupportEmails")} value={kpis.supportEmails.toLocaleString("fr-FR")} helper={varLabel(supportVar)} helperTone={supportVar ? (supportVar.up ? "up" : "down") : "neutral"} icon={<SparklesIcon size={20} />} iconTone="primary" />
          <MetricCard label={t("dashboard.kpiDraftsCreated")} value={kpis.draftsCreated.toLocaleString("fr-FR")} helper={varLabel(draftsVar)} helperTone={draftsVar ? (draftsVar.up ? "up" : "down") : "neutral"} icon={<CheckCircleIcon size={20} />} iconTone="success" />
          <MetricCard label={t("dashboard.kpiEmailsSent")} value="—" icon={<SendIcon size={20} />} iconTone="warning" badge={<Pill tone="info">{t("dashboard.comingSoon")}</Pill>} />
        </div>

        <Card title={t("dashboard.chartTitle")} subtitle={t("dashboard.chartSubtitle")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ui-slate-400)", marginBottom: 8 }}>
                {t("dashboard.mailsPerDay")}
              </div>
              <div data-testid="chart-daily-breakdown">
                <BarChartClient data={daily} labels={barLabels} />
              </div>
            </div>
            <div style={{ borderTop: "1px solid var(--ui-slate-100)", paddingTop: 20, marginTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ui-slate-400)", marginBottom: 8 }}>
                {t("dashboard.aiActivityPerDay")}
              </div>
              <ActivityChartClient data={dailyActivity} labels={activityLabels} />
            </div>
          </div>
        </Card>

        <div className="ui-grid-2" style={{ alignItems: "start" }}>
          <Card title={t("dashboard.stateCardTitle", { date: today })} subtitle={t("dashboard.stateCardSubtitle")}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {(Object.keys(stateLabels) as Array<keyof ThreadStateCounts>).map((state) => (
                <StatRow key={state} label={stateLabels[state]} value={(threadStates[state] ?? 0).toLocaleString("fr-FR")} dotColor={stateColors[state]} />
              ))}
            </div>
          </Card>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Card title={t("dashboard.conversationsTitle")} right={<ChartIcon size={18} style={{ color: "var(--ui-slate-400)" }} />}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <StatRow label={t("dashboard.conversationsNew")} value={conversationStats.newConversations.toLocaleString("fr-FR")} />
                <StatRow label={t("dashboard.conversationsResolved")} value={conversationStats.resolvedConversations.toLocaleString("fr-FR")} />
                <StatRow label={t("dashboard.conversationsReopened")} value={conversationStats.reopenedConversations.toLocaleString("fr-FR")} />
              </div>
            </Card>

            <Card title={t("dashboard.topIntents")} subtitle={t("dashboard.topIntentsSubtitle")}>
              {intents.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--ui-slate-500)", margin: 0 }}>{t("dashboard.noData")}</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {intents.map(({ intent, count }: IntentCount) => (
                    <StatRow key={intent} label={intentLabels[intent] ?? intent} value={count.toLocaleString("fr-FR")} />
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
