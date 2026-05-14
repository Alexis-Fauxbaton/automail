/**
 * Process-wide circuit breaker for the 17track API.
 *
 * Why module-global, not per-shop: the API key + free-tier quota are global,
 * so a burst of failures from one shop affects the *next* shop too. Opening
 * the breaker once for the whole process stops the bleed for everyone.
 *
 * In-memory only — acceptable because the failure window (10 min) is short,
 * and the worst case after a restart is one extra batch of failed calls.
 */

const FAILURE_THRESHOLD = 5;
const FAILURE_WINDOW_MS = 10 * 60_000;
const COOLDOWN_MS = 15 * 60_000;

let failureTimestamps: number[] = [];
let openedAt: number | null = null;

export function recordSuccess(): void {
  failureTimestamps = [];
  openedAt = null;
}

export function recordFailure(): void {
  const now = Date.now();
  failureTimestamps = failureTimestamps.filter(
    (t) => now - t < FAILURE_WINDOW_MS,
  );
  failureTimestamps.push(now);
  if (failureTimestamps.length >= FAILURE_THRESHOLD && openedAt === null) {
    openedAt = now;
    console.warn(
      `[17track-breaker] OPEN — ${FAILURE_THRESHOLD} failures in ${FAILURE_WINDOW_MS / 60_000}min, suspending calls for ${COOLDOWN_MS / 60_000}min`,
    );
  }
}

export function isOpen(): boolean {
  if (openedAt === null) return false;
  if (Date.now() - openedAt > COOLDOWN_MS) {
    openedAt = null;
    failureTimestamps = [];
    return false;
  }
  return true;
}

/** @internal — tests only */
export function __resetForTest(): void {
  failureTimestamps = [];
  openedAt = null;
}
