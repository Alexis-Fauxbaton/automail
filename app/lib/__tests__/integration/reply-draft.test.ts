// Integration tests for reply-draft upsert logic.
// Uses a real Postgres DB, isolated by TEST_SHOP.
//
// REQ-INBOX-07: upsert creates draft if not exists
// REQ-INBOX-08: bodyHistory grows incrementally on each update

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  testDb,
  cleanTestShop,
  createTestThread,
  disconnectTestDb,
  TEST_SHOP,
} from './helpers/db';
import { upsertReplyDraftBody } from '../../support/reply-draft';

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function createTestEmail(threadId: string, externalId: string) {
  return testDb.incomingEmail.create({
    data: {
      shop: TEST_SHOP,
      externalMessageId: externalId,
      canonicalThreadId: threadId,
      fromAddress: 'client@example.com',
      subject: 'Test',
      bodyText: 'Corps',
      receivedAt: new Date(),
      processingStatus: 'analyzed',
    },
  });
}

describe('reply-draft — upsert et historique', () => {
  it('crée un ReplyDraft si inexistant (REQ-INBOX-07)', async () => {
    const thread = await createTestThread();
    const email = await createTestEmail(thread.id, 'draft-test-001');

    await upsertReplyDraftBody(email.id, TEST_SHOP, 'Premier draft');

    const draft = await testDb.replyDraft.findUniqueOrThrow({ where: { emailId: email.id } });
    expect(draft.body).toBe('Premier draft');
    expect(draft.shop).toBe(TEST_SHOP);
    // First creation: bodyHistory starts empty (current body is not historised yet)
    expect(draft.bodyHistory).toEqual([]);
  });

  it('bodyHistory contient les versions précédentes à chaque mise à jour (REQ-INBOX-08)', async () => {
    const thread = await createTestThread();
    const email = await createTestEmail(thread.id, 'draft-test-002');

    await upsertReplyDraftBody(email.id, TEST_SHOP, 'Version 1');
    await upsertReplyDraftBody(email.id, TEST_SHOP, 'Version 2');
    await upsertReplyDraftBody(email.id, TEST_SHOP, 'Version 3');

    const draft = await testDb.replyDraft.findUniqueOrThrow({ where: { emailId: email.id } });
    expect(draft.body).toBe('Version 3');

    // bodyHistory stores previous bodies, not the current one.
    // After V1→V2→V3: history = ['V1', 'V2']
    const history = draft.bodyHistory as string[];
    expect(history).toHaveLength(2);
    expect(history[0]).toBe('Version 1');
    expect(history[1]).toBe('Version 2');
  });

  it('deuxième upsert sur le même email met à jour body sans doublon (REQ-INBOX-07)', async () => {
    const thread = await createTestThread();
    const email = await createTestEmail(thread.id, 'draft-test-003');

    await upsertReplyDraftBody(email.id, TEST_SHOP, 'Brouillon initial');
    await upsertReplyDraftBody(email.id, TEST_SHOP, 'Brouillon révisé');

    // Only one ReplyDraft row should exist
    const count = await testDb.replyDraft.count({ where: { emailId: email.id } });
    expect(count).toBe(1);

    const draft = await testDb.replyDraft.findUniqueOrThrow({ where: { emailId: email.id } });
    expect(draft.body).toBe('Brouillon révisé');
    expect((draft.bodyHistory as string[])).toEqual(['Brouillon initial']);
  });
});
