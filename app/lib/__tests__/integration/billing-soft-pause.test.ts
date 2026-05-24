import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import { cleanTestShop, TEST_SHOP, seedMailConnection } from "./helpers/db";
import { applySoftPauseIfOverflow } from "../../billing/soft-pause";

describe("soft-pause", () => {
  beforeEach(async () => {
    await cleanTestShop(TEST_SHOP);
  });

  it("pauses all mailboxes when current count > plan limit", async () => {
    await seedMailConnection({ email: "a@b.com" });
    await seedMailConnection({ email: "b@b.com" });
    await seedMailConnection({ email: "c@b.com" });
    const n = await applySoftPauseIfOverflow({ shop: TEST_SHOP, activePlanId: "starter" });
    expect(n).toBe(3);
    const all = await prisma.mailConnection.findMany({ where: { shop: TEST_SHOP } });
    expect(all.every((m) => !m.autoSyncEnabled)).toBe(true);
  });

  it("is idempotent — second call pauses 0", async () => {
    await seedMailConnection({ email: "a@b.com" });
    await seedMailConnection({ email: "b@b.com" });
    await applySoftPauseIfOverflow({ shop: TEST_SHOP, activePlanId: "starter" });
    const n = await applySoftPauseIfOverflow({ shop: TEST_SHOP, activePlanId: "starter" });
    expect(n).toBe(0);
  });

  it("does nothing when count <= plan limit", async () => {
    await seedMailConnection({ email: "a@b.com" });
    const n = await applySoftPauseIfOverflow({ shop: TEST_SHOP, activePlanId: "starter" });
    expect(n).toBe(0);
    const all = await prisma.mailConnection.findMany({ where: { shop: TEST_SHOP } });
    expect(all[0].autoSyncEnabled).toBe(true);
  });
});
