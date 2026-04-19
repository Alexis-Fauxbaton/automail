/**
 * Wraps the existing Gmail functions into the generic MailClient interface.
 */
import type { MailClient } from "../mail/types";
import {
  getGmailService,
  getMessage,
  listRecentMessages,
  listHistoryChanges,
  getProfile,
} from "./client";

export async function createGmailClient(shop: string): Promise<MailClient> {
  const gmail = await getGmailService(shop);

  return {
    async listRecentMessages(opts) {
      return listRecentMessages(gmail, opts);
    },

    async getMessage(messageId) {
      return getMessage(gmail, messageId);
    },

    async listNewMessages(cursor) {
      const result = await listHistoryChanges(gmail, cursor);
      return {
        messageIds: result.messageIds,
        latestCursor: result.latestHistoryId ?? null,
      };
    },

    async getSyncCursor() {
      const profile = await getProfile(gmail);
      return profile.historyId ?? null;
    },
  };
}
