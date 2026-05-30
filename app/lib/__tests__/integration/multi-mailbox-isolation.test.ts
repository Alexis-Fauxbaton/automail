import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import {
  cleanTestShop, TEST_SHOP,
  seedMailConnection, seedThread, seedIncomingEmail,
} from "./helpers/db";
import { getInboxBucketCounts } from "../../dashboard-stats";
import prismaClient from "../../../db.server";

describe("multi-mailbox isolation within the same shop", () => {
  beforeEach(async () => {
    await cleanTestShop(TEST_SHOP);
  });

  it("getInboxBucketCounts with mailConnectionId returns only that mailbox's threads", async () => {
    const mcA = await seedMailConnection({ email: "support@brand.com" });
    const mcB = await seedMailConnection({ email: "returns@brand.com" });

    // 2 threads on A (waiting_customer), 3 on B (waiting_customer). Set
    // analyzedAt so threads fall through the 'to_analyze' gate and land
    // on the operationalState branches (the bucket logic we want to test).
    const now = new Date();
    const tA1 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id, operationalState: "waiting_customer" });
    const tA2 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id, operationalState: "waiting_customer" });
    const tB1 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id, operationalState: "waiting_customer" });
    const tB2 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id, operationalState: "waiting_customer" });
    const tB3 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id, operationalState: "waiting_customer" });
    await prismaClient.thread.updateMany({
      where: { id: { in: [tA1.id, tA2.id, tB1.id, tB2.id, tB3.id] } },
      data: { analyzedAt: now },
    });

    for (const t of [tA1, tA2, tB1, tB2, tB3]) {
      await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: t.mailConnectionId, canonicalThreadId: t.id });
    }

    const all = await getInboxBucketCounts(TEST_SHOP);
    expect(all.waiting_customer).toBe(5);

    const onlyA = await getInboxBucketCounts(TEST_SHOP, mcA.id);
    expect(onlyA.waiting_customer).toBe(2);

    const onlyB = await getInboxBucketCounts(TEST_SHOP, mcB.id);
    expect(onlyB.waiting_customer).toBe(3);
  });

  it("inbox thread query with mailConnectionId returns only that mailbox's threads", async () => {
    const mcA = await seedMailConnection({ email: "support@brand.com" });
    const mcB = await seedMailConnection({ email: "returns@brand.com" });

    const tA = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id });
    await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id });

    const onlyA = await prisma.thread.findMany({
      where: { shop: TEST_SHOP, mailConnectionId: mcA.id },
    });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].id).toBe(tA.id);
  });

  it("Email count by mailbox does not leak across mailboxes", async () => {
    const mcA = await seedMailConnection({ email: "support@brand.com" });
    const mcB = await seedMailConnection({ email: "returns@brand.com" });

    const tA = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id });
    const tB = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id });
    await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: mcA.id, canonicalThreadId: tA.id });
    await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: mcA.id, canonicalThreadId: tA.id });
    await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: mcB.id, canonicalThreadId: tB.id });

    const countA = await prisma.incomingEmail.count({ where: { shop: TEST_SHOP, mailConnectionId: mcA.id } });
    const countB = await prisma.incomingEmail.count({ where: { shop: TEST_SHOP, mailConnectionId: mcB.id } });
    expect(countA).toBe(2);
    expect(countB).toBe(1);
  });
});
