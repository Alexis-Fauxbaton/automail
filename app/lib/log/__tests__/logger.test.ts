import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../logger";

interface CapturedLine {
  ts: string;
  level: string;
  shop: string;
  mod: string;
  msg: string;
  [key: string]: unknown;
}

function captureConsole() {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    lines: () =>
      [...logSpy.mock.calls, ...errSpy.mock.calls]
        .map((c) => c[0] as string)
        .map((s) => JSON.parse(s) as CapturedLine),
    logSpy,
    errSpy,
  };
}

describe("createLogger", () => {
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    cap = captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a JSON line with shop, mod, ts, level, msg", () => {
    const log = createLogger({ shop: "foo.myshopify.com", mod: "test" });
    log.info("hello world");
    const [line] = cap.lines().filter((l) => l.msg === "hello world");
    expect(line.shop).toBe("foo.myshopify.com");
    expect(line.mod).toBe("test");
    expect(line.level).toBe("info");
    expect(typeof line.ts).toBe("string");
  });

  it("routes errors to console.error and the rest to console.log", () => {
    const log = createLogger({ shop: "s", mod: "m" });
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(cap.logSpy).toHaveBeenCalledTimes(2);
    expect(cap.errSpy).toHaveBeenCalledTimes(1);
  });

  it("attaches sanitized error payload under `err`", () => {
    const log = createLogger({ shop: "s", mod: "m" });
    log.error({ err: new Error("alice@example.com failed") }, "boom");
    const line = cap.lines().find((l) => l.msg === "boom");
    expect(line).toBeDefined();
    const errField = line?.err as { message: string } | undefined;
    expect(errField?.message).toBe("<email> failed");
  });

  it("includes correlationId when provided in ctx", () => {
    const log = createLogger({ shop: "s", mod: "m", correlationId: "corr-123" });
    log.info("hi");
    const line = cap.lines().find((l) => l.msg === "hi");
    expect(line?.correlationId).toBe("corr-123");
  });

  it("merges payload extras into the line", () => {
    const log = createLogger({ shop: "s", mod: "m" });
    log.info({ threadId: "t-1", count: 3 }, "processed");
    const line = cap.lines().find((l) => l.msg === "processed");
    expect(line?.threadId).toBe("t-1");
    expect(line?.count).toBe(3);
  });

  it("child() inherits parent context and adds new fields", () => {
    const log = createLogger({ shop: "s", mod: "m" });
    const sub = log.child({ canonicalThreadId: "thr-1" });
    sub.info("nested");
    const line = cap.lines().find((l) => l.msg === "nested");
    expect(line?.shop).toBe("s");
    expect(line?.canonicalThreadId).toBe("thr-1");
  });

  it("sanitizes the message itself", () => {
    const log = createLogger({ shop: "s", mod: "m" });
    log.info("found bob@x.com in payload");
    const line = cap.lines().find((l) => l.shop === "s");
    expect(line?.msg).toBe("found <email> in payload");
  });

  it("logs a self-warning when called without shop", () => {
    createLogger({ shop: "", mod: "m" });
    const warn = cap.lines().find((l) => l.msg.includes("createLogger called without shop"));
    expect(warn).toBeDefined();
  });
});
