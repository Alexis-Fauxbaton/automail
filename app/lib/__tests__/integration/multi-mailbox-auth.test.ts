import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import { cleanTestShop, TEST_SHOP } from "./helpers/db";
import { saveConnection as saveGmail } from "../../gmail/auth";
import { saveConnection as saveOutlook } from "../../outlook/auth";

describe("multi-mailbox auth", () => {
  beforeEach(async () => {
    await cleanTestShop();
  });

  it("allows two different mailboxes on the same shop", async () => {
    await saveGmail(TEST_SHOP, {
      accessToken: "g-access",
      refreshToken: "g-refresh",
      expiry: new Date(Date.now() + 3600_000),
      email: "support@brand.com",
    });
    await saveOutlook(TEST_SHOP, {
      accessToken: "o-access",
      refreshToken: "o-refresh",
      expiry: new Date(Date.now() + 3600_000),
      email: "returns@brand.com",
    });

    const conns = await prisma.mailConnection.findMany({ where: { shop: TEST_SHOP } });
    expect(conns).toHaveLength(2);
    const emails = conns.map((c) => c.email).sort();
    expect(emails).toEqual(["returns@brand.com", "support@brand.com"]);
  });

  it("upserts the same (shop, email) instead of creating a duplicate", async () => {
    await saveGmail(TEST_SHOP, {
      accessToken: "v1",
      refreshToken: "r1",
      expiry: new Date(Date.now() + 3600_000),
      email: "support@brand.com",
    });
    await saveGmail(TEST_SHOP, {
      accessToken: "v2",
      refreshToken: "r2",
      expiry: new Date(Date.now() + 3600_000),
      email: "support@brand.com",
    });
    const conns = await prisma.mailConnection.findMany({ where: { shop: TEST_SHOP } });
    expect(conns).toHaveLength(1);
  });

  it("rejects two connections on (shop, email) regardless of provider", async () => {
    await saveGmail(TEST_SHOP, {
      accessToken: "g",
      refreshToken: "g",
      expiry: new Date(Date.now() + 3600_000),
      email: "support@brand.com",
    });
    // Outlook upsert for the same (shop, email) — should overwrite, not create a new row
    await saveOutlook(TEST_SHOP, {
      accessToken: "o",
      refreshToken: "o",
      expiry: new Date(Date.now() + 3600_000),
      email: "support@brand.com",
    });
    const conns = await prisma.mailConnection.findMany({ where: { shop: TEST_SHOP } });
    expect(conns).toHaveLength(1);
    expect(conns[0].provider).toBe("outlook"); // last write wins
  });
});
