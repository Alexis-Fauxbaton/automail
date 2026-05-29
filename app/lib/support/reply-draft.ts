import prisma from "../../db.server";

/**
 * Upsert a ReplyDraft body for a given email.
 * Appends the previous body to bodyHistory before overwriting.
 * Creates the ReplyDraft record if it doesn't exist yet.
 *
 * Use this for AI-driven changes (regenerate, refine, reanalyze) that should
 * produce a new version. For agent autosave, use updateReplyDraftBody instead.
 */
export async function upsertReplyDraftBody(
  emailId: string,
  shop: string,
  newBody: string,
): Promise<void> {
  // Defence-in-depth: callers verify the email belongs to `shop`, but this
  // function shouldn't trust that — a future refactor could land an
  // unguarded call here. Throw if the email actually belongs to a different
  // shop so we fail loudly instead of silently writing a draft for the
  // wrong tenant.
  const owner = await prisma.incomingEmail.findUnique({
    where: { id: emailId },
    select: { shop: true },
  });
  if (!owner) throw new Error(`upsertReplyDraftBody: email ${emailId} not found`);
  if (owner.shop !== shop) {
    throw new Error(
      `upsertReplyDraftBody: shop mismatch for email ${emailId} (expected ${shop})`,
    );
  }

  const existing = await prisma.replyDraft.findUnique({
    where: { emailId },
    select: { id: true, body: true, bodyHistory: true },
  });

  if (existing) {
    const currentHistory = Array.isArray(existing.bodyHistory)
      ? (existing.bodyHistory as string[])
      : [];
    const updatedHistory = existing.body
      ? [...currentHistory, existing.body]
      : currentHistory;

    await prisma.replyDraft.update({
      where: { emailId },
      data: {
        body: newBody,
        bodyHistory: updatedHistory,
        // Regenerating after a previous send: clear the send state so the
        // new draft is treated as fresh (UI shows it, Send button enabled).
        // The previous send's audit trail lives on the linked IncomingEmail
        // (sourceMarker="sent_from_app") and the bodyHistory still includes
        // the prior body we just appended.
        sentAt: null,
        sentRfcMessageId: null,
        sendError: null,
        sendingStartedAt: null,
        linkedOutgoingEmailId: null,
      },
    });
  } else {
    await prisma.replyDraft.create({
      data: { emailId, shop, body: newBody, bodyHistory: [] },
    });
  }
}

/**
 * Update a ReplyDraft body in place without touching bodyHistory.
 * Use this for agent autosave — repeated edits to the same draft must not
 * spawn new history entries. Creates the ReplyDraft record if absent.
 */
export async function updateReplyDraftBody(
  emailId: string,
  shop: string,
  newBody: string,
): Promise<void> {
  const owner = await prisma.incomingEmail.findUnique({
    where: { id: emailId },
    select: { shop: true },
  });
  if (!owner) throw new Error(`updateReplyDraftBody: email ${emailId} not found`);
  if (owner.shop !== shop) {
    throw new Error(
      `updateReplyDraftBody: shop mismatch for email ${emailId} (expected ${shop})`,
    );
  }
  await prisma.replyDraft.upsert({
    where: { emailId },
    create: { emailId, shop, body: newBody, bodyHistory: [] },
    update: { body: newBody },
  });
}
