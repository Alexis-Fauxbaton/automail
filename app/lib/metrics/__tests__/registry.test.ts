import { describe, it, expect, beforeEach } from "vitest";
import { metrics, __resetMetricsForTest } from "../registry";

beforeEach(() => {
  __resetMetricsForTest();
});

describe("counter", () => {
  it("starts a new series at the increment value", () => {
    const c = metrics.counter("test_counter", "help");
    c.inc({ shop: "a" });
    c.inc({ shop: "a" }, 4);
    expect(c.collect()).toEqual([{ labels: { shop: "a" }, value: 5 }]);
  });

  it("distinct label sets produce distinct series", () => {
    const c = metrics.counter("test_counter");
    c.inc({ shop: "a", kind: "sync" });
    c.inc({ shop: "b", kind: "sync" });
    c.inc({ shop: "a", kind: "sync" });
    const s = c.collect().sort((x, y) => x.labels.shop.localeCompare(y.labels.shop));
    expect(s).toEqual([
      { labels: { kind: "sync", shop: "a" }, value: 2 },
      { labels: { kind: "sync", shop: "b" }, value: 1 },
    ]);
  });

  it("rejects negative increments", () => {
    const c = metrics.counter("test_counter");
    expect(() => c.inc({}, -1)).toThrow(/>= 0/);
  });

  it("treats label key order as irrelevant", () => {
    const c = metrics.counter("test_counter");
    c.inc({ a: "1", b: "2" });
    c.inc({ b: "2", a: "1" });
    expect(c.collect()).toEqual([{ labels: { a: "1", b: "2" }, value: 2 }]);
  });

  it("drops undefined label values", () => {
    const c = metrics.counter("test_counter");
    c.inc({ shop: "x", optional: undefined });
    expect(c.collect()[0].labels).toEqual({ shop: "x" });
  });

  it("re-registering with a different type throws", () => {
    metrics.counter("c1");
    expect(() => metrics.gauge("c1")).toThrow(/already registered/);
  });
});

describe("gauge", () => {
  it("set replaces the value", () => {
    const g = metrics.gauge("test_gauge");
    g.set({ shop: "a" }, 5);
    g.set({ shop: "a" }, 7);
    expect(g.collect()).toEqual([{ labels: { shop: "a" }, value: 7 }]);
  });

  it("inc / dec move the value", () => {
    const g = metrics.gauge("test_gauge");
    g.inc({ shop: "a" });
    g.inc({ shop: "a" }, 3);
    g.dec({ shop: "a" });
    expect(g.collect()).toEqual([{ labels: { shop: "a" }, value: 3 }]);
  });

  it("supports a labelless series", () => {
    const g = metrics.gauge("test_gauge");
    g.set(42);
    expect(g.collect()).toEqual([{ labels: {}, value: 42 }]);
  });
});

describe("histogram", () => {
  it("bucketises observations and tracks sum/count", () => {
    const h = metrics.histogram("test_h", "help", [0.1, 1, 10]);
    h.observe({}, 0.05);
    h.observe({}, 0.5);
    h.observe({}, 5);
    const s = h.collect();
    expect(s).toHaveLength(1);
    expect(s[0].count).toBe(3);
    expect(s[0].sum).toBeCloseTo(5.55, 6);
    expect(s[0].buckets.get(0.1)).toBe(1);
    expect(s[0].buckets.get(1)).toBe(2);
    expect(s[0].buckets.get(10)).toBe(3);
  });
});

describe("renderPrometheus", () => {
  it("produces well-formed text exposition for counters", () => {
    const c = metrics.counter("auto_sync_jobs_total", "Total jobs.");
    c.inc({ shop: "a", status: "ok" });
    c.inc({ shop: "a", status: "ok" });
    c.inc({ shop: "b", status: "error" });

    const out = metrics.renderPrometheus();
    expect(out).toContain("# HELP auto_sync_jobs_total Total jobs.");
    expect(out).toContain("# TYPE auto_sync_jobs_total counter");
    expect(out).toContain('auto_sync_jobs_total{shop="a",status="ok"} 2');
    expect(out).toContain('auto_sync_jobs_total{shop="b",status="error"} 1');
  });

  it("emits buckets, sum, count for histograms with le ordered ascending", () => {
    const h = metrics.histogram("test_h", "help", [1, 5, 10]);
    h.observe({ kind: "a" }, 0.5);
    h.observe({ kind: "a" }, 3);
    const out = metrics.renderPrometheus();
    expect(out).toMatch(/test_h_bucket\{kind="a",le="1"\} 1/);
    expect(out).toMatch(/test_h_bucket\{kind="a",le="5"\} 2/);
    expect(out).toMatch(/test_h_bucket\{kind="a",le="10"\} 2/);
    expect(out).toMatch(/test_h_bucket\{kind="a",le="\+Inf"\} 2/);
    expect(out).toMatch(/test_h_sum\{kind="a"\} 3\.5/);
    expect(out).toMatch(/test_h_count\{kind="a"\} 2/);
  });

  it("escapes label values per the exposition format", () => {
    const c = metrics.counter("tricky");
    c.inc({ msg: 'a"b\\c\nd' });
    const out = metrics.renderPrometheus();
    expect(out).toContain('msg="a\\"b\\\\c\\nd"');
  });
});

describe("snapshot", () => {
  it("returns all registered metrics in a stable shape", () => {
    metrics.counter("c1").inc({ shop: "x" });
    metrics.gauge("g1").set({ shop: "x" }, 7);
    metrics.histogram("h1", "", [1]).observe({}, 0.5);
    const snap = metrics.snapshot();
    expect(snap.counters.map((c) => c.name)).toEqual(["c1"]);
    expect(snap.gauges.map((g) => g.name)).toEqual(["g1"]);
    expect(snap.histograms.map((h) => h.name)).toEqual(["h1"]);
  });
});
