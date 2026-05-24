import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import {
  cleanTestShop, TEST_SHOP,
  seedMailConnection, seedThread, seedIncomingEmail,
} from "./helpers/db";
import { getCurrentThreadStates } from "../../dashboard-stats";

describe("multi-mailbox isolation within the same shop", () => {
  beforeEach(async () => {
    await cleanTestShop(TEST_SHOP);
  });

  it("getCurrentThreadStates with mailConnectionId returns only that mailbox's threads", async () => {
    const mcA = await seedMailConnection({ email: "support@brand.com" });
    const mcB = await seedMailConnection({ email: "returns@brand.com" });

    const tA1 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id, operationalState: "open" });
    const tA2 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id, operationalState: "open" });
    const tB1 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id, operationalState: "waiting_customer" });
    const tB2 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id, operationalState: "waiting_customer" });
    const tB3 = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id, operationalState: "waiting_customer" });

    for (const t of [tA1, tA2, tB1, tB2, tB3]) {
      await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: t.mailConnectionId, canonicalThreadId: t.id });
    }

    const all = await getCurrentThreadStates(TEST_SHOP);
    expect(all.open).toBe(2);
    expect(all.waiting_customer).toBe(3);

    const onlyA = await getCurrentThreadStates(TEST_SHOP, mcA.id);
    expect(onlyA.open).toBe(2);
    expect(onlyA.waiting_customer).toBe(0);

    const onlyB = await getCurrentThreadStates(TEST_SHOP, mcB.id);
    expect(onlyB.open).toBe(0);
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
