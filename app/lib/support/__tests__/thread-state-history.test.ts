import { describe, it, expect } from "vitest";
import { buildHistoryEntry } from "../thread-state-history";

describe("buildHistoryEntry", () => {
  it("retourne null quand l'ancien état est identique au nouvel état", () => {
    const entry = buildHistoryEntry({
      shop: "test.myshopify.com",
      threadId: "thread_1",
      fromState: "open",
      toState: "open",
    });
    expect(entry).toBeNull();
  });

  it("retourne une entrée quand l'état change", () => {
    const entry = buildHistoryEntry({
      shop: "test.myshopify.com",
      threadId: "thread_1",
      fromState: "open",
      toState: "resolved",
    });
    expect(entry).not.toBeNull();
    expect(entry!.shop).toBe("test.myshopify.com");
    expect(entry!.threadId).toBe("thread_1");
    expect(entry!.fromState).toBe("open");
    expect(entry!.toState).toBe("resolved");
  });

  it("retourne une entrée quand fromState est null (création initiale)", () => {
    const entry = buildHistoryEntry({
      shop: "test.myshopify.com",
      threadId: "thread_1",
      fromState: null,
      toState: "open",
    });
    expect(entry).not.toBeNull();
    expect(entry!.fromState).toBeNull();
  });
});
