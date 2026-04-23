import { describe, it, expect } from "vitest";
import { parseMessage } from "../message-parser";

describe("parseMessage", () => {
  it("combines subject and body into normalized text", () => {
    const result = parseMessage("Order #1234", "Where is my package?");
    expect(result.subject).toBe("Order #1234");
    expect(result.body).toBe("Where is my package?");
    expect(result.normalized).toBe("order #1234\nwhere is my package?");
  });

  it("normalizes CRLF to LF", () => {
    const result = parseMessage("Sub", "line1\r\nline2\r\nline3");
    expect(result.body).toBe("line1\nline2\nline3");
  });

  it("trims leading and trailing whitespace", () => {
    const result = parseMessage("  Subject  ", "  Body  ");
    expect(result.subject).toBe("Subject");
    expect(result.body).toBe("Body");
  });

  it("handles empty subject", () => {
    const result = parseMessage("", "Some body");
    expect(result.subject).toBe("");
    expect(result.normalized).toBe("\nsome body");
  });

  it("handles empty body", () => {
    const result = parseMessage("Some subject", "");
    expect(result.body).toBe("");
    expect(result.normalized).toBe("some subject\n");
  });

  it("handles both empty", () => {
    const result = parseMessage("", "");
    expect(result.subject).toBe("");
    expect(result.body).toBe("");
    expect(result.normalized).toBe("\n");
  });

  it("lowercases the normalized field", () => {
    const result = parseMessage("UPPER CASE", "BODY TEXT");
    expect(result.normalized).toBe("upper case\nbody text");
  });

  it("handles null-like inputs gracefully", () => {
    // @ts-expect-error testing runtime safety
    const result = parseMessage(null, undefined);
    expect(result.subject).toBe("");
    expect(result.body).toBe("");
  });
});
