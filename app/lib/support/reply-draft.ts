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
      data: { body: newBody, bodyHistory: updatedHistory },
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
  await prisma.replyDraft.upsert({
    where: { emailId },
    create: { emailId, shop, body: newBody, bodyHistory: [] },
    update: { body: newBody },
  });
}
