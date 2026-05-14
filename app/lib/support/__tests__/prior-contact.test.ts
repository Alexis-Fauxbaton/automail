import { describe, it, expect, vi, beforeEach } from "vitest";
import { computePriorContact } from "../prior-contact";

vi.mock("../../../db.server", () => ({
  default: {
    mailConnection: { findUnique: vi.fn() },
    incomingEmail: { findMany: vi.fn() },
    thread: { findMany: vi.fn() },
  },
}));

// Re-import the mocked module so we can configure return values per test.
const prisma = (await import("../../../db.server")).default as unknown as {
  mailConnection: { findUnique: ReturnType<typeof vi.fn> };
  incomingEmail: { findMany: ReturnType<typeof vi.fn> };
  thread: { findMany: ReturnType<typeof vi.fn> };
};

const SHOP = "shop.myshopify.com";

function setupCommonMocks(opts: {
  merchantEmail?: string | null;
  outgoingFromAddresses?: string[];
  /** prior threads that wrote outgoing replies, keyed by addr/order */
  outgoings?: Array<{ canonicalThreadId: string; receivedAt: Date }>;
  /** incoming rows on those prior threads — what addresses they share */
  priorIncomings?: Array<{ canonicalThreadId: string; fromAddress: string }>;
  /** resolvedOrderNumber per prior thread, for byOrder lookup */
  priorThreads?: Array<{ id: string; resolvedOrderNumber: string | null }>;
}) {
  prisma.mailConnection.findUnique.mockResolvedValue(
    opts.merchantEmail === null
      ? null
      : { email: opts.merchantEmail ?? "merchant@store.com" },
  );

  // `incomingEmail.findMany` is called multiple times with different `where`
  // shapes — multiplex via a single mock that branches on `processingStatus`.
  prisma.incomingEmail.findMany.mockImplementation(async (args: any) => {
    const status = args?.where?.processingStatus;
    // 1) outgoing-addresses lookup (distinct from-addresses where status=outgoing)
    if (status === "outgoing" && args?.distinct?.[0] === "fromAddress") {
      return (opts.outgoingFromAddresses ?? []).map((fromAddress) => ({ fromAddress }));
    }
    // 2) ALL outgoing rows (to bucket earliest/latest per thread)
    if (status === "outgoing") {
      return opts.outgoings ?? [];
    }
    // 3) Incoming rows on threads that have any outgoing (priorIncomings)
    if (status?.not === "outgoing") {
      return opts.priorIncomings ?? [];
    }
    return [];
  });
  prisma.thread.findMany.mockResolvedValue(opts.priorThreads ?? []);
}

describe("computePriorContact — noise gate for public domains", () => {
  beforeEach(() => vi.clearAllMocks());

  it("suppresses byAddress on a gmail.com address with 5+ prior replied threads", async () => {
    // Setup: 5 prior threads where 'noisy@gmail.com' replied AND merchant replied earlier.
    const outgoings = Array.from({ length: 5 }, (_, i) => ({
      canonicalThreadId: `prior-${i}`,
      receivedAt: new Date(2026, 0, 1 + i), // way before currentThread starts
    }));
    const priorIncomings = outgoings.map((o) => ({
      canonicalThreadId: o.canonicalThreadId,
      fromAddress: "noisy@gmail.com",
    }));
    const priorThreads = outgoings.map((o) => ({
      id: o.canonicalThreadId,
      resolvedOrderNumber: null,
    }));
    setupCommonMocks({ outgoings, priorIncomings, priorThreads });

    // Current thread: started 2026-03-01, one incoming from noisy@gmail.com
    const result = await computePriorContact(
      SHOP,
      ["current"],
      [
        {
          canonicalThreadId: "current",
          processingStatus: "analyzed",
          receivedAt: new Date(2026, 2, 1),
          fromAddress: "noisy@gmail.com",
        },
      ],
      { current: { resolvedOrderNumber: null } },
      new Map([["current", new Date(2026, 2, 1)]]),
    );

    // No byAddress because public domain + 5 prior earlier-replied threads.
    expect(result.current).toBeUndefined();
  });

  it("keeps byAddress on a gmail.com address with only 3 prior threads", async () => {
    const outgoings = Array.from({ length: 3 }, (_, i) => ({
      canonicalThreadId: `prior-${i}`,
      receivedAt: new Date(2026, 0, 1 + i),
    }));
    const priorIncomings = outgoings.map((o) => ({
      canonicalThreadId: o.canonicalThreadId,
      fromAddress: "loyal@gmail.com",
    }));
    const priorThreads = outgoings.map((o) => ({
      id: o.canonicalThreadId,
      resolvedOrderNumber: null,
    }));
    setupCommonMocks({ outgoings, priorIncomings, priorThreads });

    const result = await computePriorContact(
      SHOP,
      ["current"],
      [
        {
          canonicalThreadId: "current",
          processingStatus: "analyzed",
          receivedAt: new Date(2026, 2, 1),
          fromAddress: "loyal@gmail.com",
        },
      ],
      { current: { resolvedOrderNumber: null } },
      new Map([["current", new Date(2026, 2, 1)]]),
    );

    expect(result.current?.byAddress).toBe(true);
  });

  it("keeps byAddress on a private-domain address even with 10 prior threads", async () => {
    const outgoings = Array.from({ length: 10 }, (_, i) => ({
      canonicalThreadId: `prior-${i}`,
      receivedAt: new Date(2026, 0, 1 + i),
    }));
    const priorIncomings = outgoings.map((o) => ({
      canonicalThreadId: o.canonicalThreadId,
      fromAddress: "alice@bigcorp.com",
    }));
    const priorThreads = outgoings.map((o) => ({
      id: o.canonicalThreadId,
      resolvedOrderNumber: null,
    }));
    setupCommonMocks({ outgoings, priorIncomings, priorThreads });

    const result = await computePriorContact(
      SHOP,
      ["current"],
      [
        {
          canonicalThreadId: "current",
          processingStatus: "analyzed",
          receivedAt: new Date(2026, 2, 1),
          fromAddress: "alice@bigcorp.com",
        },
      ],
      { current: { resolvedOrderNumber: null } },
      new Map([["current", new Date(2026, 2, 1)]]),
    );

    expect(result.current?.byAddress).toBe(true);
  });

  it("excludes the merchant's connected mailbox from byAddress signal", async () => {
    const outgoings = [{ canonicalThreadId: "prior-1", receivedAt: new Date(2026, 0, 1) }];
    // The merchant's own address appears as an incoming on a prior thread (bug we just fixed)
    const priorIncomings = [{ canonicalThreadId: "prior-1", fromAddress: "merchant@store.com" }];
    setupCommonMocks({
      merchantEmail: "merchant@store.com",
      outgoings,
      priorIncomings,
      priorThreads: [{ id: "prior-1", resolvedOrderNumber: null }],
    });

    const result = await computePriorContact(
      SHOP,
      ["current"],
      [
        {
          canonicalThreadId: "current",
          processingStatus: "classified",
          receivedAt: new Date(2026, 2, 1),
          fromAddress: "merchant@store.com",
        },
      ],
      { current: { resolvedOrderNumber: null } },
      new Map([["current", new Date(2026, 2, 1)]]),
    );

    // No flag because the only "incoming" address on the current thread is the
    // merchant's own mailbox, which is filtered.
    expect(result.current).toBeUndefined();
  });
});
