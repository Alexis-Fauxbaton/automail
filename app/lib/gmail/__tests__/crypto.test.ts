import { describe, it, expect, beforeEach } from "vitest";
import { encrypt, decrypt } from "../crypto";

const VALID_KEY = "a".repeat(64); // 64 hex chars = 32 bytes

beforeEach(() => {
  process.env.GMAIL_TOKEN_SECRET = VALID_KEY;
});

describe("crypto", () => {
  it("round-trip: decrypt(encrypt(plaintext)) === plaintext", () => {
    const plaintext = "hello world";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("IV uniqueness: two encryptions of same plaintext produce different ciphertexts", () => {
    const plaintext = "same plaintext";
    const ct1 = encrypt(plaintext);
    const ct2 = encrypt(plaintext);
    expect(ct1).not.toBe(ct2);
  });

  it("wrong key length throws", () => {
    process.env.GMAIL_TOKEN_SECRET = "ab"; // too short
    expect(() => encrypt("test")).toThrow();
  });

  it("missing key throws", () => {
    delete process.env.GMAIL_TOKEN_SECRET;
    expect(() => encrypt("test")).toThrow();
  });

  it("tampered auth tag throws on decrypt", () => {
    const plaintext = "tamper test";
    const ciphertext = encrypt(plaintext);
    const buf = Buffer.from(ciphertext, "base64");
    // IV is bytes 0-15, tag is bytes 16-31 — flip bytes in the tag region
    buf[16] = buf[16] ^ 0xff;
    buf[17] = buf[17] ^ 0xff;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("unicode round-trip: handles accented characters correctly", () => {
    const plaintext = "Héllo wörld — こんにちは";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });
});
