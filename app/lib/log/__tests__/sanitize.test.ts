import { describe, expect, it } from "vitest";

import { sanitizeError, sanitizeText } from "../sanitize";

describe("sanitizeText", () => {
  it("masks email addresses", () => {
    expect(sanitizeText("Failed to lookup customer alice.dupont@example.com here"))
      .toBe("Failed to lookup customer <email> here");
  });

  it("masks shopify order numbers prefixed with #", () => {
    expect(sanitizeText("Order #12345 not found")).toBe("Order <order> not found");
  });

  it("masks tracking-like alphanumeric tokens", () => {
    expect(sanitizeText("Tracking AB123456789CD failed")).toBe("Tracking <token> failed");
  });

  it("leaves short uppercase words untouched", () => {
    expect(sanitizeText("ERROR: INVALID_INPUT raised")).toBe("ERROR: INVALID_INPUT raised");
  });

  it("truncates very long messages", () => {
    const long = "x".repeat(800);
    const out = sanitizeText(long);
    expect(out.length).toBeLessThanOrEqual(550);
    expect(out.endsWith("[truncated]")).toBe(true);
  });

  it("handles multiple PII types in one message", () => {
    const input = "Customer foo@bar.com placed order #9876 with tracking 1Z999AA10123456789";
    const out = sanitizeText(input);
    expect(out).not.toContain("foo@bar.com");
    expect(out).not.toContain("#9876");
    expect(out).not.toContain("1Z999AA10123456789");
  });
});

describe("sanitizeError", () => {
  it("returns name/message/stack for Error instances", () => {
    const err = new Error("Customer alice@example.com not found");
    err.stack = `Error: Customer alice@example.com not found
    at foo (/app/x.ts:1:1)
    at bar (/app/y.ts:2:2)`;
    const out = sanitizeError(err);
    expect(out.name).toBe("Error");
    expect(out.message).toBe("Customer <email> not found");
    expect(out.stack).toContain("<email>");
    expect(out.stack).not.toContain("alice@example.com");
  });

  it("limits stack to first 6 lines", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n" + Array.from({ length: 20 }, (_, i) => `  at frame${i}`).join("\n");
    const out = sanitizeError(err);
    const lines = (out.stack ?? "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it("handles non-Error throws", () => {
    expect(sanitizeError("string thrown")).toEqual({
      name: "NonError",
      message: "string thrown",
    });
    const out = sanitizeError({ code: "X", email: "alice@example.com" });
    expect(out.name).toBe("NonError");
    expect(out.message).not.toContain("alice@example.com");
  });
});
