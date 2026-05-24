import { describe, it, expect } from "vitest";
import { mailboxColor } from "../mailbox-color";

describe("mailboxColor", () => {
  it("returns the same colour for the same email", () => {
    expect(mailboxColor("support@brand.com")).toBe(mailboxColor("support@brand.com"));
  });
  it("returns different colours for different emails (deterministic with known values)", () => {
    // These three emails deterministically map to distinct palette entries
    // with the djb2-style hash used in mailboxColor.
    const a = mailboxColor("support@brand.com");
    const b = mailboxColor("hello@c.com");
    const c = mailboxColor("sales@f.com");
    expect(new Set([a.bg, b.bg, c.bg]).size).toBe(3);
  });
});
