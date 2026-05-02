import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../db.server", () => ({
  default: {
    mailConnection: {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    incomingEmail: { deleteMany: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      mailConnection: { delete: vi.fn().mockResolvedValue({}) },
      incomingEmail: { deleteMany: vi.fn().mockResolvedValue({}) },
    })),
  },
}));

vi.mock("../../gmail/crypto", () => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace(/^enc:/, "")),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { getAuthUrl, exchangeCodeForTokens, saveConnection, getAuthenticatedClient } from "../auth";
import prisma from "../../../db.server";

describe("outlook/auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MICROSOFT_CLIENT_ID = "test-client-id";
    process.env.MICROSOFT_CLIENT_SECRET = "test-client-secret";
    process.env.SHOPIFY_APP_URL = "https://example.com";
    process.env.SHOPIFY_API_SECRET = "test-secret-32-chars-padded-here";
  });

  describe("getAuthUrl", () => {
    it("returns a Microsoft Identity Platform URL with correct params", () => {
      const url = new URL(getAuthUrl("test-shop.myshopify.com"));
      expect(url.hostname).toBe("login.microsoftonline.com");
      expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
      expect(url.searchParams.get("client_id")).toBe("test-client-id");
      expect(url.searchParams.get("response_type")).toBe("code");
      const scope = url.searchParams.get("scope") ?? "";
      expect(scope).toContain("Mail.Read");
      expect(scope).toContain("offline_access");
      expect(url.searchParams.get("state")).toBeTruthy();
    });
  });

  describe("exchangeCodeForTokens", () => {
    it("exchanges code and fetches user email", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: "access-abc",
            refresh_token: "refresh-xyz",
            expires_in: 3600,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ mail: "user@outlook.com", userPrincipalName: "user@outlook.com" }),
        });

      const tokens = await exchangeCodeForTokens("auth-code-123");

      expect(tokens.accessToken).toBe("access-abc");
      expect(tokens.refreshToken).toBe("refresh-xyz");
      expect(tokens.email).toBe("user@outlook.com");
      expect(tokens.expiry.getTime()).toBeGreaterThan(Date.now() + 3500_000);
    });

    it("throws when token endpoint returns error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant", error_description: "Code expired" }),
      });

      await expect(exchangeCodeForTokens("bad-code")).rejects.toThrow("Microsoft token exchange failed");
    });

    it("falls back to userPrincipalName when mail field is empty", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "tok", refresh_token: "ref", expires_in: 3600 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ mail: null, userPrincipalName: "user@tenant.onmicrosoft.com" }),
        });

      const tokens = await exchangeCodeForTokens("code");
      expect(tokens.email).toBe("user@tenant.onmicrosoft.com");
    });
  });

  describe("getAuthenticatedClient", () => {
    it("returns tokens directly when not expired", async () => {
      const futureExpiry = new Date(Date.now() + 2 * 3600_000);
      (prisma.mailConnection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        accessToken: "enc:access-tok",
        refreshToken: "enc:refresh-tok",
        tokenExpiry: futureExpiry,
      });

      const client = await getAuthenticatedClient("test-shop.myshopify.com");
      expect(client.accessToken).toBe("access-tok");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refreshes token when near expiry", async () => {
      const nearExpiry = new Date(Date.now() + 30_000);
      (prisma.mailConnection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        accessToken: "enc:old-access",
        refreshToken: "enc:refresh-tok",
        tokenExpiry: nearExpiry,
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      });

      const client = await getAuthenticatedClient("test-shop.myshopify.com");
      expect(client.accessToken).toBe("new-access");
      expect(prisma.mailConnection.update).toHaveBeenCalled();
    });

    it("throws when no connection exists", async () => {
      (prisma.mailConnection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(getAuthenticatedClient("test-shop.myshopify.com")).rejects.toThrow(
        "No Outlook connection for this shop",
      );
    });
  });
});
