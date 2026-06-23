import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import { resetTestDb, TEST_SHOP, seedMailConnection } from "./helpers/db";
import { handleSetFromName } from "../../support/inbox-actions";

describe("handleSetFromName — integration", () => {
  beforeEach(async () => { await resetTestDb(); });

  it("sets the display name on the right mailbox, sanitized", async () => {
    const conn = await seedMailConnection({ shop: TEST_SHOP, provider: "zoho", email: "info@brand.com" });
    const res = await handleSetFromName({ shop: TEST_SHOP, mailConnectionId: conn.id, fromName: '  AMBIENT "HOME"  ' });
    expect(res).toEqual({ ok: true, fromName: "AMBIENT HOME" });
    const row = await prisma.mailConnection.findUnique({ where: { id: conn.id } });
    expect(row?.displayName).toBe("AMBIENT HOME");
  });

  it("refuses a mailbox from another shop", async () => {
    const conn = await seedMailConnection({ shop: "other.myshopify.com", provider: "zoho", email: "x@y.com" });
    const res = await handleSetFromName({ shop: TEST_SHOP, mailConnectionId: conn.id, fromName: "Hack" });
    expect(res).toEqual({ error: "connection_not_found" });
    const row = await prisma.mailConnection.findUnique({ where: { id: conn.id } });
    expect(row?.displayName ?? null).toBeNull();
  });
});
