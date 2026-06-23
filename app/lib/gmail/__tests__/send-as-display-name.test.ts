import { describe, it, expect } from "vitest";
import { pickPrimaryDisplayName } from "../auth";

describe("pickPrimaryDisplayName", () => {
  const items = [
    { sendAsEmail: "info@ambienthome.fr", displayName: "AMBIENT HOME", isPrimary: true, verificationStatus: "accepted" },
    { sendAsEmail: "alias@ambienthome.fr", displayName: "Alias", isPrimary: false, verificationStatus: "accepted" },
  ];
  it("returns the primary entry's display name", () => {
    expect(pickPrimaryDisplayName(items, "info@ambienthome.fr")).toBe("AMBIENT HOME");
  });
  it("matches by address when isPrimary is absent", () => {
    const noFlag = [{ sendAsEmail: "info@ambienthome.fr", displayName: "AMBIENT HOME", verificationStatus: "accepted" }];
    expect(pickPrimaryDisplayName(noFlag, "INFO@ambienthome.fr")).toBe("AMBIENT HOME");
  });
  it("skips unverified entries and returns null when no name", () => {
    expect(pickPrimaryDisplayName([{ sendAsEmail: "x@y.com", displayName: "X", isPrimary: true, verificationStatus: "pending" }], "x@y.com")).toBeNull();
    expect(pickPrimaryDisplayName([], "x@y.com")).toBeNull();
  });
});
