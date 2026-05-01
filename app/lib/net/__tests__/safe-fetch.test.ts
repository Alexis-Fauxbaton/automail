import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("dns/promises", () => ({
  lookup: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { lookup } from "dns/promises";
import { safeFetch } from "../safe-fetch";

const mockLookup = lookup as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("safeFetch", () => {
  it("HTTP URL rejected with safe_fetch_non_https", async () => {
    await expect(safeFetch("http://example.com")).rejects.toThrow("safe_fetch_non_https");
  });

  it("malformed URL rejected with safe_fetch_invalid_url", async () => {
    await expect(safeFetch("not-a-url")).rejects.toThrow("safe_fetch_invalid_url");
  });

  it("10.x.x.x rejected with safe_fetch_private_ip", async () => {
    mockLookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    await expect(safeFetch("https://internal.example.com")).rejects.toThrow("safe_fetch_private_ip");
  });

  it("169.254.x.x (metadata endpoint) rejected with safe_fetch_private_ip", async () => {
    mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(safeFetch("https://metadata.example.com")).rejects.toThrow("safe_fetch_private_ip");
  });

  it("127.x.x.x literal IP rejected with safe_fetch_private_ip", async () => {
    // Literal IP — no DNS call needed
    await expect(safeFetch("https://127.0.0.1/path")).rejects.toThrow("safe_fetch_private_ip");
  });

  it("100.64.x.x literal IP rejected with safe_fetch_private_ip", async () => {
    await expect(safeFetch("https://100.64.0.1/path")).rejects.toThrow("safe_fetch_private_ip");
  });

  it("public IP passes and returns response", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fakeResponse = new Response("ok", { status: 200 });
    mockFetch.mockResolvedValue(fakeResponse);

    const result = await safeFetch("https://example.com");
    expect(result).toBe(fakeResponse);
  });

  it("allowlist blocks non-allowlisted host", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(
      safeFetch("https://evil.com", { allowedHosts: new Set(["good.com"]) }),
    ).rejects.toThrow("safe_fetch_host_not_allowlisted");
  });

  it("redirect to private IP is rejected", async () => {
    // First DNS call (for the original host) resolves to a public IP
    mockLookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]) // original host
      .mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);     // redirect target

    // First fetch returns a redirect to an internal host
    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: "https://redirect-target.internal/" },
      }),
    );

    await expect(safeFetch("https://public.example.com")).rejects.toThrow("safe_fetch_private_ip");
  });

  it("too many redirects throws safe_fetch_too_many_redirects", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    // Always return a redirect to the same URL (circular)
    mockFetch.mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { location: "https://example.com/redirect" },
      }),
    );

    await expect(safeFetch("https://example.com")).rejects.toThrow("safe_fetch_too_many_redirects");
  });
});
