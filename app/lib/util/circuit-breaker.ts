/**
 * Process-wide circuit breaker, factored out of `seventeen-track-breaker.ts`.
 *
 * Why module-global (not per-shop): the upstream APIs we protect (OpenAI,
 * 17track, Shopify) share rate limits or system-wide health across all
 * shops. A burst of failures against one shop is a strong signal the next
 * shop will fail too — opening the breaker once for the whole process
 * stops the bleed for everyone instead of letting each shop discover the
 * outage independently.
 *
 * Multi-instance note: each Node process holds its own breaker. With N
 * replicas a sustained outage takes N × `failureThreshold` failures
 * before all instances are open. That's acceptable today; revisit if you
 * scale past ~4 replicas (use a Postgres-backed counter then).
 *
 * State model:
 *   - closed   → calls flow through; failures accumulate within a sliding window
 *   - open     → calls are short-circuited; tripped after `failureThreshold`
 *                failures in any `failureWindowMs`; stays open `cooldownMs`
 *   - (half-open is implicit) → after cooldown the first call is allowed
 *     through; success closes the breaker, failure re-opens it for another
 *     cooldown
 */

export interface BreakerOptions {
  /** Human-readable name used in logs and metrics labels. */
  name: string;
  /** Number of failures inside `failureWindowMs` that trip the breaker. */
  failureThreshold: number;
  /** Sliding window over which failures are counted. */
  failureWindowMs: number;
  /** How long the breaker stays open before letting a probe through. */
  cooldownMs: number;
}

export interface Breaker {
  /** True when the breaker is currently rejecting calls. */
  isOpen(): boolean;
  /** Record a successful call. Resets the failure window and closes the breaker. */
  recordSuccess(): void;
  /** Record a failed call. May trip the breaker if the threshold is crossed. */
  recordFailure(): void;
  /**
   * Convenience: guard a function with this breaker. Throws `BreakerOpenError`
   * synchronously when the breaker is open. Records success/failure for you.
   *
   * If you need to handle the open state without an exception (e.g. fall back
   * to a cached value), check `isOpen()` first and skip the call.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Current state, useful for metrics + tests. */
  state(): "closed" | "open";
  /** @internal — tests only */
  __resetForTest(): void;
}

export class BreakerOpenError extends Error {
  constructor(public readonly breakerName: string) {
    super(`circuit-breaker ${breakerName} is open`);
    this.name = "BreakerOpenError";
  }
}

export function createBreaker(opts: BreakerOptions): Breaker {
  if (opts.failureThreshold < 1) {
    throw new Error("failureThreshold must be >= 1");
  }
  if (opts.failureWindowMs < 1 || opts.cooldownMs < 1) {
    throw new Error("failureWindowMs and cooldownMs must be > 0");
  }

  let failureTimestamps: number[] = [];
  let openedAt: number | null = null;

  // Listener hook — fires on every open/close transition. Used by the
  // metrics module to bump a `breaker_state_changes_total` counter. Wired
  // via setBreakerListener so we avoid a circular import between the
  // metrics registry and the breaker factory.
  let onTransition: ((next: "open" | "closed") => void) | null = null;

  function refreshOpenState(): void {
    if (openedAt !== null && Date.now() - openedAt > opts.cooldownMs) {
      openedAt = null;
      failureTimestamps = [];
      onTransition?.("closed");
    }
  }

  const breaker: Breaker & { __setListener?: typeof onTransition } = {
    isOpen() {
      refreshOpenState();
      return openedAt !== null;
    },
    state() {
      refreshOpenState();
      return openedAt === null ? "closed" : "open";
    },
    recordSuccess() {
      const wasOpen = openedAt !== null;
      failureTimestamps = [];
      openedAt = null;
      if (wasOpen) onTransition?.("closed");
    },
    recordFailure() {
      const now = Date.now();
      failureTimestamps = failureTimestamps.filter(
        (t) => now - t < opts.failureWindowMs,
      );
      failureTimestamps.push(now);
      if (
        failureTimestamps.length >= opts.failureThreshold &&
        openedAt === null
      ) {
        openedAt = now;
        console.warn(
          `[breaker:${opts.name}] OPEN — ${opts.failureThreshold} failures in ${opts.failureWindowMs / 60_000}min, suspending calls for ${opts.cooldownMs / 60_000}min`,
        );
        onTransition?.("open");
      }
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (breaker.isOpen()) throw new BreakerOpenError(opts.name);
      try {
        const out = await fn();
        breaker.recordSuccess();
        return out;
      } catch (err) {
        breaker.recordFailure();
        throw err;
      }
    },
    __resetForTest() {
      failureTimestamps = [];
      openedAt = null;
    },
  };

  // Expose a setter for the listener without enlarging the public surface.
  Object.defineProperty(breaker, "__setListener", {
    value: (fn: ((next: "open" | "closed") => void) | null) => {
      onTransition = fn;
    },
    enumerable: false,
  });

  return breaker;
}
