/**
 * Wraps the existing Gmail functions into the generic MailClient interface.
 */
import type { MailClient } from "../mail/types";
import type { MailConnection } from "@prisma/client";
import {
  getMessage,
  listRecentMessages,
  listHistoryChanges,
  getProfile,
  getThreadMessages,
} from "./client";
import { google } from "googleapis";
import { getAuthenticatedClientByConnection } from "./auth";

const GMAIL_REQUEST_TIMEOUT_MS = 15_000;

export async function createGmailClient(connection: MailConnection): Promise<MailClient> {
  const auth = await getAuthenticatedClientByConnection(connection);
  const gmail = google.gmail({ version: "v1", auth, timeout: GMAIL_REQUEST_TIMEOUT_MS });

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

    async getThreadMessages(threadId) {
      return getThreadMessages(gmail, threadId);
    },
  };
}
