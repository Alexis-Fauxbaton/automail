import { describe, it, expect } from "vitest";
import { canSend } from "../scopes";

describe("canSend", () => {
  it("Gmail with gmail.send scope can send", () => {
    expect(canSend({ provider: "gmail", grantedScopes: "https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly" })).toBe(true);
  });
  it("Gmail without gmail.send cannot send", () => {
    expect(canSend({ provider: "gmail", grantedScopes: "https://www.googleapis.com/auth/gmail.readonly" })).toBe(false);
  });
  it("Outlook with Mail.Send can send (case-insensitive)", () => {
    expect(canSend({ provider: "outlook", grantedScopes: "mail.send,mail.read,user.read,offline_access" })).toBe(true);
  });
  it("Outlook without Mail.Send cannot send", () => {
    expect(canSend({ provider: "outlook", grantedScopes: "mail.read,user.read,offline_access" })).toBe(false);
  });
  it("Zoho with messages.all can send", () => {
    expect(canSend({ provider: "zoho", grantedScopes: "zohomail.messages.all,zohomail.accounts.read" })).toBe(true);
  });
  it("Zoho with only messages.read cannot send", () => {
    expect(canSend({ provider: "zoho", grantedScopes: "zohomail.messages.read,zohomail.accounts.read" })).toBe(false);
  });
  it("null grantedScopes is treated as cannot send", () => {
    expect(canSend({ provider: "gmail", grantedScopes: null })).toBe(false);
  });
  it("unknown provider returns false", () => {
    expect(canSend({ provider: "yahoo", grantedScopes: "anything" })).toBe(false);
  });
});
