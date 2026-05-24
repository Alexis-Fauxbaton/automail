// One-off script to reprocess the orphan IncomingEmail row created by the
// resolveCanonicalThread race condition. Steps:
//   1. Look up the orphan row (canonicalThreadId IS NULL)
//   2. Delete the orphan + its reply draft + draft attachments + LLM logs
//   3. Re-fetch the message from the provider
//   4. Re-ingest it via ingestAndPrefilter (now race-safe)
//   5. Leave processingStatus = "ingested" so the next sync (or manual
//      "Generate draft") triggers a clean tier2/tier3 classification.

import prisma from "../app/db.server.js";
import { getMailClient, ingestAndPrefilter } from "../app/lib/gmail/pipeline.js";

const ORPHAN_ID = process.argv[2] ?? "cmovjufso000k784ozkxj94p6";

const orphan = await prisma.incomingEmail.findUnique({
  where: { id: ORPHAN_ID },
  select: {
    id: true,
    shop: true,
    externalMessageId: true,
    canonicalThreadId: true,
    subject: true,
    fromAddress: true,
    processingStatus: true,
  },
});

if (!orphan) {
  console.error("Orphan not found:", ORPHAN_ID);
  process.exit(1);
}

console.log("Orphan row:");
console.log(JSON.stringify(orphan, null, 2));

if (orphan.canonicalThreadId) {
  console.error("Row already has a canonicalThreadId — refusing to reprocess.");
  process.exit(1);
}

const conn = await prisma.mailConnection.findFirst({
  where: { shop: orphan.shop },
});
if (!conn) {
  console.error("No MailConnection for shop:", orphan.shop);
  process.exit(1);
}

console.log(`\nReprocessing message ${orphan.externalMessageId} for shop ${orphan.shop} (provider=${conn.provider})...`);

// Step 1: clean up dependent rows. DraftAttachment is keyed by
// replyDraftId, so resolve that first.
const replyDraft = await prisma.replyDraft.findUnique({
  where: { emailId: ORPHAN_ID },
  select: { id: true },
});
const cleanup = await prisma.$transaction([
  ...(replyDraft
    ? [prisma.draftAttachment.deleteMany({ where: { replyDraftId: replyDraft.id } })]
    : []),
  prisma.replyDraft.deleteMany({ where: { emailId: ORPHAN_ID } }),
  prisma.llmCallLog.deleteMany({ where: { emailId: ORPHAN_ID } }),
  prisma.incomingEmail.delete({ where: { id: ORPHAN_ID } }),
]);
console.log(`Cleanup: ${cleanup.map((c, i) => `step${i}=${"count" in c ? c.count : "ok"}`).join(" ")}`);

// Step 2: rebuild what ingestAndPrefilter expects.
// Customer email allow-list is not persisted in DB — it normally comes from
// `fetchCustomerEmails(admin, shop)` which needs a Shopify admin client.
// For this one-off reprocess we pass an empty set: the prefilter loses the
// "is known customer" hint, but tier1 can still pass on subject/body alone
// and tier2 will run on the next regular sync.
const customerEmails = new Set<string>();

const client = await getMailClient(conn);

const report = {
  fetched: 0,
  filtered: 0,
  classified: 0,
  drafts: 0,
  errors: 0,
  skipped: 0,
  cancelled: false,
};

await ingestAndPrefilter(
  orphan.shop,
  conn.provider,
  client,
  orphan.externalMessageId,
  customerEmails,
  { mailboxAddress: conn.email ?? "", knownOutgoingAddresses: new Set<string>() },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  report as any,
  conn.id,
);

// Step 3: verify
const fresh = await prisma.incomingEmail.findFirst({
  where: { shop: orphan.shop, externalMessageId: orphan.externalMessageId },
  select: {
    id: true,
    canonicalThreadId: true,
    threadId: true,
    fromAddress: true,
    subject: true,
    tier1Result: true,
    tier2Result: true,
    processingStatus: true,
  },
});

console.log("\nReprocessed row:");
console.log(JSON.stringify(fresh, null, 2));

if (fresh?.canonicalThreadId) {
  const t = await prisma.thread.findUnique({
    where: { id: fresh.canonicalThreadId },
    select: { id: true, supportNature: true, operationalState: true },
  });
  console.log("Thread:", JSON.stringify(t, null, 2));
}

await prisma.$disconnect();
