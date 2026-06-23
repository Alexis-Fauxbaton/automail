import { describe, it, expect, beforeEach, vi } from "vitest";
import prisma from "../../../db.server";
import { resetTestDb, TEST_SHOP } from "./helpers/db";
import { handleSendDraft } from "../../support/inbox-actions";
import { seedMailConnection, seedThread, seedIncomingEmail } from "./helpers/db";

vi.mock("../../mail/client-factory", () => ({
  createMailClient: vi.fn(),
}));
import { createMailClient } from "../../mail/client-factory";

describe("handleSendDraft — integration", () => {
  beforeEach(async () => {
    await resetTestDb();
    vi.clearAllMocks();
  });

  it("success path: marks draft sent + creates outgoing IncomingEmail + transitions Thread to waiting_customer", async () => {
    const conn = await seedMailConnection({
      shop: TEST_SHOP,
      provider: "gmail",
      email: "support@brand.com",
      displayName: "AMBIENT HOME",
      grantedScopes: "https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly",
    });
    const thread = await seedThread({ shop: TEST_SHOP, mailConnectionId: conn.id });
    const incoming = await seedIncomingEmail({
      shop: TEST_SHOP,
      mailConnectionId: conn.id,
      canonicalThreadId: thread.id,
      fromAddress: "client@gmail.com",
      subject: "Question",
      rfcMessageId: "orig-1@gmail.com",
      bodyText: "Bonjour",
    });
    const draft = await prisma.replyDraft.create({
      data: { shop: TEST_SHOP, emailId: incoming.id, body: "Bonjour Jean, voici votre suivi." },
    });

    (createMailClient as any).mockResolvedValue({
      send: vi.fn().mockResolvedValue({ externalMessageId: "gmail-internal-123", rfcMessageId: "sent-1@gmail.com" }),
      findSentByRfcMessageId: vi.fn().mockResolvedValue(null),
    });

    const result = await handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id });
    expect(result).toMatchObject({ sent: true });
    expect((result as any).sentAt).toBeInstanceOf(Date);

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sentAt).not.toBeNull();
    expect(refreshed?.sentRfcMessageId).toBeTruthy();
    expect(refreshed?.linkedOutgoingEmailId).toBeTruthy();

    const outgoing = await prisma.incomingEmail.findUnique({ where: { id: refreshed!.linkedOutgoingEmailId! } });
    expect(outgoing?.sourceMarker).toBe("sent_from_app");
    expect(outgoing?.processingStatus).toBe("outgoing");
    expect(outgoing?.canonicalThreadId).toBe(thread.id);
    expect(outgoing?.inReplyTo).toBe("orig-1@gmail.com");
    expect(outgoing?.externalMessageId).toBe("gmail-internal-123");
    // The inbox renders `fromName || fromAddress`; the outgoing row must carry
    // the mailbox display name so the sent message shows "AMBIENT HOME", not
    // the bare address.
    expect(outgoing?.fromName).toBe("AMBIENT HOME");

    const updatedThread = await prisma.thread.findUnique({ where: { id: thread.id } });
    expect(updatedThread?.operationalState).toBe("waiting_customer");

    const history = await prisma.threadStateHistory.findFirst({
      where: { threadId: thread.id, toState: "waiting_customer" },
    });
    expect(history?.reason).toBe("draft_sent");
  });

  it("double-click: second call returns already_sent_or_sending without DB effect", async () => {
    const conn = await seedMailConnection({
      shop: TEST_SHOP,
      provider: "gmail",
      email: "s@b.com",
      grantedScopes: "https://www.googleapis.com/auth/gmail.send",
    });
    const thread = await seedThread({ shop: TEST_SHOP, mailConnectionId: conn.id });
    const incoming = await seedIncomingEmail({
      shop: TEST_SHOP,
      mailConnectionId: conn.id,
      canonicalThreadId: thread.id,
      rfcMessageId: "o@g.com",
    });
    const draft = await prisma.replyDraft.create({ data: { shop: TEST_SHOP, emailId: incoming.id, body: "hi" } });

    let sendCallCount = 0;
    (createMailClient as any).mockResolvedValue({
      send: vi.fn().mockImplementation(async () => {
        sendCallCount++;
        await new Promise((r) => setTimeout(r, 100));
        return { externalMessageId: "id1", rfcMessageId: "sent@g.com" };
      }),
      findSentByRfcMessageId: vi.fn().mockResolvedValue(null),
    });

    const [r1, r2] = await Promise.all([
      handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id }),
      handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id }),
    ]);
    const successes = [r1, r2].filter((r) => "sent" in r && r.sent).length;
    const blocked = [r1, r2].filter((r) => "error" in r && r.error === "already_sent_or_sending").length;
    expect(successes).toBe(1);
    expect(blocked).toBe(1);
    expect(sendCallCount).toBe(1);
  });

  it("scope insufficient: returns needsReauth", async () => {
    const conn = await seedMailConnection({
      shop: TEST_SHOP,
      provider: "gmail",
      email: "s@b.com",
      grantedScopes: "https://www.googleapis.com/auth/gmail.readonly",
    });
    const thread = await seedThread({ shop: TEST_SHOP, mailConnectionId: conn.id });
    const incoming = await seedIncomingEmail({
      shop: TEST_SHOP,
      mailConnectionId: conn.id,
      canonicalThreadId: thread.id,
    });
    const draft = await prisma.replyDraft.create({ data: { shop: TEST_SHOP, emailId: incoming.id, body: "hi" } });

    const result = await handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id });
    expect(result).toMatchObject({ needsReauth: true });
    expect((result as any).reauthUrl).toContain("/app/mail-auth/reauth");

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sendingStartedAt).toBeNull();
    expect(refreshed?.sentAt).toBeNull();
  });

  it("provider throw: releases sendingStartedAt + sets sendError", async () => {
    const conn = await seedMailConnection({
      shop: TEST_SHOP,
      provider: "gmail",
      email: "s@b.com",
      grantedScopes: "https://www.googleapis.com/auth/gmail.send",
    });
    const thread = await seedThread({ shop: TEST_SHOP, mailConnectionId: conn.id });
    const incoming = await seedIncomingEmail({
      shop: TEST_SHOP,
      mailConnectionId: conn.id,
      canonicalThreadId: thread.id,
    });
    const draft = await prisma.replyDraft.create({ data: { shop: TEST_SHOP, emailId: incoming.id, body: "hi" } });

    (createMailClient as any).mockResolvedValue({
      send: vi.fn().mockRejectedValue(new Error("Gmail 500 Internal Server Error")),
      findSentByRfcMessageId: vi.fn().mockResolvedValue(null),
    });

    const result = await handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id });
    expect(result).toMatchObject({ error: expect.stringContaining("send_failed") });

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sendingStartedAt).toBeNull();
    expect(refreshed?.sentAt).toBeNull();
    expect(refreshed?.sendError).toContain("Gmail 500");

    const outgoingCount = await prisma.incomingEmail.count({ where: { shop: TEST_SHOP, sourceMarker: "sent_from_app" } });
    expect(outgoingCount).toBe(0);
  });

  it("SEND_DISABLED_FOR_INTERNAL=true + isInternal shop: fake send runs without provider call", async () => {
    process.env.SEND_DISABLED_FOR_INTERNAL = "true";
    try {
      await prisma.shopFlag.upsert({
        where: { shop: TEST_SHOP },
        create: { shop: TEST_SHOP, isInternal: true, firstInstallDate: new Date(), onboardingCompletedAt: new Date() },
        update: { isInternal: true },
      });
      // grant ONLY read scope — bypass should ignore canSend
      const conn = await seedMailConnection({
        shop: TEST_SHOP,
        provider: "gmail",
        email: "s@b.com",
        grantedScopes: "https://www.googleapis.com/auth/gmail.readonly",
      });
      const thread = await seedThread({ shop: TEST_SHOP, mailConnectionId: conn.id });
      const incoming = await seedIncomingEmail({ shop: TEST_SHOP, mailConnectionId: conn.id, canonicalThreadId: thread.id });
      const draft = await prisma.replyDraft.create({ data: { shop: TEST_SHOP, emailId: incoming.id, body: "hi" } });

      const sendSpy = vi.fn();
      (createMailClient as any).mockResolvedValue({ send: sendSpy, findSentByRfcMessageId: vi.fn() });

      const result = await handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id });
      expect(result).toMatchObject({ sent: true });
      expect(sendSpy).not.toHaveBeenCalled(); // bypass: no provider call

      const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
      expect(refreshed?.sentRfcMessageId).toMatch(/@/);

      const outgoing = await prisma.incomingEmail.findFirst({ where: { sourceMarker: "sent_from_app", shop: TEST_SHOP } });
      expect(outgoing?.externalMessageId).toContain("fake-internal-");
    } finally {
      delete process.env.SEND_DISABLED_FOR_INTERNAL;
    }
  });

  it("retry after timeout: findSentByRfcMessageId hit, marks sent without double-send", async () => {
    const conn = await seedMailConnection({
      shop: TEST_SHOP,
      provider: "gmail",
      email: "s@b.com",
      grantedScopes: "https://www.googleapis.com/auth/gmail.send",
    });
    const thread = await seedThread({ shop: TEST_SHOP, mailConnectionId: conn.id });
    const incoming = await seedIncomingEmail({
      shop: TEST_SHOP,
      mailConnectionId: conn.id,
      canonicalThreadId: thread.id,
    });
    const draft = await prisma.replyDraft.create({
      data: {
        shop: TEST_SHOP,
        emailId: incoming.id,
        body: "hi",
        sendError: "send_timeout_released",
      },
    });

    const sendSpy = vi.fn().mockResolvedValue({ externalMessageId: "should-not-be-called", rfcMessageId: "x" });
    (createMailClient as any).mockResolvedValue({
      send: sendSpy,
      findSentByRfcMessageId: vi.fn().mockResolvedValue({ externalMessageId: "gmail-id-from-previous-attempt", rfcMessageId: "previously-sent@g.com" }),
    });

    const result = await handleSendDraft({ shop: TEST_SHOP, mailConnectionId: conn.id, draftId: draft.id });
    expect(result).toMatchObject({ sent: true });
    expect(sendSpy).not.toHaveBeenCalled();

    const refreshed = await prisma.replyDraft.findUnique({ where: { id: draft.id } });
    expect(refreshed?.sentRfcMessageId).toBe("previously-sent@g.com");
  });
});
