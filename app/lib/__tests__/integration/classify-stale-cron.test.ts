/**
 * Integration tests for the hourly stale-unknown classify cron.
 *
 * Tests the `enqueueClassifyStaleUnknown` function from auto-sync.ts.
 * No mocking of OpenAI/Shopify — we test only the DB query + enqueue logic.
 *
 * Isolation: all data scoped to TEST_SHOP, cleaned in beforeEach.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  testDb,
  TEST_SHOP,
  cleanTestShop,
  disconnectTestDb,
} from "./helpers/db";

afterAll(async () => {
  await disconnectTestDb();
});

// Reset DB between tests
beforeEach(async () => {
  await cleanTestShop();
  // Reset the in-memory throttle between tests to avoid test-order pollution.
  // We import auto-sync dynamically inside tests so we can mutate the export.
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createMailConnection(email = "support@brand.com") {
  return testDb.mailConnection.create({
    data: {
      shop: TEST_SHOP,
      email,
      provider: "gmail",
      accessToken: "tok",
      refreshToken: "ref",
      tokenExpiry: new Date(Date.now() + 3_600_000),
    },
  });
}

async function createThread(
  mailConnectionId: string,
  overrides: {
    supportNature?: string;
    lastClassifyAttemptAt?: Date | null;
  } = {},
) {
  return testDb.thread.create({
    data: {
      shop: TEST_SHOP,
      mailConnectionId,
      provider: "gmail",
      firstMessageAt: new Date(),
      lastMessageAt: new Date(),
      supportNature: overrides.supportNature ?? "unknown",
      lastClassifyAttemptAt: overrides.lastClassifyAttemptAt ?? null,
    },
  });
}

async function createIncomingEmail(
  mailConnectionId: string,
  canonicalThreadId: string,
  overrides: {
    tier1Result?: string | null;
    tier2Result?: string | null;
    processingStatus?: string;
  } = {},
) {
  return testDb.incomingEmail.create({
    data: {
      shop: TEST_SHOP,
      mailConnectionId,
      canonicalThreadId,
      externalMessageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
      threadId: `t-${Math.random().toString(36).slice(2, 10)}`,
      fromAddress: "customer@example.com",
      subject: "Help me",
      bodyText: "Where is my order?",
      receivedAt: new Date(),
      processingStatus: overrides.processingStatus ?? "classified",
      tier1Result: overrides.tier1Result !== undefined ? overrides.tier1Result : "passed",
      tier2Result: overrides.tier2Result !== undefined ? overrides.tier2Result : null,
    },
  });
}

/** Reset the in-memory throttle by mutating the exported variable. */
async function resetThrottle() {
  // Dynamically import so we can reset between tests without module caching issues.
  // Vitest re-uses modules by default — the export is the live binding.
  const mod = await import("../../mail/auto-sync");
  mod._lastStaleClassifyScanAt = 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enqueueClassifyStaleUnknown", () => {
  it("Test 1: enqueues for a stale unknown thread (lastClassifyAttemptAt=null)", async () => {
    await resetThrottle();
    const conn = await createMailConnection();
    const thread = await createThread(conn.id); // lastClassifyAttemptAt=null, supportNature=unknown
    await createIncomingEmail(conn.id, thread.id); // tier1=passed, tier2=null

    const mod = await import("../../mail/auto-sync");
    const count = await (mod as any).enqueueClassifyStaleUnknown(new Date());

    expect(count).toBe(1);
    const jobs = await testDb.syncJob.findMany({
      where: { shop: TEST_SHOP, kind: "analyze_thread", status: "pending" },
    });
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].params)).toEqual({ threadId: thread.id });
    expect(jobs[0].mailConnectionId).toBe(conn.id);
  });

  it("Test 2: skip thread attempted less than 24 h ago", async () => {
    await resetThrottle();
    const conn = await createMailConnection("box2@brand.com");
    // lastClassifyAttemptAt = 1 hour ago → within 24 h cooldown
    const recentAttempt = new Date(Date.now() - 1 * 60 * 60 * 1000);
    const thread = await createThread(conn.id, { lastClassifyAttemptAt: recentAttempt });
    await createIncomingEmail(conn.id, thread.id);

    const mod = await import("../../mail/auto-sync");
    const count = await (mod as any).enqueueClassifyStaleUnknown(new Date());

    expect(count).toBe(0);
    const jobs = await testDb.syncJob.count({ where: { shop: TEST_SHOP, kind: "analyze_thread" } });
    expect(jobs).toBe(0);
  });

  it("Test 3: re-enqueue after 24 h cooldown has expired", async () => {
    await resetThrottle();
    const conn = await createMailConnection("box3@brand.com");
    // lastClassifyAttemptAt = 25 h ago → outside cooldown
    const oldAttempt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const thread = await createThread(conn.id, { lastClassifyAttemptAt: oldAttempt });
    await createIncomingEmail(conn.id, thread.id);

    const mod = await import("../../mail/auto-sync");
    const count = await (mod as any).enqueueClassifyStaleUnknown(new Date());

    expect(count).toBe(1);
  });

  it("Test 4: skip threads that are not supportNature=unknown", async () => {
    await resetThrottle();
    const conn = await createMailConnection("box4@brand.com");
    const thread = await createThread(conn.id, { supportNature: "confirmed_support" });
    await createIncomingEmail(conn.id, thread.id);

    const mod = await import("../../mail/auto-sync");
    const count = await (mod as any).enqueueClassifyStaleUnknown(new Date());

    expect(count).toBe(0);
  });

  it("Test 5: skip if a pending analyze_thread job already exists (dedup)", async () => {
    await resetThrottle();
    const conn = await createMailConnection("box5@brand.com");
    const thread = await createThread(conn.id);
    await createIncomingEmail(conn.id, thread.id);

    // Pre-seed a pending job for this thread
    await testDb.syncJob.create({
      data: {
        shop: TEST_SHOP,
        mailConnectionId: conn.id,
        kind: "analyze_thread",
        params: JSON.stringify({ threadId: thread.id }),
        status: "pending",
      },
    });

    const mod = await import("../../mail/auto-sync");
    const count = await (mod as any).enqueueClassifyStaleUnknown(new Date());

    expect(count).toBe(0);
    // Still only 1 job (the one we seeded)
    const jobs = await testDb.syncJob.count({ where: { shop: TEST_SHOP, kind: "analyze_thread" } });
    expect(jobs).toBe(1);
  });

  it("Test 6: in-memory throttle — second call within 1 h returns 0 without hitting DB", async () => {
    await resetThrottle();
    const conn = await createMailConnection("box6@brand.com");
    const thread = await createThread(conn.id);
    await createIncomingEmail(conn.id, thread.id);

    const mod = await import("../../mail/auto-sync");
    const now = new Date();

    // First call — does real work
    const first = await (mod as any).enqueueClassifyStaleUnknown(now);
    expect(first).toBe(1);

    // Second call with the same timestamp (within 1 h) — short-circuits immediately
    const second = await (mod as any).enqueueClassifyStaleUnknown(now);
    expect(second).toBe(0);

    // Only 1 job should have been created
    const jobs = await testDb.syncJob.count({ where: { shop: TEST_SHOP, kind: "analyze_thread" } });
    expect(jobs).toBe(1);
  });

  it("Test 7: batch limit — caps at STALE_CLASSIFY_BATCH=50 even with 60 threads", async () => {
    await resetThrottle();
    const conn = await createMailConnection("box7@brand.com");

    // Seed 60 stale unknown threads, each with a Tier1=passed, Tier2=null message
    for (let i = 0; i < 60; i++) {
      const thread = await createThread(conn.id);
      await createIncomingEmail(conn.id, thread.id);
    }

    const mod = await import("../../mail/auto-sync");
    const count = await (mod as any).enqueueClassifyStaleUnknown(new Date());

    // Must not exceed STALE_CLASSIFY_BATCH (50)
    expect(count).toBe(50);
    const jobs = await testDb.syncJob.count({ where: { shop: TEST_SHOP, kind: "analyze_thread" } });
    expect(jobs).toBe(50);
  }, 30_000); // allow up to 30 s for 60 inserts + 50 enqueues
});
