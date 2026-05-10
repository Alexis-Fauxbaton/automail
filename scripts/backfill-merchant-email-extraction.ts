/**
 * Backfill: clear merchant-email extracted as customer email.
 *
 * Pre-fix, llmParseEmail could pick up the merchant's own mailbox address
 * (e.g. info@ambienthome.fr) as the customer email when the body contained
 * a quoted reply chain ("On <date>, MERCHANT <support@store.com> wrote:").
 *
 * The fix at llm-parser.ts excludes the merchant address going forward, but
 * existing IncomingEmail.analysisResult blobs still contain the wrong value.
 * This script reads each row, parses analysisResult, and clears identifiers.email
 * when it matches MailConnection.email for the shop. It also nulls
 * Thread.resolvedEmail if it matches the merchant address.
 *
 * Run via:
 *   npx tsx scripts/backfill-merchant-email-extraction.ts
 *   npx tsx scripts/backfill-merchant-email-extraction.ts --shop=2ed20e.myshopify.com
 *   npx tsx scripts/backfill-merchant-email-extraction.ts --dry-run
 */

import prisma from "../app/db.server.js";

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

let totalEmailsScanned = 0;
let totalEmailsFixed = 0;
let totalThreadsFixed = 0;

for (const conn of conns) {
  if (!conn.email) continue;
  const merchantEmail = conn.email.toLowerCase();

  console.log(`\n=== shop=${conn.shop} merchant=${merchantEmail} ===`);

  const emails = await prisma.incomingEmail.findMany({
    where: {
      shop: conn.shop,
      analysisResult: { not: null },
    },
    select: { id: true, analysisResult: true },
  });

  let shopEmailsFixed = 0;
  for (const row of emails) {
    totalEmailsScanned++;
    if (!row.analysisResult) continue;
    let parsed: { identifiers?: { email?: string | null } } | null = null;
    try {
      parsed = JSON.parse(row.analysisResult);
    } catch {
      continue;
    }
    const extractedEmail = parsed?.identifiers?.email;
    if (
      extractedEmail &&
      extractedEmail.toLowerCase() === merchantEmail &&
      parsed?.identifiers
    ) {
      parsed.identifiers.email = null;
      if (!dryRun) {
        await prisma.incomingEmail.update({
          where: { id: row.id },
          data: { analysisResult: JSON.stringify(parsed) },
        });
      }
      shopEmailsFixed++;
      totalEmailsFixed++;
    }
  }

  // Thread.resolvedEmail equal to the merchant address is also wrong.
  const threadResult = dryRun
    ? await prisma.thread.count({
        where: {
          shop: conn.shop,
          resolvedEmail: { equals: merchantEmail, mode: "insensitive" },
        },
      })
    : (
        await prisma.thread.updateMany({
          where: {
            shop: conn.shop,
            resolvedEmail: { equals: merchantEmail, mode: "insensitive" },
          },
          data: {
            resolvedEmail: null,
            resolutionConfidence: "none",
          },
        })
      ).count;

  console.log(
    `  emails scanned=${emails.length} fixed=${shopEmailsFixed}` +
      `  threads fixed=${threadResult}` +
      (dryRun ? "  [DRY RUN]" : ""),
  );
  totalThreadsFixed += threadResult;
}

console.log(
  `\nTotals: scanned=${totalEmailsScanned} emails_fixed=${totalEmailsFixed} threads_fixed=${totalThreadsFixed}` +
    (dryRun ? "  [DRY RUN — no writes]" : ""),
);

await prisma.$disconnect();
