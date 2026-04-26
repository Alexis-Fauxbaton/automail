// tests/e2e/helpers/db.ts
import { PrismaClient } from '@prisma/client';

export const E2E_SHOP = 'e2e-test.myshopify.com';

export const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

/** Cleans E2E test data. Does NOT touch the session row (needed for auth). */
export async function cleanE2EData() {
  await db.$transaction(async (tx) => {
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
      detectedIntent: 'where_is_my_order',
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
