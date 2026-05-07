import { useEffect, useState, Suspense, lazy } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { authenticate } from "../shopify.server";
import {
  getPeriodBounds,
  getDashboardKpis,
  getResponseTimeDailyBreakdown,
  getDraftUsageDailyBreakdown,
  getHeatmap,
  getTopIntentsWithPerf,
  getCurrentThreadStates,
  getReopenedThreads,
  getAlerts,
  type DashboardKpis,
  type ResponseTimeDailyPoint,
  type ProductivityDailyPoint,
  type HeatmapCell,
  type IntentPerf,
  type ThreadStateCounts,
  type ReopenedThread,
  type Alert,
} from "../lib/dashboard-stats";
import {
  Card,
  MetricCard,
  StatRow,
  AlertBanner,
  HeatMap,
  TopIntentsList,
  ClockIcon,
  RefreshIcon,
  SparklesIcon,
  MailIcon,
  type AlertItem,
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

  const [kpis, qualityChart, productivityChart, heatmap, topIntents, threadStates, reopened, alerts] =
    await Promise.all([
      getDashboardKpis(shop, start, end, prevStart, prevEnd),
      getResponseTimeDailyBreakdown(shop, start, end),
      getDraftUsageDailyBreakdown(shop, start, end),
      getHeatmap(shop, start, end),
      getTopIntentsWithPerf(shop, start, end, 5),
      getCurrentThreadStates(shop),
      getReopenedThreads(shop, start, end, 10),
      getAlerts(shop, range, start, end),
    ]);

  return {
    range,
    from: from ?? null,
    to: to ?? null,
    kpis,
    qualityChart,
    productivityChart,
    heatmap,
    topIntents,
    threadStates,
    reopened,
    alerts,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const h = ms / 3_600_000;
  if (h >= 1) return `${h.toFixed(1)}h`;
  const m = ms / 60_000;
  if (m >= 1) return `${Math.round(m)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function variationLabel(current: number, prev: number): string | null {
  if (prev === 0) return null;
  const pct = ((current - prev) / prev) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${Math.abs(pct).toFixed(0)}%`;
}

// ---------------------------------------------------------------------------
// Quality chart (volume bars + median response line) — SSR-safe lazy
// ---------------------------------------------------------------------------

const QualityCombinedChart = lazy(() =>
  import("recharts").then((mod) => ({
    default: function QualityChartInner({ data }: { data: ResponseTimeDailyPoint[] }) {
      const {
        ComposedChart, Bar, Line, XAxis, YAxis, Tooltip,
        ResponsiveContainer, CartesianGrid,
      } = mod;
      return (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 8, right: 32, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "#64748b" }}
              tickFormatter={(v: string) => v.slice(5)}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              yAxisId="vol"
              tick={{ fontSize: 11, fill: "#64748b" }}
              allowDecimals={false}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              yAxisId="time"
              orientation="right"
              tickFormatter={(v: number) =>
                v >= 3_600_000
                  ? `${(v / 3_600_000).toFixed(0)}h`
                  : `${Math.round(v / 60_000)}m`
              }
              tick={{ fontSize: 11, fill: "#64748b" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={(value: any, name: any) => {
                if (name === "support") return [value, "Emails support"];
                if (name === "medianMs") return [formatDuration(value as number), "Médian réponse"];
                return [value, name];
              }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              labelFormatter={(l: any) => l}
              contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #e2e8f0" }}
            />
            <Bar yAxisId="vol" dataKey="support" fill="#c7d2fe" radius={[6, 6, 0, 0]} maxBarSize={32} />
            <Line
              yAxisId="time"
              type="monotone"
              dataKey="medianMs"
              stroke="#4f46e5"
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      );
    },
  })),
);

function QualityChartClient({ data }: { data: ResponseTimeDailyPoint[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div style={{ height: 260 }} />;
  return (
    <Suspense fallback={<div style={{ height: 260 }} />}>
      <QualityCombinedChart data={data} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Productivity chart (stacked bars by bucket) — SSR-safe lazy
// ---------------------------------------------------------------------------

const StackedDailyBars = lazy(() =>
  import("recharts").then((mod) => ({
    default: function StackedBarsInner({ data }: { data: ProductivityDailyPoint[] }) {
      const {
        BarChart, Bar, XAxis, YAxis, Tooltip,
        ResponsiveContainer, CartesianGrid, Legend,
      } = mod;
      return (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
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
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={(value: any, name: any) => [
                value,
                name === "as_is" ? "Envoyé tel quel" : name === "edited" ? "Modifié" : "Ignoré",
              ]}
              contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #e2e8f0" }}
            />
            <Legend
              formatter={(v: string) =>
                v === "as_is" ? "Tel quel" : v === "edited" ? "Modifié" : "Ignoré"
              }
              iconSize={10}
              wrapperStyle={{ fontSize: 12 }}
            />
            <Bar dataKey="as_is" stackId="a" fill="#4f46e5" maxBarSize={32} />
            <Bar dataKey="edited" stackId="a" fill="#a5b4fc" maxBarSize={32} />
            <Bar dataKey="ignored" stackId="a" fill="#94a3b8" radius={[6, 6, 0, 0]} maxBarSize={32} />
          </BarChart>
        </ResponsiveContainer>
      );
    },
  })),
);

function ProductivityChartClient({ data }: { data: ProductivityDailyPoint[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div style={{ height: 260 }} />;
  return (
    <Suspense fallback={<div style={{ height: 260 }} />}>
      <StackedDailyBars data={data} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Period selector
// ---------------------------------------------------------------------------

const PRESETS = ["24h", "7d", "30d", "90d"] as const;

function PeriodSelector({ range }: { range: string }) {
  const [, setSearchParams] = useSearchParams();
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {PRESETS.map((p) => (
        <button
          key={p}
          onClick={() => setSearchParams({ range: p })}
          style={{
            padding: "4px 12px",
            borderRadius: 8,
            border: "1px solid",
            borderColor: range === p ? "#4f46e5" : "#e2e8f0",
            background: range === p ? "#4f46e5" : "white",
            color: range === p ? "white" : "#334155",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

// Suppress unused-variable lint for types only used in the loader return shape
type _Used = DashboardKpis | IntentPerf | ReopenedThread | Alert | HeatmapCell | ThreadStateCounts;

export default function Dashboard() {
  const {
    range, kpis, qualityChart, productivityChart,
    heatmap, topIntents, threadStates, reopened, alerts,
  } = useLoaderData<typeof loader>();
  const { t } = useTranslation();

  // Build delta helper text for MetricCards (MetricCard uses helper/helperTone, not delta props)
  const respVariation = variationLabel(
    kpis.responseTime.medianMs ?? 0,
    kpis.responseTime.prevMedianMs ?? 0,
  );
  const reopenVariation = variationLabel(kpis.reopened.count, kpis.reopened.prevCount);
  const volVariation = variationLabel(kpis.volume.count, kpis.volume.prevCount);
  const draftVariation =
    kpis.draftUsage.sentPct !== null && kpis.draftUsage.prevSentPct !== null
      ? variationLabel(kpis.draftUsage.sentPct, kpis.draftUsage.prevSentPct)
      : null;

  // Determine tone (up = good or bad depending on the metric)
  const respTone: "up" | "down" | "neutral" = respVariation
    ? kpis.responseTime.medianMs !== null &&
      kpis.responseTime.prevMedianMs !== null &&
      kpis.responseTime.medianMs < kpis.responseTime.prevMedianMs
      ? "down" // lower response time = better → green
      : "up"
    : "neutral";

  const reopenTone: "up" | "down" | "neutral" = reopenVariation
    ? kpis.reopened.count < kpis.reopened.prevCount
      ? "down"
      : "up"
    : "neutral";

  const draftTone: "up" | "down" | "neutral" = draftVariation
    ? kpis.draftUsage.sentPct !== null &&
      kpis.draftUsage.prevSentPct !== null &&
      kpis.draftUsage.sentPct > kpis.draftUsage.prevSentPct
      ? "up"
      : "down"
    : "neutral";

  const stateRows: { key: keyof ThreadStateCounts; label: string }[] = [
    { key: "open", label: t("dashboard.stateOpen", { defaultValue: "Ouvert" }) },
    { key: "waiting_customer", label: t("dashboard.stateWaitingCustomer", { defaultValue: "En attente client" }) },
    { key: "waiting_merchant", label: t("dashboard.stateWaitingMerchant", { defaultValue: "En attente marchand" }) },
    { key: "resolved", label: t("dashboard.stateResolved", { defaultValue: "Résolu" }) },
    { key: "no_reply_needed", label: t("dashboard.stateNoReplyNeeded", { defaultValue: "Sans réponse" }) },
  ];

  // Alert type is a superset of AlertItem — cast is safe (extra fields are ignored by AlertBanner)
  const alertItems = alerts as AlertItem[];

  return (
    <div
      style={{
        maxWidth: 1100,
        margin: "0 auto",
        padding: "24px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      {/* Hero */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 12,
              color: "#64748b",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 4,
            }}
          >
            {t("dashboard.eyebrow", { defaultValue: "Pilotage SAV" })}
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#0f172a" }}>
            {t("dashboard.heroTitle", { defaultValue: "Dashboard" })}
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#64748b" }}>
            {t("dashboard.heroLead", { defaultValue: "Vue d'ensemble de votre activité SAV" })}
          </p>
        </div>
        <PeriodSelector range={range} />
      </div>

      {/* Alert banner */}
      {alertItems.length > 0 && <AlertBanner alerts={alertItems} />}

      {/* 4 KPIs */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 12,
        }}
      >
        <MetricCard
          icon={<ClockIcon />}
          label={t("dashboard.kpiMedianResponse", { defaultValue: "Délai 1re réponse" })}
          value={formatDuration(kpis.responseTime.medianMs)}
          helper={
            respVariation
              ? `${respVariation}${kpis.responseTime.p90Ms !== null ? ` · P90 : ${formatDuration(kpis.responseTime.p90Ms)}` : ""}`
              : kpis.responseTime.p90Ms !== null
                ? `P90 : ${formatDuration(kpis.responseTime.p90Ms)}`
                : undefined
          }
          helperTone={respTone}
        />
        <MetricCard
          icon={<RefreshIcon />}
          label={t("dashboard.kpiReopened", { defaultValue: "Threads ré-ouverts" })}
          value={String(kpis.reopened.count)}
          helper={reopenVariation ?? undefined}
          helperTone={reopenTone}
        />
        <MetricCard
          icon={<SparklesIcon />}
          label={t("dashboard.kpiDraftsSent", { defaultValue: "Drafts utilisés" })}
          value={kpis.draftUsage.sentPct !== null ? `${kpis.draftUsage.sentPct}%` : "—"}
          helper={
            draftVariation
              ? `${draftVariation} · ${kpis.draftUsage.asIs} tel quel · ${kpis.draftUsage.edited} modifié · ${kpis.draftUsage.ignored} ignoré`
              : kpis.draftUsage.sentPct !== null
                ? `${kpis.draftUsage.asIs} tel quel · ${kpis.draftUsage.edited} modifié · ${kpis.draftUsage.ignored} ignoré`
                : t("dashboard.noData", { defaultValue: "Pas encore de données" })
          }
          helperTone={draftTone}
        />
        <MetricCard
          icon={<MailIcon />}
          label={t("dashboard.kpiVolume", { defaultValue: "Emails support" })}
          value={String(kpis.volume.count)}
          helper={volVariation ?? undefined}
        />
      </div>

      {/* Quality chart */}
      <Card
        title={t("dashboard.qualityTitle", { defaultValue: "Qualité du service" })}
        subtitle={t("dashboard.qualitySubtitle", { defaultValue: "Volume support + délai médian de réponse par jour" })}
      >
        <QualityChartClient data={qualityChart} />
      </Card>

      {/* Productivity chart */}
      <Card
        title={t("dashboard.productivityTitle", { defaultValue: "Productivité IA" })}
        subtitle={t("dashboard.productivitySubtitle", { defaultValue: "Utilisation des drafts générés · calculé heuristiquement" })}
      >
        <ProductivityChartClient data={productivityChart} />
      </Card>

      {/* Patterns: heatmap + top intents */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Card
          title={t("dashboard.heatmapTitle", { defaultValue: "Pics d'activité" })}
          subtitle={t("dashboard.heatmapSubtitle", { defaultValue: "Emails support reçus par jour × heure" })}
        >
          <HeatMap cells={heatmap} />
        </Card>
        <Card
          title={t("dashboard.topIntentsTitle", { defaultValue: "Top motifs" })}
          subtitle={t("dashboard.topIntentsSubtitle", { defaultValue: "Par nombre de threads · médian de réponse" })}
        >
          {topIntents.length === 0 ? (
            <p style={{ fontSize: 13, color: "#94a3b8" }}>
              {t("dashboard.noData", { defaultValue: "Pas encore de données" })}
            </p>
          ) : (
            <TopIntentsList items={topIntents} t={t} />
          )}
        </Card>
      </div>

      {/* Drill-downs: queue + reopened threads */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Card
          title={t("dashboard.stateCardTitle", { defaultValue: "État de la file" })}
          subtitle={t("dashboard.stateCardSubtitle", { defaultValue: "Snapshot actuel — non filtré par période" })}
        >
          {stateRows.map(({ key, label }) => (
            <StatRow key={key} label={label} value={threadStates[key]} />
          ))}
        </Card>
        <Card
          title={t("dashboard.reopenedTitle", { defaultValue: "Threads ré-ouverts récents" })}
          subtitle={t("dashboard.reopenedSubtitle", { defaultValue: "Signal qualité : resolved puis ré-ouverts sur la période" })}
        >
          {reopened.length === 0 ? (
            <p style={{ fontSize: 13, color: "#94a3b8" }}>
              {t("dashboard.noData", { defaultValue: "Aucun" })}
            </p>
          ) : (
            reopened.map((r) => (
              <a
                key={r.threadId}
                href={`/app/inbox?thread=${r.threadId}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "6px 0",
                  borderBottom: "1px solid #f1f5f9",
                  textDecoration: "none",
                  color: "inherit",
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    color: "#334155",
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.threadId.slice(0, 12)}…
                </span>
                <span style={{ color: "#64748b", marginLeft: 8, whiteSpace: "nowrap" }}>
                  ×{r.reopenCount} ·{" "}
                  {new Date(r.lastReopenedAt).toLocaleDateString("fr-FR")}
                </span>
              </a>
            ))
          )}
        </Card>
      </div>
    </div>
  );
}
