import { describe, it, expect, beforeEach, afterAll } from "vitest";
import prisma from "../../../db.server";
import { resetTestDb, TEST_SHOP, seedMailConnection, seedThread, seedIncomingEmail, disconnectTestDb } from "./helpers/db";

afterAll(async () => {
  await disconnectTestDb();
});

/** Lazily import releaseStaleSendingDrafts to avoid triggering shopify.server.ts at module load time. */
async function getReleaseFn(): Promise<() => Promise<number>> {
  const mod = await import("../../mail/auto-sync");
  return mod.releaseStaleSendingDrafts;
}

describe("releaseStaleSendingDrafts", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("releases drafts stuck in sendingStartedAt > 5 min ago", async () => {
    const releaseStaleSendingDrafts = await getReleaseFn();
    const conn = await seedMailConnection({ shop: TEST_SHOP, provider: "gmail", email: "s@b.com" });
    const thread = await seedThread({ shop: TEST_SHOP, mailConnectionId: conn.id });
    const incoming = await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: conn.id, canonicalThreadId: thread.id });
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000);
    const draft = await prisma.replyDraft.create({
      data: {
        shop: TEST_SHOP,
        emailId: incoming.id,
        body: "stuck",
        sendingStartedAt: sixMinAgo,
      },
    });

    const released = await releaseStaleSendingDrafts();
    expect(released).toBe(1);

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sendingStartedAt).toBeNull();
    expect(refreshed?.sendError).toBe("send_timeout_released");
    expect(refreshed?.sentAt).toBeNull();
  });

  it("does not release drafts < 5 min old", async () => {
    const releaseStaleSendingDrafts = await getReleaseFn();
    const conn = await seedMailConnection({ shop: TEST_SHOP, provider: "gmail", email: "s2@b.com" });
    const thread = await seedThread({ shop: TEST_SHOP, mailConnectionId: conn.id });
    const incoming = await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: conn.id, canonicalThreadId: thread.id });
    const oneMinAgo = new Date(Date.now() - 60 * 1000);
    const draft = await prisma.replyDraft.create({
      data: {
        shop: TEST_SHOP,
        emailId: incoming.id,
        body: "fresh",
        sendingStartedAt: oneMinAgo,
      },
    });

    const released = await releaseStaleSendingDrafts();
    expect(released).toBe(0);

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sendingStartedAt?.getTime()).toBe(oneMinAgo.getTime());
  });

  it("does not release drafts already sent", async () => {
    const releaseStaleSendingDrafts = await getReleaseFn();
    const conn = await seedMailConnection({ shop: TEST_SHOP, provider: "gmail", email: "s3@b.com" });
    const thread = await seedThread({ shop: TEST_SHOP, mailConnectionId: conn.id });
    const incoming = await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: conn.id, canonicalThreadId: thread.id });
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000);
    const draft = await prisma.replyDraft.create({
      data: {
        shop: TEST_SHOP,
        emailId: incoming.id,
        body: "sent",
        sendingStartedAt: sixMinAgo,
        sentAt: sixMinAgo,
      },
    });

    const released = await releaseStaleSendingDrafts();
    expect(released).toBe(0);

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sendingStartedAt?.getTime()).toBe(sixMinAgo.getTime());
  });
});
