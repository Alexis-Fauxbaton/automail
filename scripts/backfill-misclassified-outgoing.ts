/**
 * Backfill: re-tag merchant messages misclassified as customer mail.
 *
 * Pre-fix, the `isOutgoing` check could fail for Zoho messages that live
 * in both inbox and sent folders (no SENT label exposed). Those messages
 * were created with `processingStatus = "ingested"` and later demoted to
 * `"classified"` by the per-thread "only keep latest non-outgoing" mass
 * update — never re-checked.
 *
 * The fix in `app/lib/mail/outgoing-detection.ts` prevents future
 * occurrences. This script repairs existing rows: any IncomingEmail with
 * `processingStatus IN ('ingested','classified')` whose `fromAddress`
 * matches the shop's connected mailbox (or any historically-known outgoing
 * alias) is re-tagged to `outgoing`, and the parent canonical Thread state
 * is recomputed once per affected thread.
 *
 * Run:
 *   npx tsx scripts/backfill-misclassified-outgoing.ts
 *   npx tsx scripts/backfill-misclassified-outgoing.ts --shop=2ed20e.myshopify.com
 *   npx tsx scripts/backfill-misclassified-outgoing.ts --dry-run
 */

import prisma from "../app/db.server.js";
import { recomputeThreadState } from "../app/lib/support/thread-state.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const shopArg = argv.find((a) => a.startsWith("--shop="))?.slice("--shop=".length);

const conns = await prisma.mailConnection.findMany({
  where: shopArg ? { shop: shopArg } : {},
  select: { shop: true, email: true },
});

if (conns.length === 0) {
  console.log("No mail connections found.");
  process.exit(0);
}

let grandTotal = 0;
let grandThreads = 0;

for (const conn of conns) {
  if (!conn.email) continue;
  const mailbox = conn.email.toLowerCase();

  // Known-outgoing aliases: every fromAddress that has ever shipped with
  // status=outgoing on this shop. Covers support@/contact@ aliases.
  const aliasRows = await prisma.incomingEmail.findMany({
    where: { shop: conn.shop, processingStatus: "outgoing" },
    select: { fromAddress: true },
    distinct: ["fromAddress"],
  });
  const addresses = new Set<string>([mailbox]);
  for (const r of aliasRows) addresses.add(r.fromAddress.toLowerCase());

  console.log(`\n=== shop=${conn.shop} ===`);
  console.log(`  outgoing addresses considered:`, [...addresses]);

  // Pull candidates: ingested/classified rows whose fromAddress (case-insensitive)
  // is one of the known outgoing addresses.
  const candidates = await prisma.incomingEmail.findMany({
    where: {
      shop: conn.shop,
      processingStatus: { in: ["ingested", "classified"] },
      fromAddress: { in: [...addresses], mode: "insensitive" },
    },
    select: { id: true, canonicalThreadId: true, fromAddress: true, subject: true, receivedAt: true },
  });

  console.log(`  candidates to re-tag: ${candidates.length}`);
  if (candidates.length === 0) continue;

  if (dryRun) {
    for (const c of candidates.slice(0, 5)) {
      console.log(`    [dry] ${c.receivedAt.toISOString()} ${c.fromAddress} :: ${c.subject.slice(0, 60)}`);
    }
    if (candidates.length > 5) console.log(`    [dry] …and ${candidates.length - 5} more`);
    continue;
  }

  const ids = candidates.map((c) => c.id);
  const affectedThreads = [
    ...new Set(candidates.map((c) => c.canonicalThreadId).filter((x): x is string => !!x)),
  ];

  const res = await prisma.incomingEmail.updateMany({
    where: { id: { in: ids } },
    data: { processingStatus: "outgoing" },
  });
  console.log(`  re-tagged: ${res.count}`);
  grandTotal += res.count;

  // Recompute thread state per affected thread so supportNature and
  // operationalState reflect the new outgoing tag.
  for (const tid of affectedThreads) {
    try {
      await recomputeThreadState(tid, { mailboxAddress: mailbox });
      grandThreads++;
    } catch (err) {
      console.error(`  recomputeThreadState failed for thread ${tid}:`, err);
    }
  }
  console.log(`  threads recomputed: ${affectedThreads.length}`);
}

console.log(`\nDone. total emails re-tagged=${grandTotal} threads recomputed=${grandThreads} dryRun=${dryRun}`);
await prisma.$disconnect();
