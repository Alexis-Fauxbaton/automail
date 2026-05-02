import { describe, it, expect, beforeEach } from "vitest";
import { signOAuthState, verifyOAuthState } from "../oauth-state";
import { createHmac } from "crypto";

const TEST_SECRET = "test-secret-for-oauth-state";

describe("oauth-state", () => {
  beforeEach(() => {
    process.env.SHOPIFY_API_SECRET = TEST_SECRET;
  });
  it("round-trip: verifyOAuthState(signOAuthState(gmail, shop)) returns expected object", () => {
    const state = signOAuthState("gmail", "test.myshopify.com");
    expect(verifyOAuthState(state)).toEqual({
      provider: "gmail",
      shop: "test.myshopify.com",
    });
  });

  it("zoho round-trip: verifyOAuthState(signOAuthState(zoho, shop)) returns expected object", () => {
    const state = signOAuthState("zoho", "test.myshopify.com");
    expect(verifyOAuthState(state)).toEqual({
      provider: "zoho",
      shop: "test.myshopify.com",
    });
  });

  it("expired state returns null after 11 minutes", () => {
    const state = signOAuthState("gmail", "test.myshopify.com");
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 11 * 60_000;
      expect(verifyOAuthState(state)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it("tampered body returns null", () => {
    const state = signOAuthState("gmail", "test.myshopify.com");
    const dot = state.lastIndexOf(".");
    const sig = state.slice(dot + 1);
    // Replace body with a different base64url string
    const tamperedBody = "dGFtcGVyZWQ"; // base64url of "tampered"
    expect(verifyOAuthState(`${tamperedBody}.${sig}`)).toBeNull();
  });

  it("tampered signature returns null", () => {
    const state = signOAuthState("gmail", "test.myshopify.com");
    // Append an extra character to the signature
    expect(verifyOAuthState(state + "X")).toBeNull();
  });

  it("wrong provider returns null", () => {
    // Manually construct a state with provider "microsoft" (invalid provider)
    const payload = { p: "microsoft" as any, s: "test.myshopify.com", t: Date.now(), n: "abc123" };
    const body = Buffer.from(JSON.stringify(payload), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const sig = createHmac("sha256", TEST_SECRET)
      .update(body)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifyOAuthState(`${body}.${sig}`)).toBeNull();
  });

  it("non-myshopify domain returns null", () => {
    // signOAuthState signs it, but verifyOAuthState should reject it
    const state = signOAuthState("gmail", "bad-domain.example.com" as any);
    expect(verifyOAuthState(state)).toBeNull();
  });

  it("empty string returns null", () => {
    expect(verifyOAuthState("")).toBeNull();
  });

  it("null input returns null", () => {
    expect(verifyOAuthState(null as any)).toBeNull();
  });

  it("nonce uniqueness: two signOAuthState calls produce different strings", () => {
    const s1 = signOAuthState("gmail", "test.myshopify.com");
    const s2 = signOAuthState("gmail", "test.myshopify.com");
    expect(s1).not.toBe(s2);
  });

  it("signs and verifies an outlook state", () => {
    const state = signOAuthState("outlook", "test-shop.myshopify.com");
    const result = verifyOAuthState(state);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("outlook");
    expect(result!.shop).toBe("test-shop.myshopify.com");
  });
});
