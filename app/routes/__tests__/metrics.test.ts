import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loader } from "../metrics";
import { metrics, __resetMetricsForTest } from "../../lib/metrics/registry";

describe("/metrics route", () => {
  const originalToken = process.env.METRICS_TOKEN;

  beforeEach(() => {
    __resetMetricsForTest();
    // Seed a known metric so the rendered output is non-trivial.
    metrics.counter("test_counter", "Test counter").inc({ shop: "demo" }, 3);
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = originalToken;
  });

  async function call(headers: Record<string, string> = {}, search = "") {
    const url = `http://test.local/metrics${search}`;
    // Cast: the loader only reads `request`; the rest of LoaderFunctionArgs
    // is router plumbing we don't need at the unit-test layer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return loader({ request: new Request(url, { headers }) } as any);
  }

  it("returns 404 when METRICS_TOKEN is not configured", async () => {
    delete process.env.METRICS_TOKEN;
    const res = await call();
    expect(res.status).toBe(404);
  });

  it("returns 401 when the bearer header is missing", async () => {
    process.env.METRICS_TOKEN = "secret-token";
    const res = await call();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("returns 401 on token mismatch", async () => {
    process.env.METRICS_TOKEN = "secret-token";
    const res = await call({ Authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when only the prefix matches (length differs)", async () => {
    process.env.METRICS_TOKEN = "secret-token";
    const res = await call({ Authorization: "Bearer secret" });
    expect(res.status).toBe(401);
  });

  it("returns 200 with Prometheus text on the correct bearer token", async () => {
    process.env.METRICS_TOKEN = "secret-token";
    const res = await call({ Authorization: "Bearer secret-token" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("# TYPE test_counter counter");
    // `shop` labels are HMAC-hashed at render time so scrapers cannot
    // enumerate the merchant list.
    expect(body).toMatch(/test_counter\{shop="shop_[a-f0-9]{8}"\} 3/);
  });

  it("also accepts ?token= for scrapers that can't set headers", async () => {
    process.env.METRICS_TOKEN = "secret-token";
    const res = await call({}, "?token=secret-token");
    expect(res.status).toBe(200);
  });
});
