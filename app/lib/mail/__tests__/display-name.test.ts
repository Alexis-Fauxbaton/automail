import { describe, it, expect } from "vitest";
import { sanitizeFromName } from "../display-name";

describe("sanitizeFromName", () => {
  it("strips CR, LF, quotes and control chars (header-injection defense)", () => {
    expect(sanitizeFromName('A\r\nBcc: x@y.com')).toBe("ABcc: x@y.com");
    expect(sanitizeFromName('AMBIENT "HOME"')).toBe("AMBIENT HOME");
  });
  it("trims and caps at 100 chars", () => {
    expect(sanitizeFromName("  AMBIENT HOME  ")).toBe("AMBIENT HOME");
    expect(sanitizeFromName("x".repeat(150)).length).toBe(100);
  });
});
