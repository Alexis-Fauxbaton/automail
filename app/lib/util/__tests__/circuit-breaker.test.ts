import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBreaker, BreakerOpenError } from "../circuit-breaker";

describe("createBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects bad option values at construction", () => {
    expect(() =>
      createBreaker({ name: "x", failureThreshold: 0, failureWindowMs: 1, cooldownMs: 1 }),
    ).toThrow(/failureThreshold/);
    expect(() =>
      createBreaker({ name: "x", failureThreshold: 1, failureWindowMs: 0, cooldownMs: 1 }),
    ).toThrow(/failureWindowMs/);
    expect(() =>
      createBreaker({ name: "x", failureThreshold: 1, failureWindowMs: 1, cooldownMs: 0 }),
    ).toThrow(/cooldownMs/);
  });

  it("opens after threshold failures inside the window", () => {
    const b = createBreaker({
      name: "test",
      failureThreshold: 3,
      failureWindowMs: 60_000,
      cooldownMs: 60_000,
    });
    expect(b.state()).toBe("closed");
    b.recordFailure();
    b.recordFailure();
    expect(b.state()).toBe("closed");
    b.recordFailure();
    expect(b.state()).toBe("open");
  });

  it("does not trip when failures are spread beyond the window", () => {
    const b = createBreaker({
      name: "test",
      failureThreshold: 3,
      failureWindowMs: 10_000,
      cooldownMs: 60_000,
    });
    b.recordFailure();
    vi.advanceTimersByTime(5_000);
    b.recordFailure();
    vi.advanceTimersByTime(6_000); // first failure now outside the window
    b.recordFailure();
    expect(b.state()).toBe("closed");
  });

  it("auto-closes after cooldown", () => {
    const b = createBreaker({
      name: "test",
      failureThreshold: 2,
      failureWindowMs: 60_000,
      cooldownMs: 15_000,
    });
    b.recordFailure();
    b.recordFailure();
    expect(b.state()).toBe("open");
    vi.advanceTimersByTime(14_999);
    expect(b.state()).toBe("open");
    vi.advanceTimersByTime(2);
    expect(b.state()).toBe("closed");
  });

  it("recordSuccess immediately closes a tripped breaker", () => {
    const b = createBreaker({
      name: "test",
      failureThreshold: 2,
      failureWindowMs: 60_000,
      cooldownMs: 60_000,
    });
    b.recordFailure();
    b.recordFailure();
    expect(b.state()).toBe("open");
    b.recordSuccess();
    expect(b.state()).toBe("closed");
  });

  it("run() short-circuits when open without invoking the function", async () => {
    const b = createBreaker({
      name: "test",
      failureThreshold: 1,
      failureWindowMs: 60_000,
      cooldownMs: 60_000,
    });
    b.recordFailure();
    const fn = vi.fn(async () => "ok");
    await expect(b.run(fn)).rejects.toThrow(BreakerOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("run() records success on resolved promise", async () => {
    const b = createBreaker({
      name: "test",
      failureThreshold: 2,
      failureWindowMs: 60_000,
      cooldownMs: 60_000,
    });
    b.recordFailure(); // one prior failure
    const res = await b.run(async () => 42);
    expect(res).toBe(42);
    // recordSuccess wipes the window — a fresh failure can't trip alone now.
    b.recordFailure();
    expect(b.state()).toBe("closed");
  });

  it("run() records failure on rejected promise and may trip", async () => {
    const b = createBreaker({
      name: "test",
      failureThreshold: 2,
      failureWindowMs: 60_000,
      cooldownMs: 60_000,
    });
    await expect(b.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(b.state()).toBe("closed");
    await expect(b.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(b.state()).toBe("open");
  });

  it("emits open/close transitions to the listener", () => {
    const b = createBreaker({
      name: "test",
      failureThreshold: 2,
      failureWindowMs: 60_000,
      cooldownMs: 30_000,
    });
    const events: string[] = [];
    (b as unknown as { __setListener: (fn: (next: "open" | "closed") => void) => void })
      .__setListener((s) => events.push(s));
    b.recordFailure();
    b.recordFailure();
    expect(events).toEqual(["open"]);
    b.recordSuccess();
    expect(events).toEqual(["open", "closed"]);
  });
});
