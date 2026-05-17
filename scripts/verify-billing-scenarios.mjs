// Verification script: exercises resolveEntitlements + markThreadAnalyzedIfFirst
// across every billing scenario and prints a tabular report.
//
// SAFE: runs against the dev DB but uses a dedicated test shop and cleans up.
// DOES NOT touch the user's real dev shop (2ed20e.myshopify.com).
//
// Usage: node scripts/verify-billing-scenarios.mjs

import { PrismaClient } from "@prisma/client";

const VERIFY_SHOP = "verify-billing.myshopify.com";

const prisma = new PrismaClient();

// We bypass the Shopify Billing API by stubbing resolveActivePlan.
// To exercise the real paid path, we set `state` on a flag-like record
// — but here we just call the helpers directly and assert outputs.

async function cleanup() {
  await prisma.thread.deleteMany({ where: { shop: VERIFY_SHOP } });
  await prisma.billingUsage.deleteMany({ where: { shop: VERIFY_SHOP } });
  await prisma.shopFlag.deleteMany({ where: { shop: VERIFY_SHOP } });
}

function periodStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function seedShop({ usage, installDaysAgo = 1, internal = false }) {
  await cleanup();
  const firstInstallDate = new Date(Date.now() - installDaysAgo * 24 * 3600 * 1000);
  await prisma.shopFlag.create({
    data: {
      shop: VERIFY_SHOP,
      isInternal: internal,
      firstInstallDate,
    },
  });
  if (usage > 0) {
    await prisma.billingUsage.create({
      data: {
        shop: VERIFY_SHOP,
        periodStart: periodStart(),
        analyzedThreadsCount: usage,
      },
    });
  }
}

async function createThread() {
  return prisma.thread.create({
    data: {
      shop: VERIFY_SHOP,
      provider: "gmail",
      firstMessageAt: new Date(),
      lastMessageAt: new Date(),
      operationalState: "open",
      supportNature: "unknown",
      historyStatus: "complete",
    },
  });
}

// Import after PrismaClient is up to ensure same DB connection
const { resolveEntitlements } = await import("../app/lib/billing/entitlements.ts");
const { markThreadAnalyzedIfFirst, getUsage } = await import("../app/lib/billing/usage.ts");

// Stub admin (entitlements only uses it for resolveActivePlan; we'll bypass with a stub that returns "none")
const stubAdmin = { graphql: async () => ({ json: async () => ({ data: { currentAppInstallation: { activeSubscriptions: [] } } }) }) };

const rows = [];

function record(label, ent, extras = {}) {
  rows.push({
    scenario: label,
    state: ent.state,
    planId: ent.planId,
    limit: ent.quotaStatus.limit === Infinity ? "∞" : ent.quotaStatus.limit,
    used: ent.quotaStatus.used,
    level: ent.quotaStatus.level,
    canGenerate: ent.canGenerateDraft,
    suspended: ent.isSyncSuspended,
    trialDays: ent.trialDaysRemaining,
    ...extras,
  });
}

async function run() {
  try {
    // ---- Trial scenarios (no subscription) ----
    await seedShop({ usage: 0, installDaysAgo: 1, internal: false });
    record("Trial day 1, 0 usage", await resolveEntitlements({ shop: VERIFY_SHOP, admin: stubAdmin }));

    await seedShop({ usage: 5, installDaysAgo: 7, internal: false });
    record("Trial day 7, 5 usage", await resolveEntitlements({ shop: VERIFY_SHOP, admin: stubAdmin }));

    await seedShop({ usage: 20, installDaysAgo: 13, internal: false });
    record("Trial day 13, 20 usage", await resolveEntitlements({ shop: VERIFY_SHOP, admin: stubAdmin }));

    await seedShop({ usage: 100, installDaysAgo: 15, internal: false });
    record("Trial expired (day 15)", await resolveEntitlements({ shop: VERIFY_SHOP, admin: stubAdmin }));

    // ---- Internal bypass ----
    await seedShop({ usage: 999, installDaysAgo: 100, internal: true });
    record("Internal flag, day 100, 999 usage", await resolveEntitlements({ shop: VERIFY_SHOP, admin: stubAdmin }));

    // ---- markThreadAnalyzedIfFirst behavior ----
    await seedShop({ usage: 0, installDaysAgo: 1, internal: false });
    const t1 = await createThread();
    const r1 = await markThreadAnalyzedIfFirst(t1.id, VERIFY_SHOP);
    const r2 = await markThreadAnalyzedIfFirst(t1.id, VERIFY_SHOP);
    const u = await getUsage(VERIFY_SHOP);
    console.log("\nIdempotency check (markThreadAnalyzedIfFirst):");
    console.log(`  1st call: counted=${r1.counted} alreadyAnalyzed=${r1.alreadyAnalyzed}`);
    console.log(`  2nd call: counted=${r2.counted} alreadyAnalyzed=${r2.alreadyAnalyzed}`);
    console.log(`  Usage after 2 calls: ${u.count} (expected 1)`);

    // ---- Concurrent racing ----
    await seedShop({ usage: 0, installDaysAgo: 1, internal: false });
    const t2 = await createThread();
    const races = await Promise.all(Array.from({ length: 20 }, () => markThreadAnalyzedIfFirst(t2.id, VERIFY_SHOP)));
    const counted = races.filter(r => r.counted).length;
    const u2 = await getUsage(VERIFY_SHOP);
    console.log(`\nConcurrent race check (20 parallel calls):`);
    console.log(`  counted=${counted} (expected 1)`);
    console.log(`  usage=${u2.count} (expected 1)`);

    // ---- Cross-shop isolation ----
    const OTHER = "verify-other.myshopify.com";
    await prisma.thread.deleteMany({ where: { shop: OTHER } });
    await prisma.billingUsage.deleteMany({ where: { shop: OTHER } });
    await prisma.shopFlag.deleteMany({ where: { shop: OTHER } });
    await prisma.shopFlag.create({ data: { shop: OTHER, firstInstallDate: new Date() } });
    const tOther = await prisma.thread.create({
      data: { shop: OTHER, provider: "gmail", firstMessageAt: new Date(), lastMessageAt: new Date(), operationalState: "open", supportNature: "unknown", historyStatus: "complete" },
    });
    await markThreadAnalyzedIfFirst(tOther.id, OTHER);
    const wrong = await markThreadAnalyzedIfFirst(tOther.id, VERIFY_SHOP);
    console.log(`\nCross-shop isolation:`);
    console.log(`  shop mismatch counted=${wrong.counted} (expected false)`);
    await prisma.thread.deleteMany({ where: { shop: OTHER } });
    await prisma.billingUsage.deleteMany({ where: { shop: OTHER } });
    await prisma.shopFlag.deleteMany({ where: { shop: OTHER } });

    // Print scenario table
    console.log("\n=== Entitlement scenarios ===");
    console.table(rows);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
