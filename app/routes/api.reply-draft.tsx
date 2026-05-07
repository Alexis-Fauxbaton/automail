import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const VALID_REPLY_MODES = ["thread", "new_thread"] as const;

/**
 * CSRF model: this endpoint is only callable from inside the embedded
 * Shopify admin via App Bridge `fetch`. Shopify session-token validation
 * inside `authenticate.admin(request)` rejects any request whose
 * `Authorization: Bearer <token>` header doesn't carry a valid, current
 * JWT signed for THIS app + THIS merchant. The token is per-app +
 * per-merchant + short-lived (≤ 1 min) and cannot be obtained or replayed
 * cross-origin. No additional anti-CSRF token is therefore required.
 * If you ever serve this endpoint outside the embedded admin, revisit.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return data({ error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const shop = session.shop;

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
    const { updateReplyDraftBody } = await import("../lib/support/reply-draft");
    await updateReplyDraftBody(emailId, shop, draftBody);
    if (Object.keys(updateData).length > 0) {
      await prisma.replyDraft.upsert({
        where: { emailId },
        create: { emailId, shop, ...updateData },
        update: updateData,
      });
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
