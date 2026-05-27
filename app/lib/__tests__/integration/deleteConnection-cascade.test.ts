import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../../../db.server";
import { cleanTestShop, TEST_SHOP, seedMailConnection, seedThread, seedIncomingEmail } from "./helpers/db";
import { deleteConnection } from "../../gmail/auth";

describe("deleteConnection cascade", () => {
  beforeEach(async () => {
    await cleanTestShop(TEST_SHOP);
    await cleanTestShop("other.myshopify.com");
  });

  it("deletes the MailConnection and cascades to Thread + IncomingEmail of that mailbox only", async () => {
    const mcA = await seedMailConnection({ email: "a@brand.com" });
    const mcB = await seedMailConnection({ email: "b@brand.com" });

    const tA = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcA.id });
    const tB = await seedThread({ shop: TEST_SHOP, mailConnectionId: mcB.id });
    await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: mcA.id, canonicalThreadId: tA.id });
    await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: mcB.id, canonicalThreadId: tB.id });

    await deleteConnection({ shop: TEST_SHOP, mailConnectionId: mcA.id });

    expect(await prisma.mailConnection.count({ where: { id: mcA.id } })).toBe(0);
    expect(await prisma.thread.count({ where: { mailConnectionId: mcA.id } })).toBe(0);
    expect(await prisma.incomingEmail.count({ where: { mailConnectionId: mcA.id } })).toBe(0);

    expect(await prisma.mailConnection.count({ where: { id: mcB.id } })).toBe(1);
    expect(await prisma.thread.count({ where: { mailConnectionId: mcB.id } })).toBe(1);
    expect(await prisma.incomingEmail.count({ where: { mailConnectionId: mcB.id } })).toBe(1);
  });

  it("refuses to delete a MailConnection that belongs to another shop", async () => {
    const mcOther = await seedMailConnection({ shop: "other.myshopify.com", email: "x@y.com" });
    await expect(
      deleteConnection({ shop: TEST_SHOP, mailConnectionId: mcOther.id }),
    ).rejects.toThrow();
    expect(await prisma.mailConnection.count({ where: { id: mcOther.id } })).toBe(1);
  });
});
