import { describe, it, expect, vi, beforeEach } from "vitest";
import { computePriorContact } from "../prior-contact";

vi.mock("../../../db.server", () => ({
  default: {
    incomingEmail: { findMany: vi.fn() },
    thread: { findMany: vi.fn() },
  },
}));

const prisma = (await import("../../../db.server")).default as unknown as {
  incomingEmail: { findMany: ReturnType<typeof vi.fn> };
  thread: { findMany: ReturnType<typeof vi.fn> };
};

const SHOP = "shop.myshopify.com";

function setupMocks(opts: {
  /** outgoing rows (canonicalThreadId + receivedAt) on which earliest/latest are bucketed */
  outgoings?: Array<{ canonicalThreadId: string; receivedAt: Date }>;
  /** thread metadata returned for `prisma.thread.findMany` — only the order link matters */
  priorThreads?: Array<{ id: string; resolvedOrderNumber: string | null }>;
}) {
  prisma.incomingEmail.findMany.mockResolvedValue(opts.outgoings ?? []);
  prisma.thread.findMany.mockResolvedValue(opts.priorThreads ?? []);
}

describe("computePriorContact — byOrder only", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flags byOrder when the same order was replied to in another thread earlier", async () => {
    setupMocks({
      outgoings: [{ canonicalThreadId: "prior-1", receivedAt: new Date(2026, 0, 1) }],
      priorThreads: [{ id: "prior-1", resolvedOrderNumber: "#1001" }],
    });

    const result = await computePriorContact(
      SHOP,
      ["current"],
      [
        {
          canonicalThreadId: "current",
          processingStatus: "analyzed",
          receivedAt: new Date(2026, 2, 1),
          fromAddress: "customer@gmail.com",
        },
      ],
      { current: { resolvedOrderNumber: "#1001" } },
      new Map([["current", new Date(2026, 2, 1)]]),
    );

    expect(result.current?.byOrder).toBe(true);
  });

  it("never flags when the current thread has no resolved order, even if the address matches", async () => {
    setupMocks({
      outgoings: [{ canonicalThreadId: "prior-1", receivedAt: new Date(2026, 0, 1) }],
      priorThreads: [{ id: "prior-1", resolvedOrderNumber: "#1001" }],
    });

    const result = await computePriorContact(
      SHOP,
      ["current"],
      [
        {
          canonicalThreadId: "current",
          processingStatus: "analyzed",
          receivedAt: new Date(2026, 2, 1),
          fromAddress: "customer@gmail.com",
        },
      ],
      { current: { resolvedOrderNumber: null } },
      new Map([["current", new Date(2026, 2, 1)]]),
    );

    expect(result.current).toBeUndefined();
  });

  it("flags recentReply when an outgoing on the same order arrived after the current thread's latest incoming", async () => {
    setupMocks({
      outgoings: [
        // recent outgoing on another thread, AFTER the current incoming
        { canonicalThreadId: "prior-1", receivedAt: new Date(2026, 2, 15) },
      ],
      priorThreads: [{ id: "prior-1", resolvedOrderNumber: "#1001" }],
    });

    const result = await computePriorContact(
      SHOP,
      ["current"],
      [
        {
          canonicalThreadId: "current",
          processingStatus: "analyzed",
          receivedAt: new Date(2026, 2, 1),
          fromAddress: "customer@gmail.com",
        },
      ],
      { current: { resolvedOrderNumber: "#1001" } },
      new Map([["current", new Date(2026, 2, 1)]]),
    );

    expect(result.current?.recentReply).toBe(true);
  });

  it("does not flag when the prior order match is on the SAME thread (tid !== id guard)", async () => {
    setupMocks({
      outgoings: [{ canonicalThreadId: "current", receivedAt: new Date(2026, 0, 1) }],
      priorThreads: [{ id: "current", resolvedOrderNumber: "#1001" }],
    });

    const result = await computePriorContact(
      SHOP,
      ["current"],
      [
        {
          canonicalThreadId: "current",
          processingStatus: "analyzed",
          receivedAt: new Date(2026, 2, 1),
          fromAddress: "customer@gmail.com",
        },
      ],
      { current: { resolvedOrderNumber: "#1001" } },
      new Map([["current", new Date(2026, 2, 1)]]),
    );

    expect(result.current).toBeUndefined();
  });
});
