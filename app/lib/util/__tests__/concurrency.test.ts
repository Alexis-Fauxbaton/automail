// Stress / contention tests for the production-hardening helpers.
//
// These exist alongside the smaller unit tests because they exercise the
// helpers under realistic concurrent load — the kind of bug that only
// shows up when many things race at once. Keeping them in their own file
// makes it obvious which suite to rerun when changing concurrency primitives.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSemaphore } from "../semaphore";
import { createBreaker } from "../circuit-breaker";

describe("semaphore under load", () => {
  it("never exceeds maxConcurrent even with 100 racing acquirers", async () => {
    const MAX = 4;
    const sem = createSemaphore(MAX);
    let inFlight = 0;
    let peak = 0;
    // Read the semaphore's own counter inside the critical section so a
    // buggy implementation that lets more than MAX run cannot pass just
    // because the local `inFlight` increment landed too late.
    let semPeak = 0;
    const semInFlightSamples: number[] = [];

    async function worker() {
      const release = await sem.acquire();
      inFlight++;
      peak = Math.max(peak, inFlight);
      const semNow = sem.stats().inFlight;
      semPeak = Math.max(semPeak, semNow);
      semInFlightSamples.push(semNow);
      // Stronger invariant: per-worker assertion catches a violation as it
      // happens, not just at the end. A buggy semaphore that briefly
      // grants 10 leases and then drains back to 0 would otherwise pass
      // the final-state checks.
      expect(semNow).toBeLessThanOrEqual(MAX);
      // Tiny async pause so multiple workers genuinely overlap.
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      release();
    }

    await Promise.all(Array.from({ length: 100 }, () => worker()));
    expect(peak).toBeLessThanOrEqual(MAX);
    expect(semPeak).toBeLessThanOrEqual(MAX);
    expect(inFlight).toBe(0);
    expect(sem.stats().inFlight).toBe(0);
    expect(sem.stats().queued).toBe(0);
    // Workload should saturate the semaphore at some point — if peak stays
    // at 1 the test is silently degenerate (e.g. setTimeout(0) batched all
    // resolutions on the same microtask tick).
    expect(semPeak).toBeGreaterThan(1);
  });

  it("processes all 100 acquirers eventually (no starvation / deadlock)", async () => {
    const sem = createSemaphore(2);
    const completed: number[] = [];
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        sem.acquire().then((release) => {
          completed.push(i);
          release();
        }),
      ),
    );
    expect(completed).toHaveLength(100);
    // FIFO: each waiter is processed in enqueue order, so completion order
    // is i = 0, 1, 2, …, 99 (acquires resolve in that order).
    expect(completed).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it("survives an acquirer that releases inside a finally on error", async () => {
    const sem = createSemaphore(1);
    let calls = 0;
    async function runOnce() {
      const release = await sem.acquire();
      try {
        calls++;
        throw new Error("boom");
      } finally {
        release();
      }
    }
    await Promise.allSettled(Array.from({ length: 10 }, () => runOnce()));
    expect(calls).toBe(10);
    expect(sem.stats().inFlight).toBe(0);
  });
});

describe("circuit breaker cycle under concurrent failures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("trips exactly once even when many callers fail concurrently", async () => {
    const b = createBreaker({
      name: "test",
      failureThreshold: 3,
      failureWindowMs: 60_000,
      cooldownMs: 60_000,
    });
    const transitions: string[] = [];
    (b as unknown as { __setListener: (fn: (next: "open" | "closed") => void) => void })
      .__setListener((s) => transitions.push(s));

    // 20 concurrent callers, each fails. Without the `openedAt === null`
    // guard inside recordFailure the breaker would re-emit "open" on every
    // failure past the threshold — making downstream metrics noisy.
    await Promise.all(
      Array.from({ length: 20 }, () =>
        b.run(async () => { throw new Error("boom"); }).catch(() => null),
      ),
    );
    expect(b.state()).toBe("open");
    expect(transitions).toEqual(["open"]);
  });

  it("recovers cleanly after cooldown and a successful probe", async () => {
    const b = createBreaker({
      name: "test",
      failureThreshold: 2,
      failureWindowMs: 60_000,
      cooldownMs: 30_000,
    });

    // Trip it.
    await Promise.all([
      b.run(async () => { throw new Error("e1"); }).catch(() => null),
      b.run(async () => { throw new Error("e2"); }).catch(() => null),
    ]);
    expect(b.state()).toBe("open");

    // Wait past cooldown.
    vi.advanceTimersByTime(30_001);
    expect(b.state()).toBe("closed");

    // First probe succeeds, breaker stays closed.
    const ok = await b.run(async () => 7);
    expect(ok).toBe(7);
    expect(b.state()).toBe("closed");
  });

  it("re-opens on a failure during the half-open phase (post-cooldown probe)", async () => {
    const b = createBreaker({
      name: "test",
      failureThreshold: 2,
      failureWindowMs: 60_000,
      cooldownMs: 30_000,
    });
    await Promise.all([
      b.run(async () => { throw new Error("e1"); }).catch(() => null),
      b.run(async () => { throw new Error("e2"); }).catch(() => null),
    ]);
    expect(b.state()).toBe("open");

    vi.advanceTimersByTime(30_001);
    expect(b.state()).toBe("closed");

    // Probe fails — accumulates ONE failure (the previous window was
    // cleared when the breaker auto-closed). Threshold is 2, so the
    // breaker stays closed until a second failure within the window.
    await b.run(async () => { throw new Error("e3"); }).catch(() => null);
    expect(b.state()).toBe("closed");
    await b.run(async () => { throw new Error("e4"); }).catch(() => null);
    expect(b.state()).toBe("open");
  });
});
