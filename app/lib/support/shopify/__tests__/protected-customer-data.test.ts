import { describe, it, expect } from "vitest";
import {
  isProtectedCustomerDataError,
  partitionGraphqlErrors,
  type ShopifyGraphqlError,
} from "../protected-customer-data";

describe("protected-customer-data", () => {
  describe("isProtectedCustomerDataError", () => {
    it("returns true for ACCESS_DENIED on the customer object", () => {
      const err: ShopifyGraphqlError = {
        message: "Access denied for customer field.",
        path: ["orders", "edges", 0, "node", "customer"],
        extensions: { code: "ACCESS_DENIED" },
      };
      expect(isProtectedCustomerDataError(err)).toBe(true);
    });

    it("returns true for ACCESS_DENIED on a PCD field", () => {
      for (const field of ["email", "phone", "firstName", "lastName", "defaultAddress"]) {
        expect(
          isProtectedCustomerDataError({
            message: "Access denied.",
            path: ["customer", field],
            extensions: { code: "ACCESS_DENIED" },
          }),
        ).toBe(true);
      }
    });

    it("returns false for ACCESS_DENIED on a non-PCD field", () => {
      // Example: a different field gated for reasons unrelated to PCD —
      // we want to surface that loudly, not swallow it.
      const err: ShopifyGraphqlError = {
        message: "Access denied for priceRule.",
        path: ["priceRule"],
        extensions: { code: "ACCESS_DENIED" },
      };
      expect(isProtectedCustomerDataError(err)).toBe(false);
    });

    it("returns false for a non-ACCESS_DENIED code", () => {
      const err: ShopifyGraphqlError = {
        message: "Throttled.",
        path: ["customer"],
        extensions: { code: "THROTTLED" },
      };
      expect(isProtectedCustomerDataError(err)).toBe(false);
    });

    it("returns false when no path is provided", () => {
      const err: ShopifyGraphqlError = {
        message: "Access denied.",
        extensions: { code: "ACCESS_DENIED" },
      };
      expect(isProtectedCustomerDataError(err)).toBe(false);
    });
  });

  describe("partitionGraphqlErrors", () => {
    it("splits PCD and non-PCD errors", () => {
      const errors: ShopifyGraphqlError[] = [
        {
          message: "PCD on email",
          path: ["customer", "email"],
          extensions: { code: "ACCESS_DENIED" },
        },
        {
          message: "Throttled",
          extensions: { code: "THROTTLED" },
        },
        {
          message: "PCD on phone",
          path: ["customer", "phone"],
          extensions: { code: "ACCESS_DENIED" },
        },
      ];
      const { pcdErrors, realErrors } = partitionGraphqlErrors(errors);
      expect(pcdErrors).toHaveLength(2);
      expect(realErrors).toHaveLength(1);
      expect(realErrors[0].message).toBe("Throttled");
    });

    it("handles empty arrays cleanly", () => {
      const { pcdErrors, realErrors } = partitionGraphqlErrors([]);
      expect(pcdErrors).toEqual([]);
      expect(realErrors).toEqual([]);
    });
  });
});
