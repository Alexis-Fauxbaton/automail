import { describe, it, expect } from "vitest";
import { isOutgoingMessage, type OutgoingContext } from "../outgoing-detection";

function ctx(partial: Partial<OutgoingContext> = {}): OutgoingContext {
  return {
    mailboxAddress: partial.mailboxAddress ?? "info@example.com",
    knownOutgoingAddresses: partial.knownOutgoingAddresses ?? new Set(["info@example.com"]),
  };
}

describe("isOutgoingMessage", () => {
  it("returns true when the provider tagged SENT", () => {
    const c = ctx({ mailboxAddress: "", knownOutgoingAddresses: new Set() });
    expect(isOutgoingMessage({ from: "x@y.com", labelIds: ["SENT"] }, c)).toBe(true);
  });

  it("returns true when from matches the connected mailbox", () => {
    expect(isOutgoingMessage({ from: "info@example.com", labelIds: [] }, ctx())).toBe(true);
  });

  it("returns true when from matches a known outgoing alias (no SENT label, no exact mailbox match)", () => {
    const c = ctx({
      mailboxAddress: "info@example.com",
      knownOutgoingAddresses: new Set(["info@example.com", "support@example.com"]),
    });
    expect(isOutgoingMessage({ from: "support@example.com", labelIds: [] }, c)).toBe(true);
  });

  it("is case-insensitive on the from address", () => {
    expect(isOutgoingMessage({ from: "INFO@Example.COM", labelIds: [] }, ctx())).toBe(true);
  });

  it("trims whitespace on the from address", () => {
    expect(isOutgoingMessage({ from: "  info@example.com  ", labelIds: [] }, ctx())).toBe(true);
  });

  it("returns false for a customer message", () => {
    expect(isOutgoingMessage({ from: "customer@gmail.com", labelIds: [] }, ctx())).toBe(false);
  });

  it("returns false when from is empty (defensive)", () => {
    expect(isOutgoingMessage({ from: "", labelIds: [] }, ctx())).toBe(false);
  });

  it("still returns false when mailboxAddress is empty AND no SENT label AND not in known aliases", () => {
    const c = ctx({ mailboxAddress: "", knownOutgoingAddresses: new Set() });
    expect(isOutgoingMessage({ from: "info@example.com", labelIds: [] }, c)).toBe(false);
  });
});
