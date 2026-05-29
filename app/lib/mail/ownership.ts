import { data } from "react-router";
import prisma from "../../db.server";

/**
 * Both helpers check shop ownership and throw a 404 on mismatch. They are
 * SHOP-scoped — within the same shop, an emailId belonging to mailbox A
 * is reachable from a call that originated from mailbox B (intentional:
 * the inbox aggregates across mailboxes). If a caller specifically needs
 * to enforce mailbox-level isolation (e.g. a per-mailbox admin endpoint),
 * pass `expectMailConnectionId` so the helper rejects mismatches too.
 */
export async function loadOwnedEmail(
  emailId: string,
  shop: string,
  opts: { expectMailConnectionId?: string } = {},
) {
  const email = await prisma.incomingEmail.findUnique({ where: { id: emailId } });
  if (!email || email.shop !== shop) {
    throw data({ error: "Not found" }, { status: 404 });
  }
  if (opts.expectMailConnectionId && email.mailConnectionId !== opts.expectMailConnectionId) {
    throw data({ error: "Not found" }, { status: 404 });
  }
  return email;
}

export async function loadOwnedThread(
  threadId: string,
  shop: string,
  opts: { expectMailConnectionId?: string } = {},
) {
  const thread = await prisma.thread.findUnique({ where: { id: threadId } });
  if (!thread || thread.shop !== shop) {
    throw data({ error: "Not found" }, { status: 404 });
  }
  if (opts.expectMailConnectionId && thread.mailConnectionId !== opts.expectMailConnectionId) {
    throw data({ error: "Not found" }, { status: 404 });
  }
  return thread;
}
