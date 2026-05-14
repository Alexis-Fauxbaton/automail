/**
 * Tiny FIFO semaphore. Keeps the surface area minimal so we don't pull in
 * `p-limit` for a single use case. Acquire returns a release function the
 * caller MUST call (use try/finally).
 *
 * Fairness: callers are released in the order they queued.
 */
export interface Semaphore {
  acquire(): Promise<() => void>;
  /** @internal — diagnostics only. */
  stats(): { inFlight: number; queued: number };
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  if (maxConcurrent < 1) throw new Error("maxConcurrent must be >= 1");
  let inFlight = 0;
  const queue: Array<() => void> = [];

  function release(): void {
    inFlight = Math.max(0, inFlight - 1);
    const next = queue.shift();
    if (next) next();
  }

  return {
    async acquire(): Promise<() => void> {
      if (inFlight < maxConcurrent) {
        inFlight++;
        return release;
      }
      await new Promise<void>((resolve) => queue.push(resolve));
      inFlight++;
      return release;
    },
    stats: () => ({ inFlight, queued: queue.length }),
  };
}
