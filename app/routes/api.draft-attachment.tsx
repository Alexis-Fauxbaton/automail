import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../lib/attachments/storage";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  if (request.method === "DELETE") {
    return handleDelete(request, shop);
  }

  if (request.method === "POST") {
    return handleUpload(request, shop);
  }

  return data({ error: "Method not allowed" }, { status: 405 });
}

async function handleUpload(request: Request, shop: string) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return data({ error: "Invalid multipart form data" }, { status: 400 });
  }

  const emailId = formData.get("emailId");
  const file = formData.get("file");

  if (!emailId || typeof emailId !== "string") {
    return data({ error: "emailId is required" }, { status: 400 });
  }
  if (!file || !(file instanceof File)) {
    return data({ error: "file is required" }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return data({ error: "File too large (max 10 MB)" }, { status: 413 });
  }

  // Verify ownership
  const email = await prisma.incomingEmail.findUnique({
    where: { id: emailId },
    select: { shop: true },
  });
  if (!email || email.shop !== shop) {
    return data({ error: "Not found" }, { status: 404 });
  }

  let storagePath: string;
  try {
    ({ storagePath } = await storage.save(shop, emailId, file));
  } catch {
    return data({ error: "File save failed" }, { status: 500 });
  }

  let attachment;
  try {
    // Ensure ReplyDraft exists
    await prisma.replyDraft.upsert({
      where: { emailId },
      create: { emailId, shop },
      update: {},
    });

    const draft = await prisma.replyDraft.findUnique({
      where: { emailId },
      select: { id: true },
    });

    attachment = await prisma.draftAttachment.create({
      data: {
        shop,
        replyDraftId: draft!.id,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        source: "upload",
        storagePath,
      },
    });
  } catch {
    // DB write failed — clean up the file
    await storage.remove(storagePath).catch(() => {});
    return data({ error: "Database error" }, { status: 500 });
  }

  return data({
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    source: attachment.source,
  });
}

async function handleDelete(request: Request, shop: string) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return data({ error: "id is required" }, { status: 400 });

  const attachment = await prisma.draftAttachment.findUnique({
    where: { id },
    select: { id: true, shop: true, storagePath: true, source: true },
  });

  if (!attachment || attachment.shop !== shop) {
    return data({ error: "Not found" }, { status: 404 });
  }

  if (attachment.source === "upload" && attachment.storagePath) {
    await storage.remove(attachment.storagePath);
  }

  await prisma.draftAttachment.delete({ where: { id } });

  return data({ ok: true });
}
