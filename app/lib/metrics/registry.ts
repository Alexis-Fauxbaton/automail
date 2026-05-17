/**
 * In-process metrics registry.
 *
 * Why we don't use prom-client: ~30kb dep is fine, but our metric surface
 * is small (~10 counters, a couple of histograms) and the Prometheus text
 * format is well-defined. Owning the implementation keeps audits trivial
 * and removes one supply-chain risk.
 *
 * Trade-offs:
 *  - process-local only. Each Node worker holds its own counts. For
 *    multi-instance deployments scrape every replica or aggregate in
 *    Grafana (label by `instance`).
 *  - histograms use fixed bucket boundaries (see DEFAULT_BUCKETS). Good
 *    enough for the latency ranges we care about (1ms to 5min).
 *
 * Public API:
 *  - `metrics.counter(name).inc(labels?, value?)`
 *  - `metrics.gauge(name).set(labels?, value)` / `inc` / `dec`
 *  - `metrics.histogram(name).observe(labels?, value)`
 *  - `metrics.snapshot()` for the in-app dashboard
 *  - `metrics.renderPrometheus()` for /metrics
 *
 * Label values are coerced to strings and escaped per the Prometheus text
 * exposition format (backslash, newline, double-quote).
 */

type LabelValues = Record<string, string | number | boolean | undefined>;

interface Series {
  labels: Record<string, string>;
  value: number;
}

interface HistogramSeries {
  labels: Record<string, string>;
  buckets: Map<number, number>; // bucket-upper-bound → cumulative count
  sum: number;
  count: number;
}

// Latency buckets in seconds. Covers the realistic range from a fast DB
// hit (1ms) to a slow Shopify sync (5min). Tweak if your p99 lives at the
// edges of this range.
const DEFAULT_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5,
  1, 2.5, 5, 10, 30, 60, 120, 300,
];

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

// Hash shop domains in Prometheus output so scrapers can't enumerate the
// merchant list. Uses an 8-character hex prefix of an HMAC over the
// METRICS_LABEL_SALT (or, in dev, a fixed dev-only salt). The dimension
// is preserved (each shop maps to a stable opaque ID) so per-shop
// time-series still work for alerting / dashboards.
let _hashShopFn: ((s: string) => string) | null = null;
function hashShopLabel(shop: string): string {
  if (!shop) return "";
  if (!_hashShopFn) {
    // Lazy-load crypto so registry.ts stays import-safe in any context.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const salt = process.env.METRICS_LABEL_SALT || "dev-metrics-salt-do-not-use-in-prod";
    _hashShopFn = (s: string) =>
      "shop_" + createHmac("sha256", salt).update(s).digest("hex").slice(0, 8);
  }
  return _hashShopFn(shop);
}

// Labels that name a merchant and should be hashed in the Prometheus output.
const PII_LABEL_KEYS = new Set(["shop"]);

function normaliseLabels(input: LabelValues | undefined): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  // Sort keys so two calls with the same logical labels produce the same
  // serialised key — essential for series de-duplication.
  for (const k of Object.keys(input).sort()) {
    const v = input[k];
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

function seriesKey(labels: Record<string, string>): string {
  // Stable string key. {} for no labels.
  const parts = Object.keys(labels).map((k) => `${k}=${labels[k]}`);
  return parts.length === 0 ? "{}" : parts.join(",");
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  return (
    "{" +
    keys
      .map((k) => {
        const raw = labels[k];
        const value = PII_LABEL_KEYS.has(k) ? hashShopLabel(raw) : raw;
        return `${k}="${escapeLabelValue(value)}"`;
      })
      .join(",") +
    "}"
  );
}

export interface Counter {
  inc(labelsOrValue?: LabelValues | number, value?: number): void;
  /** Snapshot all series. */
  collect(): Series[];
}

export interface Gauge {
  set(labelsOrValue: LabelValues | number, value?: number): void;
  inc(labels?: LabelValues, value?: number): void;
  dec(labels?: LabelValues, value?: number): void;
  collect(): Series[];
}

export interface Histogram {
  observe(labelsOrValue: LabelValues | number, value?: number): void;
  collect(): HistogramSeries[];
}

interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
}

interface CounterMetric extends Metric {
  type: "counter";
  series: Map<string, Series>;
}

interface GaugeMetric extends Metric {
  type: "gauge";
  series: Map<string, Series>;
}

interface HistogramMetric extends Metric {
  type: "histogram";
  buckets: number[];
  series: Map<string, HistogramSeries>;
}

type AnyMetric = CounterMetric | GaugeMetric | HistogramMetric;

class Registry {
  private metrics = new Map<string, AnyMetric>();

  counter(name: string, help = ""): Counter {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== "counter") {
        throw new Error(`metric ${name} already registered as ${existing.type}`);
      }
      return makeCounterApi(existing);
    }
    const m: CounterMetric = { name, help, type: "counter", series: new Map() };
    this.metrics.set(name, m);
    return makeCounterApi(m);
  }

  gauge(name: string, help = ""): Gauge {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== "gauge") {
        throw new Error(`metric ${name} already registered as ${existing.type}`);
      }
      return makeGaugeApi(existing);
    }
    const m: GaugeMetric = { name, help, type: "gauge", series: new Map() };
    this.metrics.set(name, m);
    return makeGaugeApi(m);
  }

  histogram(name: string, help = "", buckets = DEFAULT_BUCKETS): Histogram {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== "histogram") {
        throw new Error(`metric ${name} already registered as ${existing.type}`);
      }
      return makeHistogramApi(existing);
    }
    const m: HistogramMetric = {
      name,
      help,
      type: "histogram",
      buckets: [...buckets].sort((a, b) => a - b),
      series: new Map(),
    };
    this.metrics.set(name, m);
    return makeHistogramApi(m);
  }

  /** Snapshot for the in-app dashboard / tests. */
  snapshot(): {
    counters: Array<{ name: string; help: string; series: Series[] }>;
    gauges: Array<{ name: string; help: string; series: Series[] }>;
    histograms: Array<{
      name: string;
      help: string;
      buckets: number[];
      series: HistogramSeries[];
    }>;
  } {
    const counters: Array<{ name: string; help: string; series: Series[] }> = [];
    const gauges: Array<{ name: string; help: string; series: Series[] }> = [];
    const histograms: Array<{
      name: string;
      help: string;
      buckets: number[];
      series: HistogramSeries[];
    }> = [];
    for (const m of this.metrics.values()) {
      if (m.type === "counter") {
        counters.push({ name: m.name, help: m.help, series: [...m.series.values()] });
      } else if (m.type === "gauge") {
        gauges.push({ name: m.name, help: m.help, series: [...m.series.values()] });
      } else {
        histograms.push({
          name: m.name,
          help: m.help,
          buckets: m.buckets,
          series: [...m.series.values()],
        });
      }
    }
    return { counters, gauges, histograms };
  }

  /** Render as Prometheus text exposition format (v0.0.4). */
  renderPrometheus(): string {
    const lines: string[] = [];
    for (const m of this.metrics.values()) {
      if (m.help) lines.push(`# HELP ${m.name} ${m.help.replace(/\n/g, " ")}`);
      lines.push(`# TYPE ${m.name} ${m.type}`);
      if (m.type === "counter" || m.type === "gauge") {
        for (const s of m.series.values()) {
          lines.push(`${m.name}${formatLabels(s.labels)} ${s.value}`);
        }
      } else {
        for (const s of m.series.values()) {
          for (const ub of m.buckets) {
            const labels = { ...s.labels, le: String(ub) };
            const count = s.buckets.get(ub) ?? 0;
            lines.push(`${m.name}_bucket${formatLabels(labels)} ${count}`);
          }
          // +Inf bucket
          lines.push(
            `${m.name}_bucket${formatLabels({ ...s.labels, le: "+Inf" })} ${s.count}`,
          );
          lines.push(`${m.name}_sum${formatLabels(s.labels)} ${s.sum}`);
          lines.push(`${m.name}_count${formatLabels(s.labels)} ${s.count}`);
        }
      }
    }
    return lines.join("\n") + "\n";
  }

  /** @internal — tests only */
  __resetForTest(): void {
    this.metrics.clear();
  }
}

function makeCounterApi(m: CounterMetric): Counter {
  return {
    inc(labelsOrValue, value) {
      let labels: LabelValues | undefined;
      let inc: number;
      if (typeof labelsOrValue === "number") {
        labels = undefined;
        inc = labelsOrValue;
      } else {
        labels = labelsOrValue;
        inc = value ?? 1;
      }
      if (inc < 0) throw new Error("counter increment must be >= 0");
      const norm = normaliseLabels(labels);
      const key = seriesKey(norm);
      const existing = m.series.get(key);
      if (existing) existing.value += inc;
      else m.series.set(key, { labels: norm, value: inc });
    },
    collect() {
      return [...m.series.values()];
    },
  };
}

function makeGaugeApi(m: GaugeMetric): Gauge {
  function ensure(labels: LabelValues | undefined): Series {
    const norm = normaliseLabels(labels);
    const key = seriesKey(norm);
    let s = m.series.get(key);
    if (!s) {
      s = { labels: norm, value: 0 };
      m.series.set(key, s);
    }
    return s;
  }
  return {
    set(labelsOrValue, value) {
      let labels: LabelValues | undefined;
      let val: number;
      if (typeof labelsOrValue === "number") {
        labels = undefined;
        val = labelsOrValue;
      } else {
        labels = labelsOrValue;
        val = value ?? 0;
      }
      ensure(labels).value = val;
    },
    inc(labels, value = 1) {
      ensure(labels).value += value;
    },
    dec(labels, value = 1) {
      ensure(labels).value -= value;
    },
    collect() {
      return [...m.series.values()];
    },
  };
}

function makeHistogramApi(m: HistogramMetric): Histogram {
  return {
    observe(labelsOrValue, value) {
      let labels: LabelValues | undefined;
      let v: number;
      if (typeof labelsOrValue === "number") {
        labels = undefined;
        v = labelsOrValue;
      } else {
        labels = labelsOrValue;
        v = value ?? 0;
      }
      const norm = normaliseLabels(labels);
      const key = seriesKey(norm);
      let s = m.series.get(key);
      if (!s) {
        s = {
          labels: norm,
          buckets: new Map(m.buckets.map((b) => [b, 0])),
          sum: 0,
          count: 0,
        };
        m.series.set(key, s);
      }
      s.sum += v;
      s.count += 1;
      for (const ub of m.buckets) {
        if (v <= ub) s.buckets.set(ub, (s.buckets.get(ub) ?? 0) + 1);
      }
    },
    collect() {
      return [...m.series.values()];
    },
  };
}

export const metrics = new Registry();

/** @internal — tests only */
export function __resetMetricsForTest(): void {
  metrics.__resetForTest();
}
