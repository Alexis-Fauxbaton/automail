import { data } from "react-router";
import prisma from "../../db.server";

export async function loadOwnedEmail(emailId: string, shop: string) {
  const email = await prisma.incomingEmail.findUnique({ where: { id: emailId } });
  if (!email || email.shop !== shop) {
    throw data({ error: "Not found" }, { status: 404 });
  }
  return email;
}

export async function loadOwnedThread(threadId: string, shop: string) {
  const thread = await prisma.thread.findUnique({ where: { id: threadId } });
  if (!thread || thread.shop !== shop) {
    throw data({ error: "Not found" }, { status: 404 });
  }
  return thread;
}
