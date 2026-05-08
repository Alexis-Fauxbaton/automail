import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../db.server", () => ({
  default: {
    incomingEmail: {
      findMany: vi.fn(),
    },
    thread: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

import prisma from "../../../db.server";
import {
  applyPreservedOverridesIfAny,
  snapshotManualOverridesForShop,
} from "../preserved-overrides";
import type { OrderFacts, SupportAnalysis } from "../types";

const baseOrder: OrderFacts = {
  id: "gid://shopify/Order/1",
  name: "#1001",
  createdAt: "2026-04-01T00:00:00Z",
  customerName: "Jane",
  customerEmail: null,
  displayFinancialStatus: null,
  displayFulfillmentStatus: null,
  lineItems: [],
  fulfillments: [],
};

function baseAnalysis(overrides: Partial<SupportAnalysis> = {}): SupportAnalysis {
  return {
    intent: "where_is_my_order",
    intents: ["where_is_my_order"],
    identifiers: {},
    order: null,
    orderCandidates: [],
    trackings: [],
    confidence: "low",
    warnings: [],
    draftReply: "",
    conversation: {
      messageCount: 1,
      incomingCount: 1,
      outgoingCount: 0,
      lastMessageDirection: "incoming",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("snapshotManualOverridesForShop", () => {
  test("captures intent + order overrides into Thread JSON", async () => {
    const analysis = baseAnalysis({
      intent: "refund_request",
      intents: ["refund_request", "delivery_delay"],
      order: baseOrder,
      manualOverrides: {
        intents: { editedAt: "2026-05-01T00:00:00Z" },
        order: { editedAt: "2026-05-02T00:00:00Z" },
      },
    });
    (prisma.incomingEmail.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { canonicalThreadId: "T1", analysisResult: JSON.stringify(analysis) },
    ]);

    const n = await snapshotManualOverridesForShop("shop.myshopify.com");
    expect(n).toBe(1);

    const updateCalls = (prisma.thread.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateCalls).toHaveLength(1);
    const payload = JSON.parse(updateCalls[0][0].data.preservedManualOverridesJson);
    expect(payload.intents).toEqual(["refund_request", "delivery_delay"]);
    expect(payload.intentsAt).toBe("2026-05-01T00:00:00Z");
    expect(payload.order.id).toBe("gid://shopify/Order/1");
    expect(payload.orderAt).toBe("2026-05-02T00:00:00Z");
  });

  test("captures only the latest analysis per thread", async () => {
    (prisma.incomingEmail.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      // findMany returns ordered desc — first row is latest.
      {
        canonicalThreadId: "T1",
        analysisResult: JSON.stringify(
          baseAnalysis({
            intent: "refund_request",
            intents: ["refund_request"],
            manualOverrides: { intents: { editedAt: "2026-05-03T00:00:00Z" } },
          }),
        ),
      },
      {
        canonicalThreadId: "T1",
        analysisResult: JSON.stringify(
          baseAnalysis({
            intent: "delivery_delay",
            intents: ["delivery_delay"],
            manualOverrides: { intents: { editedAt: "2026-05-01T00:00:00Z" } },
          }),
        ),
      },
    ]);

    await snapshotManualOverridesForShop("shop");
    const payload = JSON.parse(
      (prisma.thread.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data.preservedManualOverridesJson,
    );
    expect(payload.intents).toEqual(["refund_request"]);
  });

  test("ignores threads without overrides", async () => {
    (prisma.incomingEmail.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { canonicalThreadId: "T1", analysisResult: JSON.stringify(baseAnalysis()) },
    ]);
    const n = await snapshotManualOverridesForShop("shop");
    expect(n).toBe(0);
    expect((prisma.thread.update as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  test("captures detached order (order: null) as a meaningful override", async () => {
    (prisma.incomingEmail.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        canonicalThreadId: "T1",
        analysisResult: JSON.stringify(
          baseAnalysis({
            order: null,
            manualOverrides: { order: { editedAt: "2026-05-02T00:00:00Z" } },
          }),
        ),
      },
    ]);
    await snapshotManualOverridesForShop("shop");
    const payload = JSON.parse(
      (prisma.thread.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data.preservedManualOverridesJson,
    );
    expect(payload.order).toBeNull();
    expect(payload.orderAt).toBe("2026-05-02T00:00:00Z");
  });
});

describe("applyPreservedOverridesIfAny", () => {
  test("restores intent + order and clears the snapshot", async () => {
    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      shop: "shop",
      preservedManualOverridesJson: JSON.stringify({
        intents: ["refund_request"],
        intentsAt: "2026-05-01T00:00:00Z",
        order: baseOrder,
        orderAt: "2026-05-02T00:00:00Z",
      }),
    });

    const analysis = baseAnalysis({ intent: "where_is_my_order", order: null });
    await applyPreservedOverridesIfAny(analysis, "T1", "shop");

    expect(analysis.intent).toBe("refund_request");
    expect(analysis.intents).toEqual(["refund_request"]);
    expect(analysis.order?.id).toBe("gid://shopify/Order/1");
    expect(analysis.manualOverrides?.intents?.editedAt).toBe("2026-05-01T00:00:00Z");
    expect(analysis.manualOverrides?.order?.editedAt).toBe("2026-05-02T00:00:00Z");

    // One-shot: snapshot must be cleared, AND Thread.resolvedOrderNumber
    // must be re-synced to the user's manual pick.
    const updateCall = (prisma.thread.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall.data.preservedManualOverridesJson).toBeNull();
    expect(updateCall.data.resolvedOrderNumber).toBe("1001");
  });

  test("restores manual detach AND nulls Thread.resolvedOrderNumber", async () => {
    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      shop: "shop",
      preservedManualOverridesJson: JSON.stringify({
        order: null,
        orderAt: "2026-05-02T00:00:00Z",
      }),
    });
    const analysis = baseAnalysis({ order: baseOrder });
    await applyPreservedOverridesIfAny(analysis, "T1", "shop");
    expect(analysis.order).toBeNull();
    expect(analysis.manualOverrides?.order?.editedAt).toBe("2026-05-02T00:00:00Z");
    // Critical: Thread.resolvedOrderNumber must be cleared so the inbox
    // preview badge doesn't show a stale order number that mergeThread-
    // Identifiers re-extracted from the email body.
    const updateCall = (prisma.thread.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall.data.resolvedOrderNumber).toBeNull();
  });

  test("does not touch resolvedOrderNumber when only intents were overridden", async () => {
    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      shop: "shop",
      preservedManualOverridesJson: JSON.stringify({
        intents: ["refund_request"],
        intentsAt: "2026-05-01T00:00:00Z",
      }),
    });
    const analysis = baseAnalysis();
    await applyPreservedOverridesIfAny(analysis, "T1", "shop");
    const updateCall = (prisma.thread.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect("resolvedOrderNumber" in updateCall.data).toBe(false);
  });

  test("no-op when thread has no snapshot", async () => {
    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      shop: "shop",
      preservedManualOverridesJson: null,
    });
    const analysis = baseAnalysis({ intent: "where_is_my_order" });
    await applyPreservedOverridesIfAny(analysis, "T1", "shop");
    expect(analysis.intent).toBe("where_is_my_order");
    expect(analysis.manualOverrides).toBeUndefined();
    expect((prisma.thread.update as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  test("no-op + clears snapshot when JSON is corrupt", async () => {
    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      shop: "shop",
      preservedManualOverridesJson: "{not json",
    });
    const analysis = baseAnalysis();
    await applyPreservedOverridesIfAny(analysis, "T1", "shop");
    expect(analysis.manualOverrides).toBeUndefined();
    const updateCall = (prisma.thread.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall.data.preservedManualOverridesJson).toBeNull();
  });

  test("no-op when shop mismatches (multi-tenant safety)", async () => {
    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      shop: "other-shop",
      preservedManualOverridesJson: JSON.stringify({ intents: ["refund_request"], intentsAt: "x" }),
    });
    const analysis = baseAnalysis({ intent: "where_is_my_order" });
    await applyPreservedOverridesIfAny(analysis, "T1", "shop");
    expect(analysis.intent).toBe("where_is_my_order");
    expect((prisma.thread.update as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  test("no-op when threadId is null", async () => {
    const analysis = baseAnalysis();
    await applyPreservedOverridesIfAny(analysis, null, "shop");
    expect((prisma.thread.findUnique as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
