import { describe, it, expect } from "vitest";
import { prefilterEmail } from "../prefilter";
import type { MailMessage } from "../../mail/types";

function makeMsg(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "1",
    threadId: "t1",
    from: "customer@example.com",
    fromName: "Customer",
    subject: "Test",
    bodyText: "Hello",
    snippet: "",
    receivedAt: new Date(),
    labelIds: [],
    headers: {},
    attachments: [],
    ...overrides,
  };
}

describe("prefilterEmail", () => {
  it("passes normal customer email", () => {
    const msg = makeMsg();
    const result = prefilterEmail(msg);
    expect(result.passed).toBe(true);
  });

  it("rejects SPAM label", () => {
    const msg = makeMsg({ labelIds: ["SPAM"] });
    const result = prefilterEmail(msg);
    expect(result.passed).toBe(false);
  });

  it("rejects TRASH label", () => {
    const msg = makeMsg({ labelIds: ["TRASH"] });
    const result = prefilterEmail(msg);
    expect(result.passed).toBe(false);
  });

  it("rejects CATEGORY_PROMOTIONS label", () => {
    const msg = makeMsg({ labelIds: ["CATEGORY_PROMOTIONS"] });
    const result = prefilterEmail(msg);
    expect(result.passed).toBe(false);
  });

  it("rejects multiple excluded labels", () => {
    const msg = makeMsg({ labelIds: ["INBOX", "CATEGORY_SOCIAL"] });
    const result = prefilterEmail(msg);
    expect(result.passed).toBe(false);
  });

  it("rejects noreply senders", () => {
    const msg = makeMsg({ from: "noreply@example.com" });
    const result = prefilterEmail(msg);
    expect(result.passed).toBe(false);
  });

  it("rejects mail with unsubscribe header", () => {
    const msg = makeMsg({ headers: { "list-unsubscribe": "<http://example.com>" } });
    const result = prefilterEmail(msg);
    expect(result.passed).toBe(false);
  });

  it("passes known customer email even with excluded labels", () => {
    const knownCustomers = new Set(["customer@example.com"]);
    const msg = makeMsg({ labelIds: ["SPAM"], from: "customer@example.com" });
    const result = prefilterEmail(msg, knownCustomers);
    expect(result.passed).toBe(true);
  });
});

describe("Outlook prefilter", () => {
  it("rejects OUTLOOK_CATEGORY_Promotions", () => {
    const msg = makeMsg({ labelIds: ["OUTLOOK_CATEGORY_Promotions"] });
    const result = prefilterEmail(msg);
    expect(result.passed).toBe(false);
  });

  it("rejects OUTLOOK_OTHER (focused=other emails)", () => {
    const msg = makeMsg({ labelIds: ["OUTLOOK_OTHER"] });
    const result = prefilterEmail(msg);
    expect(result.passed).toBe(false);
  });

  it("passes focused Outlook support emails (empty labelIds)", () => {
    const msg = makeMsg({ labelIds: [] });
    const result = prefilterEmail(msg);
    expect(result.passed).toBe(true);
  });
});
