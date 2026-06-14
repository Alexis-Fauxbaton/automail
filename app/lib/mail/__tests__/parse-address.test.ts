import { describe, it, expect } from "vitest";
import { extractEmailAddress } from "../parse-address";

describe("extractEmailAddress", () => {
  it("extracts from a `Name <email>` value", () => {
    expect(extractEmailAddress('"Denis Sicard" <dsicard@gmail.com>')).toBe("dsicard@gmail.com");
  });

  it("extracts a bare address", () => {
    expect(extractEmailAddress("dsicard@gmail.com")).toBe("dsicard@gmail.com");
  });

  it("takes the first of a comma-separated list", () => {
    expect(extractEmailAddress("a@x.com, b@y.com")).toBe("a@x.com");
  });

  it("lowercases the result", () => {
    expect(extractEmailAddress("Foo@Bar.COM")).toBe("foo@bar.com");
  });

  it("returns null for empty / missing / non-address values", () => {
    expect(extractEmailAddress("")).toBeNull();
    expect(extractEmailAddress(undefined)).toBeNull();
    expect(extractEmailAddress(null)).toBeNull();
    expect(extractEmailAddress("no-reply (no address)")).toBeNull();
  });
});
