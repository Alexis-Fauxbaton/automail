import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import { cleanTestShop, TEST_SHOP, seedMailConnection, seedThread } from "./helpers/db";

const TEST_SHOP_B = "integration-test-b.myshopify.com";

describe("cross-shop isolation with multi-mailbox", () => {
  beforeEach(async () => {
    await cleanTestShop(TEST_SHOP);
    await cleanTestShop(TEST_SHOP_B);
  });

  it("different shops can each connect the same email", async () => {
    const mcA = await seedMailConnection({ shop: TEST_SHOP, email: "support@example.com" });
    const mcB = await seedMailConnection({ shop: TEST_SHOP_B, email: "support@example.com" });
    expect(mcA.id).not.toBe(mcB.id);

    const conns = await prisma.mailConnection.findMany({ where: { email: "support@example.com" } });
    expect(conns).toHaveLength(2);
  });

  it("threads of shop A's mailbox are not visible when querying shop B", async () => {
    const mcA = await seedMailConnection({ shop: TEST_SHOP, email: "a@brand.com" });
    const mcB = await seedMailConnection({ shop: TEST_SHOP_B, email: "b@brand.com" });
    await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id });
    await seedThread({ shop: TEST_SHOP_B, mailConnectionId: mcB.id });

    const shopAThreads = await prisma.thread.findMany({ where: { shop: TEST_SHOP } });
    const shopBThreads = await prisma.thread.findMany({ where: { shop: TEST_SHOP_B } });
    expect(shopAThreads).toHaveLength(1);
    expect(shopBThreads).toHaveLength(1);
    expect(shopAThreads[0].mailConnectionId).toBe(mcA.id);
    expect(shopBThreads[0].mailConnectionId).toBe(mcB.id);
  });
});
