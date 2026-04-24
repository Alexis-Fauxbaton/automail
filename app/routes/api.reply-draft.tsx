import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const VALID_REPLY_MODES = ["thread", "new_thread"] as const;

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  if (request.method !== "POST") {
    return data({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json() as {
    emailId?: string;
    subject?: string;
    cc?: string;
    bcc?: string;
    replyMode?: string;
    draftBody?: string;
  };

  const { emailId, subject, cc, bcc, replyMode, draftBody } = body;
  if (!emailId || typeof emailId !== "string") {
    return data({ error: "emailId is required" }, { status: 400 });
  }

  if (replyMode !== undefined && !VALID_REPLY_MODES.includes(replyMode as typeof VALID_REPLY_MODES[number])) {
    return data({ error: "Invalid replyMode" }, { status: 400 });
  }

  // Verify the email belongs to this shop
  const email = await prisma.incomingEmail.findUnique({
    where: { id: emailId },
    select: { shop: true },
  });
  if (!email || email.shop !== shop) {
    return data({ error: "Not found" }, { status: 404 });
  }

  const updateData: Record<string, unknown> = {};
  if (subject !== undefined) updateData.subject = subject;
  if (cc !== undefined) updateData.cc = cc;
  if (bcc !== undefined) updateData.bcc = bcc;
  if (replyMode !== undefined) updateData.replyMode = replyMode;

  if (draftBody !== undefined) {
    const { upsertReplyDraftBody } = await import("../lib/support/reply-draft");
    await upsertReplyDraftBody(emailId, shop, draftBody);
    if (Object.keys(updateData).length > 0) {
      await prisma.replyDraft.update({ where: { emailId }, data: updateData });
    }
  } else {
    await prisma.replyDraft.upsert({
      where: { emailId },
      create: { emailId, shop, ...updateData },
      update: updateData,
    });
  }

  return data({ ok: true });
}
