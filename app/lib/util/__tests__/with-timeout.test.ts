import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "../with-timeout";

describe("withTimeout", () => {
  it("resolves with the promise value when it settles in time", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 100);
    expect(result).toBe("ok");
  });

  it("rejects with a clear error after the timeout elapses", async () => {
    const slow = new Promise<string>((resolve) =>
      setTimeout(() => resolve("late"), 200),
    );
    await expect(withTimeout(slow, 50, "test-op")).rejects.toThrow(
      /test-op timed out after 50ms/,
    );
  });

  it("propagates the underlying error when the promise rejects in time", async () => {
    const err = new Error("inner");
    await expect(withTimeout(Promise.reject(err), 100)).rejects.toBe(err);
  });

  it("does not leak a timer when the promise resolves first", async () => {
    const setSpy = vi.spyOn(global, "setTimeout");
    const clearSpy = vi.spyOn(global, "clearTimeout");
    await withTimeout(Promise.resolve(42), 5000);
    expect(setSpy).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
