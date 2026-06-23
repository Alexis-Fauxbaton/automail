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

  it("refuses to update a mailbox when the caller's shop does not match", async () => {
    // Seed in TEST_SHOP only (resetTestDb cleans TEST_SHOP). A caller from a
    // different shop must not be able to touch it. We avoid creating a row in
    // another shop so the test leaves no residue and can't collide with
    // pre-existing data on the shared DB.
    const conn = await seedMailConnection({ shop: TEST_SHOP, provider: "zoho", email: "info@brand.com" });
    const res = await handleSetFromName({ shop: "intruder.myshopify.com", mailConnectionId: conn.id, fromName: "Hack" });
    expect(res).toEqual({ error: "connection_not_found" });
    const row = await prisma.mailConnection.findUnique({ where: { id: conn.id } });
    expect(row?.displayName ?? null).toBeNull();
  });
});
