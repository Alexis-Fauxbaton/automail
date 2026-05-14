import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordSuccess,
  recordFailure,
  isOpen,
  __resetForTest,
} from "../seventeen-track-breaker";

describe("seventeen-track-breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetForTest();
  });

  it("starts closed", () => {
    expect(isOpen()).toBe(false);
  });

  it("opens after N consecutive failures in the failure window", () => {
    for (let i = 0; i < 5; i++) recordFailure();
    expect(isOpen()).toBe(true);
  });

  it("does not open if failures are spread beyond the failure window", () => {
    recordFailure();
    vi.advanceTimersByTime(11 * 60_000); // 11 minutes — outside 10-min window
    recordFailure();
    expect(isOpen()).toBe(false);
  });

  it("a single success resets the failure counter", () => {
    for (let i = 0; i < 4; i++) recordFailure();
    recordSuccess();
    recordFailure(); // only 1 fresh failure
    expect(isOpen()).toBe(false);
  });

  it("auto-closes after the cooldown elapses", () => {
    for (let i = 0; i < 5; i++) recordFailure();
    expect(isOpen()).toBe(true);
    vi.advanceTimersByTime(15 * 60_000 + 1); // past 15-min cooldown
    expect(isOpen()).toBe(false);
  });
});
