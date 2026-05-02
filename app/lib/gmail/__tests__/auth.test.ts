import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
//
// vi.mock() is hoisted to the top of the compiled output by Vitest, meaning
// the factory function runs BEFORE any `const` / `let` declarations in this
// file. Therefore no module-level variable can be referenced inside a factory.
//
// Strategy:
//   - Keep all spy creation inside the factory.
//   - Use `vi.importMock` / cast after import to retrieve the mocked module
//     and access its fns in tests.
// ---------------------------------------------------------------------------

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: vi.fn(function () {
        return {
          generateAuthUrl: vi.fn().mockReturnValue(
            "https://accounts.google.com/o/oauth2/auth?state=test",
          ),
          getToken: vi.fn(),
          setCredentials: vi.fn(),
        };
      }),
    },
    oauth2: vi.fn().mockReturnValue({
      userinfo: {
        get: vi.fn().mockResolvedValue({ data: { email: "user@example.com" } }),
      },
    }),
  },
}));

vi.mock("../../../db.server", () => ({
  default: {
    $transaction: vi.fn(),
    mailConnection: { delete: vi.fn(), upsert: vi.fn() },
    incomingEmail: { deleteMany: vi.fn() },
  },
}));

// Imports come AFTER vi.mock declarations (automatically hoisted by Vitest).
import { getAuthUrl, exchangeCodeForTokens, deleteConnection } from "../auth";
import { google } from "googleapis";
import prisma from "../../../db.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the mock instance created by the most recent `new OAuth2()` call. */
function getLastOAuth2Instance(): {
  generateAuthUrl: ReturnType<typeof vi.fn>;
  getToken: ReturnType<typeof vi.fn>;
  setCredentials: ReturnType<typeof vi.fn>;
} {
  const OAuth2 = google.auth.OAuth2 as ReturnType<typeof vi.fn>;
  const results = OAuth2.mock.results;
  return results[results.length - 1]?.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.SHOPIFY_API_SECRET = "test-shopify-secret";

  // Reset the OAuth2 constructor so each test gets fresh per-instance spies.
  (google.auth.OAuth2 as ReturnType<typeof vi.fn>).mockReset();
  (google.auth.OAuth2 as ReturnType<typeof vi.fn>).mockImplementation(function () {
    return {
      generateAuthUrl: vi.fn().mockReturnValue(
        "https://accounts.google.com/o/oauth2/auth?state=test",
      ),
      getToken: vi.fn(),
      setCredentials: vi.fn(),
    };
  });

  // Reset $transaction.
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockReset();
});

describe("gmail/auth", () => {
  describe("getAuthUrl", () => {
    it("includes a non-empty state param", () => {
      getAuthUrl("test-shop.myshopify.com");

      const instance = getLastOAuth2Instance();
      expect(instance.generateAuthUrl).toHaveBeenCalledOnce();

      const [options] = instance.generateAuthUrl.mock.calls[0] as [{ state?: string }][];
      expect(typeof options.state).toBe("string");
      expect((options.state as string).length).toBeGreaterThan(0);
    });
  });

  describe("exchangeCodeForTokens", () => {
    it("throws when access_token is missing", async () => {
      // Override getToken for this specific OAuth2 instance.
      (google.auth.OAuth2 as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
        return {
          generateAuthUrl: vi.fn(),
          getToken: vi.fn().mockResolvedValueOnce({ tokens: { refresh_token: "rt" } }),
          setCredentials: vi.fn(),
        };
      });

      await expect(exchangeCodeForTokens("code-123")).rejects.toThrow("required tokens");
    });

    it("throws when refresh_token is missing", async () => {
      (google.auth.OAuth2 as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
        return {
          generateAuthUrl: vi.fn(),
          getToken: vi.fn().mockResolvedValueOnce({ tokens: { access_token: "at" } }),
          setCredentials: vi.fn(),
        };
      });

      await expect(exchangeCodeForTokens("code-456")).rejects.toThrow("required tokens");
    });
  });

  describe("deleteConnection", () => {
    it("runs in a transaction and deletes for the correct shop", async () => {
      const shop = "my-shop.myshopify.com";

      const txDelete = vi.fn();
      const txDeleteMany = vi.fn();

      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (cb: (tx: unknown) => Promise<void>) =>
          cb({ mailConnection: { delete: txDelete }, incomingEmail: { deleteMany: txDeleteMany } }),
      );

      await deleteConnection(shop);

      expect(txDelete).toHaveBeenCalledWith({ where: { shop } });
      expect(txDeleteMany).toHaveBeenCalledWith({ where: { shop } });
    });
  });
});
