import { describe, it, expect, beforeAll } from "vitest";
import {
  encryptSessionToken,
  decryptSessionToken,
  isEncrypted,
} from "../session-crypto";

beforeAll(() => {
  // 32-byte test key (= 64 hex chars). Never used outside tests.
  if (!process.env.SHOPIFY_SESSION_SECRET) {
    process.env.SHOPIFY_SESSION_SECRET =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  }
});

describe("session-crypto", () => {
  it("round-trips a Shopify access token", () => {
    const plaintext = "shpat_1234567890abcdef";
    const cipher = encryptSessionToken(plaintext);
    expect(cipher).not.toContain(plaintext);
    expect(cipher).toMatch(/^enc:v1:/);
    expect(decryptSessionToken(cipher)).toBe(plaintext);
  });

  it("emits a different ciphertext each call (random IV)", () => {
    const plaintext = "shpat_same_input";
    const a = encryptSessionToken(plaintext);
    const b = encryptSessionToken(plaintext);
    expect(a).not.toBe(b);
    expect(decryptSessionToken(a)).toBe(plaintext);
    expect(decryptSessionToken(b)).toBe(plaintext);
  });

  it("returns legacy plaintext unchanged through decryptSessionToken", () => {
    // A row that pre-dates the encryption migration: no marker, return as-is.
    const legacy = "shpat_plaintext_legacy";
    expect(isEncrypted(legacy)).toBe(false);
    expect(decryptSessionToken(legacy)).toBe(legacy);
  });

  it("isEncrypted distinguishes new ciphertext from legacy plaintext", () => {
    const enc = encryptSessionToken("token");
    expect(isEncrypted(enc)).toBe(true);
    expect(isEncrypted("token")).toBe(false);
    expect(isEncrypted("")).toBe(false);
  });

  it("throws when the secret is missing", () => {
    const saved = process.env.SHOPIFY_SESSION_SECRET;
    const savedFallback = process.env.GMAIL_TOKEN_SECRET;
    delete process.env.SHOPIFY_SESSION_SECRET;
    delete process.env.GMAIL_TOKEN_SECRET;
    try {
      expect(() => encryptSessionToken("token")).toThrow(/required/);
    } finally {
      if (saved) process.env.SHOPIFY_SESSION_SECRET = saved;
      if (savedFallback) process.env.GMAIL_TOKEN_SECRET = savedFallback;
    }
  });

  it("rejects a malformed secret length", () => {
    const saved = process.env.SHOPIFY_SESSION_SECRET;
    process.env.SHOPIFY_SESSION_SECRET = "deadbeef"; // 4 bytes, not 32
    try {
      expect(() => encryptSessionToken("token")).toThrow(/64 hex chars/);
    } finally {
      process.env.SHOPIFY_SESSION_SECRET = saved;
    }
  });
});
