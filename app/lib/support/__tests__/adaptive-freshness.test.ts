import { describe, it, expect } from "vitest";
import {
  ANALYSIS_FRESHNESS_MS,
  pickCutoffForAnalysis,
} from "../refresh-stale-analyses";
import type { SupportAnalysis } from "../types";

function withTrackings(t: Partial<SupportAnalysis["trackings"][number]>[]): SupportAnalysis {
  return {
    intent: "where_is_my_order", intents: ["where_is_my_order"],
    identifiers: {}, order: null, orderCandidates: [],
    trackings: t.map((p, i) => ({
      source: "seventeen_track",
      inferred: false,
      fulfillmentIndex: i,
      lineItems: [],
      ...p,
    })) as SupportAnalysis["trackings"],
    warnings: [], confidence: "low", draftReply: "",
  } as unknown as SupportAnalysis;
}

describe("pickCutoffForAnalysis", () => {
  it("defaults to autoRefresh (1h) when no trackings are present", () => {
    const a = withTrackings([]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.autoRefresh);
  });

  it("returns autoRefresh when every tracking is 'ok'", () => {
    const a = withTrackings([{ last17trackAttempt: "ok" }, { last17trackAttempt: "ok" }]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.autoRefresh);
  });

  it("returns fast17trackRetry (10min) when any tracking errored", () => {
    const a = withTrackings([{ last17trackAttempt: "ok" }, { last17trackAttempt: "error" }]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.fast17trackRetry);
  });

  it("returns pendingRetry (5min) when any tracking is pending", () => {
    const a = withTrackings([{ last17trackAttempt: "pending" }]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.pendingRetry);
  });

  it("pending wins over error (sooner retry)", () => {
    const a = withTrackings([
      { last17trackAttempt: "error" },
      { last17trackAttempt: "pending" },
    ]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.pendingRetry);
  });

  it("'skipped' (no key / no number) does NOT accelerate retry", () => {
    const a = withTrackings([{ last17trackAttempt: "skipped" }]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.autoRefresh);
  });

  it("legacy analyses (no last17trackAttempt) keep autoRefresh", () => {
    const a = withTrackings([{ source: "shopify_url" }]);
    expect(pickCutoffForAnalysis(a)).toBe(ANALYSIS_FRESHNESS_MS.autoRefresh);
  });

  it("handles null analysis gracefully", () => {
    expect(pickCutoffForAnalysis(null)).toBe(ANALYSIS_FRESHNESS_MS.autoRefresh);
  });
});
