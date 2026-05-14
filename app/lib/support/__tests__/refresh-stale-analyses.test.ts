import { describe, expect, test, vi, beforeEach } from "vitest";

vi.mock("../refresh-thread-analysis", () => ({
  refreshThreadAnalysis: vi.fn().mockResolvedValue({}),
}));

const findManyMock = vi.fn();
vi.mock("../../../db.server", () => ({
  default: {
    incomingEmail: {
      findMany: (args: unknown) => findManyMock(args),
    },
  },
}));

import { refreshStaleAnalysesForShop } from "../refresh-stale-analyses";
import { refreshThreadAnalysis } from "../refresh-thread-analysis";
import type { AdminGraphqlClient } from "../shopify/order-search";

const refreshThreadAnalysisMock = vi.mocked(refreshThreadAnalysis);
const fakeAdmin = {} as AdminGraphqlClient;

const baseAnalysis = (overrides: object = {}) => ({
  intent: "where_is_my_order",
  intents: ["where_is_my_order"],
  identifiers: {},
  order: { id: "gid://Order/1", name: "#1", createdAt: "2026-04-01T00:00:00Z", customerName: null, customerEmail: null, lineItems: [], fulfillments: [] },
  orderCandidates: [],
  trackings: [],
  confidence: "low",
  warnings: [],
  draftReply: "",
  conversation: { messageCount: 1, incomingCount: 1, outgoingCount: 0, lastMessageDirection: "incoming", noReplyNeeded: false },
  ...overrides,
});

describe("refreshStaleAnalysesForShop flag derivation", () => {
  beforeEach(() => {
    refreshThreadAnalysisMock.mockClear();
    findManyMock.mockClear();
  });

  test("intent populated and order populated → no reclassify, no re-search", async () => {
    findManyMock.mockResolvedValueOnce([
      { id: "e1", analysisResult: JSON.stringify(baseAnalysis()) },
    ]);
    await refreshStaleAnalysesForShop("shop.myshopify.com", fakeAdmin);
    expect(refreshThreadAnalysisMock).toHaveBeenCalledTimes(1);
    expect(refreshThreadAnalysisMock.mock.calls[0][3]).toEqual({
      reclassifyIntent: false,
      reSearchOrder: false,
      refreshTracking: true,
    });
  });

  test("intent unknown → reclassifyIntent is true", async () => {
    findManyMock.mockResolvedValueOnce([
      { id: "e1", analysisResult: JSON.stringify(baseAnalysis({ intent: "unknown", intents: ["unknown"] })) },
    ]);
    await refreshStaleAnalysesForShop("shop.myshopify.com", fakeAdmin);
    expect(refreshThreadAnalysisMock.mock.calls[0][3].reclassifyIntent).toBe(true);
  });

  test("empty intents array → reclassifyIntent is true", async () => {
    findManyMock.mockResolvedValueOnce([
      { id: "e1", analysisResult: JSON.stringify(baseAnalysis({ intents: [] })) },
    ]);
    await refreshStaleAnalysesForShop("shop.myshopify.com", fakeAdmin);
    expect(refreshThreadAnalysisMock.mock.calls[0][3].reclassifyIntent).toBe(true);
  });

  test("order null → reSearchOrder is true", async () => {
    findManyMock.mockResolvedValueOnce([
      { id: "e1", analysisResult: JSON.stringify(baseAnalysis({ order: null })) },
    ]);
    await refreshStaleAnalysesForShop("shop.myshopify.com", fakeAdmin);
    expect(refreshThreadAnalysisMock.mock.calls[0][3].reSearchOrder).toBe(true);
  });

  test("no previous analysis → both reclassify and re-search true", async () => {
    findManyMock.mockResolvedValueOnce([
      { id: "e1", analysisResult: null },
    ]);
    await refreshStaleAnalysesForShop("shop.myshopify.com", fakeAdmin);
    expect(refreshThreadAnalysisMock.mock.calls[0][3]).toEqual({
      reclassifyIntent: true,
      reSearchOrder: true,
      refreshTracking: true,
    });
  });

  test("refreshTracking is always true", async () => {
    findManyMock.mockResolvedValueOnce([
      { id: "e1", analysisResult: JSON.stringify(baseAnalysis()) },
    ]);
    await refreshStaleAnalysesForShop("shop.myshopify.com", fakeAdmin);
    expect(refreshThreadAnalysisMock.mock.calls[0][3].refreshTracking).toBe(true);
  });
});

describe("refreshStaleAnalysesForShop adaptive cutoff", () => {
  beforeEach(() => {
    refreshThreadAnalysisMock.mockClear();
    findManyMock.mockClear();
  });

  test("pending tracking + 6 min old is picked up (no maxAgeMs)", async () => {
    const sixMinAgo = new Date(Date.now() - 6 * 60_000);
    findManyMock.mockResolvedValueOnce([
      {
        id: "e1",
        lastAnalyzedAt: sixMinAgo,
        analysisResult: JSON.stringify(
          baseAnalysis({
            trackings: [
              {
                number: "TRK1",
                carrier: null,
                url: null,
                last17trackAttempt: "pending",
              },
            ],
          }),
        ),
      },
    ]);
    const result = await refreshStaleAnalysesForShop(
      "shop.myshopify.com",
      fakeAdmin,
    );
    expect(result.refreshed).toBe(1);
    expect(refreshThreadAnalysisMock).toHaveBeenCalledTimes(1);
  });

  test("ok tracking + 30 min old is NOT picked up (no maxAgeMs)", async () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000);
    findManyMock.mockResolvedValueOnce([
      {
        id: "e1",
        lastAnalyzedAt: thirtyMinAgo,
        analysisResult: JSON.stringify(
          baseAnalysis({
            trackings: [
              {
                number: "TRK1",
                carrier: null,
                url: null,
                last17trackAttempt: "ok",
              },
            ],
          }),
        ),
      },
    ]);
    const result = await refreshStaleAnalysesForShop(
      "shop.myshopify.com",
      fakeAdmin,
    );
    expect(result.refreshed).toBe(0);
    expect(refreshThreadAnalysisMock).not.toHaveBeenCalled();
  });
});
