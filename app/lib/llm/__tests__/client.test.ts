import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { computeCostUsd, getOpenAIClient } from "../client";

describe("computeCostUsd", () => {
  it("uses exact pricing for known models", () => {
    // gpt-4o: input 2.50 / output 10.00 per 1M tokens
    // 1000 prompt + 500 completion → (1000 * 2.50 + 500 * 10.00) / 1_000_000
    expect(computeCostUsd("gpt-4o", 1000, 500)).toBeCloseTo(0.0075, 6);
  });

  it("uses prefix match for versioned model names", () => {
    // gpt-4o-mini-2024-07-18 should match gpt-4o-mini pricing.
    const versioned = computeCostUsd("gpt-4o-mini-2024-07-18", 1000, 500);
    const base = computeCostUsd("gpt-4o-mini", 1000, 500);
    expect(versioned).toBe(base);
  });

  it("prefers the longest prefix when multiple keys match", () => {
    // "gpt-4.1-mini-foo" should match "gpt-4.1-mini" (not "gpt-4.1").
    const longer = computeCostUsd("gpt-4.1-mini-foo", 1000, 0);
    const baseMini = computeCostUsd("gpt-4.1-mini", 1000, 0);
    expect(longer).toBe(baseMini);
    // Sanity: it should NOT equal the gpt-4.1 price.
    expect(longer).not.toBe(computeCostUsd("gpt-4.1", 1000, 0));
  });

  it("returns 0 for unknown models", () => {
    expect(computeCostUsd("anthropic-claude-9", 1000, 500)).toBe(0);
    expect(computeCostUsd("", 1000, 500)).toBe(0);
  });

  it("handles zero tokens", () => {
    expect(computeCostUsd("gpt-4o", 0, 0)).toBe(0);
  });
});

describe("getOpenAIClient", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it("returns null when OPENAI_API_KEY is undefined", () => {
    delete process.env.OPENAI_API_KEY;
    expect(getOpenAIClient()).toBeNull();
  });

  it("returns null for the placeholder value (regression test for the lazy-init fix)", () => {
    process.env.OPENAI_API_KEY = "sk-your-key-here";
    expect(getOpenAIClient()).toBeNull();
  });

  it("returns an OpenAI client when a real key is set", () => {
    process.env.OPENAI_API_KEY = "sk-test-1234567890";
    const client = getOpenAIClient();
    expect(client).not.toBeNull();
  });
});
