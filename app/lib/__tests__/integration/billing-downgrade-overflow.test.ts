import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import { cleanTestShop, TEST_SHOP, seedMailConnection } from "./helpers/db";
import { computeOverflowForPlanSwitch, resolveOverflowImmediate } from "../../billing/downgrade-overflow";

describe("downgrade-overflow", () => {
  beforeEach(async () => {
    await cleanTestShop(TEST_SHOP);
    await cleanTestShop("other.myshopify.com");
  });

  it("returns hasOverflow=false when current = target", async () => {
    await seedMailConnection({ email: "a@b.com" });
    const r = await computeOverflowForPlanSwitch({ shop: TEST_SHOP, targetPlanId: "starter" });
    expect(r.hasOverflow).toBe(false);
    expect(r.toDisconnect).toBe(0);
  });

  it("returns hasOverflow=true when downgrading Pro(3) → Starter(1) with 3 mailboxes", async () => {
    await seedMailConnection({ email: "a@b.com" });
    await seedMailConnection({ email: "b@b.com" });
    await seedMailConnection({ email: "c@b.com" });
    const r = await computeOverflowForPlanSwitch({ shop: TEST_SHOP, targetPlanId: "starter" });
    expect(r.hasOverflow).toBe(true);
    expect(r.toDisconnect).toBe(2);
    expect(r.targetLimit).toBe(1);
    expect(r.currentCount).toBe(3);
  });

  it("resolveOverflowImmediate deletes all but the kept mailbox", async () => {
    const a = await seedMailConnection({ email: "a@b.com" });
    const b = await seedMailConnection({ email: "b@b.com" });
    const c = await seedMailConnection({ email: "c@b.com" });
    await resolveOverflowImmediate({
      shop: TEST_SHOP,
      keepMailConnectionId: b.id,
      targetPlanId: "starter",
    });
    const remaining = await prisma.mailConnection.findMany({ where: { shop: TEST_SHOP } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(b.id);
    // Silence unused variable warnings
    void a;
    void c;
  });

  it("resolveOverflowImmediate refuses to keep a mailbox from another shop", async () => {
    // Seed 2 mailboxes for TEST_SHOP so there's overflow when targeting starter (limit=1)
    await seedMailConnection({ email: "a@b.com" });
    await seedMailConnection({ email: "b@b.com" });
    const other = await seedMailConnection({ shop: "other.myshopify.com", email: "x@y.com" });
    await expect(
      resolveOverflowImmediate({
        shop: TEST_SHOP,
        keepMailConnectionId: other.id,
        targetPlanId: "starter",
      }),
    ).rejects.toThrow(/not found/);
  });
});
