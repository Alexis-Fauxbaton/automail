/**
 * Process-wide circuit breaker for the 17track API.
 *
 * Implemented on top of the generic `lib/util/circuit-breaker` helper so
 * we share the open/close mechanics with the OpenAI breaker and benefit
 * from a single set of tests. The wrapper preserves the historical
 * function-style API (`isOpen` / `recordFailure` / `recordSuccess`) used
 * throughout the tracking code path.
 *
 * Why a separate file rather than inline `createBreaker(...)`: keeps the
 * tunables (threshold, window, cooldown) and the breaker name in one
 * place, and gives metrics a stable name to label by.
 */
import { createBreaker } from "../../util/circuit-breaker";
import { breakerState, breakerTransitionsTotal } from "../../metrics/definitions";

const breaker = createBreaker({
  name: "17track",
  failureThreshold: 5,
  failureWindowMs: 10 * 60_000,
  cooldownMs: 15 * 60_000,
});
breakerState.set({ name: "17track" }, 0);
(breaker as unknown as { __setListener: (fn: (next: "open" | "closed") => void) => void })
  .__setListener((next) => {
    breakerState.set({ name: "17track" }, next === "open" ? 1 : 0);
    breakerTransitionsTotal.inc({ name: "17track", state: next });
  });

export function recordSuccess(): void {
  breaker.recordSuccess();
}

export function recordFailure(): void {
  breaker.recordFailure();
}

export function isOpen(): boolean {
  return breaker.isOpen();
}

/** @internal — tests only */
export function __resetForTest(): void {
  breaker.__resetForTest();
}

/** @internal — for the metrics module to subscribe to transitions. */
export const __breaker = breaker;
