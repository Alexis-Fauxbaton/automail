import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { metrics } from "../lib/metrics/registry";
import {
  getJobStatsPerShop,
  getLlmCostPerShop,
  getPipelineHealth,
  getDbPoolStats,
  getClassificationHealthPerShop,
  type ShopJobStats,
  type ShopLlmCost,
  type StuckCounts,
  type DbPoolStats,
  type ShopClassificationHealth,
} from "../lib/metrics/stats";

/**
 * GET /app/metrics — internal operational dashboard.
 *
 * Visibility model: gated by `ShopFlag.isInternal` (same pattern as
 * api.repair-zoho-images.tsx). Any merchant who is NOT flagged internal
 * sees a 404. Operators flip the flag manually in DB:
 *   UPDATE "ShopFlag" SET "isInternal" = true WHERE shop = '<your-shop>';
 *
 * Data sources:
 *   - In-memory `metrics` registry (counters, gauges, histograms) for
 *     real-time state on THIS worker.
 *   - SQL queries against SyncJob / LlmCallLog / IncomingEmail / pg_stat_*
 *     for historical / cross-worker data.
 *
 * Refresh model: page is fully server-rendered; refresh in the browser
 * to update. Adding auto-refresh would be a 5-line change but is left
 * off so the page doesn't burn DB queries when an operator is just
 * watching logs.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const flag = await prisma.shopFlag.findUnique({
    where: { shop },
    select: { isInternal: true },
  });
  if (!flag?.isInternal) {
    // Return a marker object instead of throwing a Response. Throwing a
    // bare Response surfaces in the parent error boundary as "[object
    // Object]", which is useless to an operator and confusing to a
    // non-internal merchant who lands here by accident.
    return { notAuthorized: true as const, shop };
  }

  const [jobStats, llmCosts, pipelineHealth, dbPool, classificationHealth] = await Promise.all([
    getJobStatsPerShop(24).catch(() => [] as ShopJobStats[]),
    getLlmCostPerShop(24).catch(() => [] as ShopLlmCost[]),
    getPipelineHealth().catch(
      () =>
        ({ totalIngested: 0, totalError: 0, totalAnalyzed24h: 0 }) as StuckCounts,
    ),
    getDbPoolStats().catch(() => null as DbPoolStats | null),
    getClassificationHealthPerShop().catch(() => [] as ShopClassificationHealth[]),
  ]);

  const snapshot = metrics.snapshot();
  const sumCounter = (
    name: string,
    filter?: (l: Record<string, string>) => boolean,
  ): number => {
    const c = snapshot.counters.find((x) => x.name === name);
    if (!c) return 0;
    return c.series
      .filter((s) => (filter ? filter(s.labels) : true))
      .reduce((acc, s) => acc + s.value, 0);
  };
  const gaugeValue = (
    name: string,
    filter?: (l: Record<string, string>) => boolean,
  ): number => {
    const g = snapshot.gauges.find((x) => x.name === name);
    if (!g) return 0;
    return g.series
      .filter((s) => (filter ? filter(s.labels) : true))
      .reduce((acc, s) => acc + s.value, 0);
  };

  return {
    realTime: {
      autoSyncInFlight: gaugeValue("auto_sync_in_flight"),
      autoSyncLeader: gaugeValue("auto_sync_leader") === 1,
      llmInFlight: gaugeValue("llm_semaphore_in_flight"),
      llmQueued: gaugeValue("llm_semaphore_queued"),
      breakers: (snapshot.gauges.find((g) => g.name === "breaker_state")?.series ?? [])
        .map((s) => ({
          name: s.labels.name ?? "?",
          state: s.value === 1 ? "open" : "closed",
        })),
      jobsTotalOk: sumCounter("auto_sync_jobs_total", (l) => l.status === "ok"),
      jobsTotalError: sumCounter("auto_sync_jobs_total", (l) => l.status === "error"),
      jobsTotalSuspended: sumCounter("auto_sync_jobs_total", (l) => l.status === "suspended"),
      llmCallsOk: sumCounter("llm_calls_total", (l) => l.status === "ok"),
      llmCallsRateLimited: sumCounter("llm_calls_total", (l) => l.status === "rate_limited"),
      llmCallsError: sumCounter("llm_calls_total", (l) => l.status === "error"),
      llmCallsBreakerOpen: sumCounter("llm_calls_total", (l) => l.status === "breaker_open"),
      llmCostUsd: sumCounter("llm_cost_usd_total"),
    },
    jobStats,
    llmCosts,
    pipelineHealth,
    dbPool,
    classificationHealth,
    selfHealTotal: sumCounter("outgoing_self_heal_total"),
    instance: {
      nodeVersion: process.version,
      uptimeSec: Math.round(process.uptime()),
    },
  };
}

// Defaults for every loader-returned field. If any reaches the component
// undefined (stale bundle, partial deploy, future schema change) the page
// still renders a useful empty state instead of crashing with
// "Cannot read properties of undefined". This is a debug surface — graceful
// degradation matters more than strict typing.
const FALLBACK = {
  realTime: {
    autoSyncInFlight: 0,
    autoSyncLeader: false,
    llmInFlight: 0,
    llmQueued: 0,
    breakers: [] as Array<{ name: string; state: string }>,
    jobsTotalOk: 0,
    jobsTotalError: 0,
    jobsTotalSuspended: 0,
    llmCallsOk: 0,
    llmCallsRateLimited: 0,
    llmCallsError: 0,
    llmCallsBreakerOpen: 0,
    llmCostUsd: 0,
  },
  jobStats: [] as ShopJobStats[],
  llmCosts: [] as ShopLlmCost[],
  pipelineHealth: { totalIngested: 0, totalError: 0, totalAnalyzed24h: 0 } as StuckCounts,
  dbPool: null as DbPoolStats | null,
  classificationHealth: [] as ShopClassificationHealth[],
  selfHealTotal: 0,
  instance: { nodeVersion: "?", uptimeSec: 0 },
};

export default function MetricsPage() {
  const raw = useLoaderData<typeof loader>() as
    | { notAuthorized: true; shop: string }
    | (Record<string, unknown> & { notAuthorized?: undefined });

  if (raw && "notAuthorized" in raw && raw.notAuthorized) {
    return (
      <div style={{ padding: 32, fontFamily: "ui-sans-serif, system-ui", maxWidth: 720 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 12px" }}>
          Metrics dashboard — access required
        </h1>
        <p style={{ color: "#475569", fontSize: 14, lineHeight: 1.5 }}>
          This page is gated to operators only. To enable it for the shop{" "}
          <code style={inlineCode}>{raw.shop}</code>, run the following SQL on the
          Render Postgres instance:
        </p>
        <pre style={preBlock}>{`UPDATE "ShopFlag" SET "isInternal" = true WHERE shop = '${raw.shop}';`}</pre>
        <p style={{ color: "#64748b", fontSize: 13 }}>
          Then reload this page. Flip back to <code style={inlineCode}>false</code> when
          you no longer need the dashboard.
        </p>
      </div>
    );
  }

  // Merge with defaults so any missing key from a stale bundle survives.
  const data = {
    realTime: { ...FALLBACK.realTime, ...((raw as Record<string, unknown>)?.realTime as object ?? {}) },
    jobStats: ((raw as Record<string, unknown>)?.jobStats as ShopJobStats[]) ?? FALLBACK.jobStats,
    llmCosts: ((raw as Record<string, unknown>)?.llmCosts as ShopLlmCost[]) ?? FALLBACK.llmCosts,
    pipelineHealth:
      ((raw as Record<string, unknown>)?.pipelineHealth as StuckCounts) ??
      FALLBACK.pipelineHealth,
    dbPool: ((raw as Record<string, unknown>)?.dbPool as DbPoolStats | null) ?? FALLBACK.dbPool,
    classificationHealth:
      ((raw as Record<string, unknown>)?.classificationHealth as ShopClassificationHealth[]) ??
      FALLBACK.classificationHealth,
    selfHealTotal:
      ((raw as Record<string, unknown>)?.selfHealTotal as number | undefined) ?? FALLBACK.selfHealTotal,
    instance: { ...FALLBACK.instance, ...((raw as Record<string, unknown>)?.instance as object ?? {}) },
  };

  return (
    <div style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui", maxWidth: 1200 }}>
      <header style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Operational metrics</h1>
        <div style={{ fontSize: 12, color: "#64748b" }}>
          Internal-only · uptime {formatDuration(data.instance.uptimeSec)} · Node {data.instance.nodeVersion}
        </div>
      </header>

      <Section title="Real-time (this worker)">
        <Grid>
          <Card label="Leader" value={data.realTime.autoSyncLeader ? "yes" : "follower"} tone={data.realTime.autoSyncLeader ? "good" : "muted"} />
          <Card label="Jobs in flight" value={String(data.realTime.autoSyncInFlight)} />
          <Card label="LLM in flight" value={String(data.realTime.llmInFlight)} />
          <Card label="LLM queued" value={String(data.realTime.llmQueued)} tone={data.realTime.llmQueued > 5 ? "warning" : "muted"} />
        </Grid>
      </Section>

      <Section title="Circuit breakers">
        {data.realTime.breakers.length === 0 ? (
          <p style={muted}>No breakers registered yet. They'll appear after the first call.</p>
        ) : (
          <Grid>
            {data.realTime.breakers.map((b) => (
              <Card
                key={b.name}
                label={b.name}
                value={b.state}
                tone={b.state === "open" ? "danger" : "good"}
              />
            ))}
          </Grid>
        )}
      </Section>

      <Section title="Process counters (since boot)">
        <Grid>
          <Card label="Jobs OK" value={String(data.realTime.jobsTotalOk)} tone="good" />
          <Card label="Jobs failed" value={String(data.realTime.jobsTotalError)} tone={data.realTime.jobsTotalError > 0 ? "warning" : "muted"} />
          <Card label="Jobs suspended" value={String(data.realTime.jobsTotalSuspended)} tone="muted" />
          <Card label="LLM calls OK" value={String(data.realTime.llmCallsOk)} tone="good" />
          <Card label="LLM 429s" value={String(data.realTime.llmCallsRateLimited)} tone={data.realTime.llmCallsRateLimited > 0 ? "warning" : "muted"} />
          <Card label="LLM errors" value={String(data.realTime.llmCallsError)} tone={data.realTime.llmCallsError > 0 ? "warning" : "muted"} />
          <Card label="LLM breaker-open" value={String(data.realTime.llmCallsBreakerOpen)} tone={data.realTime.llmCallsBreakerOpen > 0 ? "danger" : "muted"} />
          <Card label="LLM cost (this proc)" value={`$${data.realTime.llmCostUsd.toFixed(4)}`} />
        </Grid>
      </Section>

      <Section title="Pipeline health">
        <Grid>
          <Card label="Emails ingested-not-analyzed" value={String(data.pipelineHealth.totalIngested)} tone={data.pipelineHealth.totalIngested > 100 ? "warning" : "muted"} />
          <Card label="Emails in error state" value={String(data.pipelineHealth.totalError)} tone={data.pipelineHealth.totalError > 50 ? "warning" : "muted"} />
          <Card label="Emails analyzed (24h)" value={String(data.pipelineHealth.totalAnalyzed24h)} tone="good" />
        </Grid>
        <p style={muted}>
          “Ingested” should drain quickly; a chronic backlog means Pass 2 isn't running.
        </p>
      </Section>

      <Section title="Classification health">
        <Grid>
          <Card
            label="Self-healed rows (outgoing → ingested)"
            value={String(data.selfHealTotal)}
            tone={data.selfHealTotal > 0 ? "warning" : "muted"}
          />
        </Grid>
        <p style={muted}>
          Non-zero ⇒ at least one row was tagged outgoing despite the sender not being on the merchant's allow-list. Indicates a provider direction bug — check recent Zoho/Gmail integration changes.
        </p>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Shop</th>
              <th style={th}>Total threads</th>
              <th style={th}>Unknown</th>
              <th style={th}>Unknown ratio</th>
            </tr>
          </thead>
          <tbody>
            {data.classificationHealth.length === 0 ? (
              <tr><td colSpan={4} style={{ ...td, color: "#94a3b8" }}>No shop has ≥10 threads yet.</td></tr>
            ) : (
              data.classificationHealth.map((c) => {
                const pct = (c.unknownRatio * 100).toFixed(1);
                const color = c.unknownRatio > 0.30 ? "#b91c1c" : c.unknownRatio > 0.10 ? "#b45309" : "inherit";
                return (
                  <tr key={c.shop}>
                    <td style={td}>{c.shop}</td>
                    <td style={td}>{c.totalThreads}</td>
                    <td style={td}>{c.unknownThreads}</td>
                    <td style={{ ...td, color }}>{pct}%</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <p style={muted}>
          Threshold guide: &lt;10% healthy · 10–30% watch · &gt;30% investigate (likely direction misattribution or stuck classifier).
        </p>
      </Section>

      <Section title="Database pool">
        {data.dbPool === null ? (
          <p style={muted}>pg_stat_activity not accessible from this DB role (typical on Neon/Supabase).</p>
        ) : (
          <>
            <Grid>
              <Card label="Active connections" value={String(data.dbPool.active)} tone={data.dbPool.active > data.dbPool.maxConnections * 0.8 ? "danger" : "good"} />
              <Card label="Idle" value={String(data.dbPool.idle)} />
              <Card label="Idle-in-tx" value={String(data.dbPool.idleInTransaction)} tone={data.dbPool.idleInTransaction > 0 ? "warning" : "muted"} />
              <Card label="Total / max" value={`${data.dbPool.total} / ${data.dbPool.maxConnections}`} />
            </Grid>
            <p style={muted}>
              When active approaches max, requests start timing out. Raise <code>connection_limit</code> in <code>DATABASE_URL</code> or lower <code>AUTOSYNC_CONCURRENCY</code>.
            </p>
          </>
        )}
      </Section>

      <Section title="Top shops by jobs (last 24h)">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Shop</th>
              <th style={th}>OK</th>
              <th style={th}>Errors</th>
              <th style={th}>Running</th>
              <th style={th}>Pending</th>
              <th style={th}>p50 (s)</th>
              <th style={th}>p95 (s)</th>
            </tr>
          </thead>
          <tbody>
            {data.jobStats.length === 0 ? (
              <tr><td colSpan={7} style={{ ...td, color: "#94a3b8" }}>No jobs in the window.</td></tr>
            ) : (
              data.jobStats.map((s) => (
                <tr key={s.shop}>
                  <td style={td}>{s.shop}</td>
                  <td style={td}>{s.doneCount}</td>
                  <td style={{ ...td, color: s.errorCount > 0 ? "#b91c1c" : "inherit" }}>{s.errorCount}</td>
                  <td style={td}>{s.runningCount}</td>
                  <td style={td}>{s.pendingCount}</td>
                  <td style={td}>{s.p50Seconds === null ? "—" : s.p50Seconds.toFixed(1)}</td>
                  <td style={td}>{s.p95Seconds === null ? "—" : s.p95Seconds.toFixed(1)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Section>

      <Section title="LLM cost by shop (last 24h)">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Shop</th>
              <th style={th}>Calls</th>
              <th style={th}>Tokens</th>
              <th style={th}>Cost (USD)</th>
            </tr>
          </thead>
          <tbody>
            {data.llmCosts.length === 0 ? (
              <tr><td colSpan={4} style={{ ...td, color: "#94a3b8" }}>No LLM calls in the window.</td></tr>
            ) : (
              data.llmCosts.map((c) => (
                <tr key={c.shop}>
                  <td style={td}>{c.shop}</td>
                  <td style={td}>{c.calls}</td>
                  <td style={td}>{c.totalTokens.toLocaleString()}</td>
                  <td style={td}>${c.costUsd.toFixed(4)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <p style={muted}>
          A shop with 10× the average cost is the cheapest way to spot a refresh loop or a regression.
        </p>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny presentational helpers
// ---------------------------------------------------------------------------

const muted: React.CSSProperties = { color: "#64748b", fontSize: 13, margin: "8px 0 0" };

const inlineCode: React.CSSProperties = {
  background: "#f1f5f9",
  padding: "1px 6px",
  borderRadius: 4,
  fontSize: "0.95em",
  fontFamily: "ui-monospace, monospace",
};

const preBlock: React.CSSProperties = {
  background: "#0f172a",
  color: "#e2e8f0",
  padding: "12px 14px",
  borderRadius: 8,
  fontSize: 13,
  overflowX: "auto",
  margin: "12px 0",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 12px", color: "#0f172a" }}>{title}</h2>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
      {children}
    </div>
  );
}

type CardTone = "good" | "warning" | "danger" | "muted";

function Card({ label, value, tone = "muted" }: { label: string; value: string; tone?: CardTone }) {
  const accent: Record<CardTone, string> = {
    good: "#10b981",
    warning: "#f59e0b",
    danger: "#dc2626",
    muted: "#94a3b8",
  };
  return (
    <div style={{
      border: "1px solid #e2e8f0",
      borderRadius: 12,
      padding: "12px 14px",
      background: "#fff",
    }}>
      <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: accent[tone], marginTop: 4 }}>{value}</div>
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  overflow: "hidden",
};

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  background: "#f8fafc",
  borderBottom: "1px solid #e2e8f0",
  color: "#475569",
  fontWeight: 600,
};
const td: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid #f1f5f9",
};

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d${Math.floor((sec % 86400) / 3600)}h`;
}
