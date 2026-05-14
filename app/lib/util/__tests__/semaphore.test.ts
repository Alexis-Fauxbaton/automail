import { describe, expect, it } from "vitest";
import { createSemaphore } from "../semaphore";

describe("createSemaphore", () => {
  it("rejects maxConcurrent < 1", () => {
    expect(() => createSemaphore(0)).toThrow(/maxConcurrent/);
    expect(() => createSemaphore(-1)).toThrow(/maxConcurrent/);
  });

  it("allows up to maxConcurrent concurrent holders", async () => {
    const sem = createSemaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.stats().inFlight).toBe(2);
    expect(sem.stats().queued).toBe(0);

    // Third acquire should be queued, not granted yet.
    let third: (() => void) | null = null;
    const p3 = sem.acquire().then((r) => {
      third = r;
    });
    // Give the microtask queue a tick — third must still be pending.
    await Promise.resolve();
    expect(third).toBeNull();
    expect(sem.stats().queued).toBe(1);

    // Releasing one lets the queued waiter through.
    r1();
    await p3;
    expect(third).not.toBeNull();
    expect(sem.stats().inFlight).toBe(2);
    expect(sem.stats().queued).toBe(0);

    // Cleanup.
    r2();
    if (third) (third as () => void)();
  });

  it("serves waiters FIFO", async () => {
    const sem = createSemaphore(1);
    const r1 = await sem.acquire();
    const order: number[] = [];

    const p2 = sem.acquire().then((r) => {
      order.push(2);
      r();
    });
    const p3 = sem.acquire().then((r) => {
      order.push(3);
      r();
    });
    const p4 = sem.acquire().then((r) => {
      order.push(4);
      r();
    });

    r1();
    await Promise.all([p2, p3, p4]);
    expect(order).toEqual([2, 3, 4]);
  });

  it("double-release is safe (clamps inFlight at 0)", async () => {
    const sem = createSemaphore(1);
    const r = await sem.acquire();
    r();
    r(); // double release — should not go negative
    expect(sem.stats().inFlight).toBe(0);
  });
});
