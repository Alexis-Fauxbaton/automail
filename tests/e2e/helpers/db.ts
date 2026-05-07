// tests/e2e/helpers/db.ts
import { PrismaClient } from '@prisma/client';

if (!process.env.E2E_DATABASE_URL) {
  throw new Error("E2E_DATABASE_URL must be set for E2E tests. Never point at DATABASE_URL directly.");
}
if (process.env.E2E_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error("E2E_DATABASE_URL must be a separate database from DATABASE_URL");
}

export const E2E_SHOP = 'e2e-test.myshopify.com';

export const db = new PrismaClient({
  datasources: { db: { url: process.env.E2E_DATABASE_URL } },
});

/** Cleans E2E test data. Does NOT touch the session row (needed for auth). */
export async function cleanE2EData() {
  await db.$transaction(async (tx) => {
    await tx.mailConnection.deleteMany({ where: { shop: E2E_SHOP } });
    await tx.llmCallLog.deleteMany({ where: { shop: E2E_SHOP } });
    await tx.draftAttachment.deleteMany({ where: { shop: E2E_SHOP } });
    await tx.replyDraft.deleteMany({ where: { shop: E2E_SHOP } });
    await tx.incomingEmail.deleteMany({ where: { shop: E2E_SHOP } });
    await tx.threadStateHistory.deleteMany({ where: { shop: E2E_SHOP } });
    await tx.threadProviderId.deleteMany({ where: { shop: E2E_SHOP } });
    await tx.thread.deleteMany({ where: { shop: E2E_SHOP } });
    await tx.syncJob.deleteMany({ where: { shop: E2E_SHOP } });
  });
}

export async function seedSupportThread(overrides: Partial<{
  operationalState: string;
  supportNature: string;
  subject: string;
  body: string;
  draftBody: string;
  orderNumber: string;
  intents: string[];
}> = {}) {
  const thread = await db.thread.create({
    data: {
      shop: E2E_SHOP,
      provider: 'gmail',
      lastMessageAt: new Date(),
      firstMessageAt: new Date(),
      operationalStateUpdatedAt: new Date(),
      operationalState: overrides.operationalState ?? 'waiting_merchant',
      supportNature: overrides.supportNature ?? 'confirmed_support',
      historyStatus: 'complete',
      resolvedOrderNumber: overrides.orderNumber ?? '#TEST-001',
      resolutionConfidence: 'high',
    },
  });

  const intents = overrides.intents ?? ['where_is_my_order'];
  const email = await db.incomingEmail.create({
    data: {
      shop: E2E_SHOP,
      externalMessageId: `e2e-${Date.now()}`,
      canonicalThreadId: thread.id,
      fromAddress: 'client-e2e@example.com',
      subject: overrides.subject ?? 'Où est ma commande #TEST-001 ?',
      bodyText: overrides.body ?? "Bonjour, je n'ai pas reçu ma commande TEST-001.",
      receivedAt: new Date(),
      processingStatus: 'analyzed',
      tier1Result: 'passed',
      tier2Result: 'support_client',
      detectedIntent: intents[0],
      // analysisResult drives the intent pills in the inbox row (see
      // app.inbox.tsx ~1832: pills come from analysisResult.intents).
      // Stored as a JSON-encoded string per the schema (String?, // JSON blob).
      // Shape must match SupportAnalysis (app/lib/support/types.ts).
      analysisResult: JSON.stringify({
        intent: intents[0],
        intents,
        identifiers: {
          orderNumber: overrides.orderNumber ?? 'TEST-001',
          trackingNumber: null,
        },
        order: null,
        orderCandidates: [],
        trackings: [],
        confidence: 'high',
        warnings: [],
        draftReply: '',
        conversation: {
          messageCount: 1,
          incomingCount: 1,
          outgoingCount: 0,
          lastMessageDirection: 'incoming',
          noReplyNeeded: false,
        },
      }),
      analysisConfidence: 'high',
    },
  });

  if (overrides.draftBody) {
    await db.replyDraft.create({
      data: {
        shop: E2E_SHOP,
        emailId: email.id,
        body: overrides.draftBody,
        bodyHistory: [],
        subject: `Re: ${overrides.subject ?? 'Où est ma commande ?'}`,
      },
    });
  }

  return { thread, email };
}

/**
 * Seed a Gmail MailConnection so the inbox loader's `if (connection) { fetch
 * emails }` branch is taken in e2e tests. Token strings are intentionally
 * fake — getConnection() doesn't decrypt them and we never call out to
 * Google in the layout-capture flow.
 */
export async function seedMailConnection(shop: string = E2E_SHOP) {
  return db.mailConnection.upsert({
    where: { shop },
    update: {},
    create: {
      shop,
      provider: 'gmail',
      email: 'support@e2e-test.example',
      accessToken: 'e2e-fake-access-token',
      refreshToken: 'e2e-fake-refresh-token',
      tokenExpiry: new Date(Date.now() + 60 * 60 * 1000), // 1h from now
    },
  });
}
