import type { MailClient } from "../mail/types";
import type { MailConnection } from "@prisma/client";
import {
  fetchDeltaMessages,
  fetchHistoricalMessages,
  getMessageById,
  getThreadMessages,
  getCurrentDeltaLink,
} from "./client";
import prisma from "../../db.server";

// One day in milliseconds — shared by listRecentMessages default windows
// and any caller computing "X days ago" bounds.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function createOutlookClient(connection: MailConnection): Promise<MailClient> {
  const { id: connectionId } = connection;

  return {
    async listRecentMessages(opts) {
      const afterDate = opts.afterDate ?? new Date(Date.now() - 7 * MS_PER_DAY);
      const messages = await fetchHistoricalMessages(connectionId, afterDate);
      const limit = opts.maxResults ?? 100;
      return messages.slice(0, limit).map((m) => m.id);
    },

    async getMessage(messageId) {
      return getMessageById(connectionId, messageId);
    },

    async listNewMessages(cursor) {
      const result = await fetchDeltaMessages(connectionId, cursor);

      if (result.staleDeltaToken) {
        await prisma.mailConnection.update({
          where: { id: connectionId },
          data: { deltaToken: null },
        });
        return { messageIds: [], latestCursor: null };
      }

      // Explicit `!== null` so an accidental empty-string deltaLink from a
      // provider quirk doesn't get persisted as a non-null token.
      if (result.nextDeltaLink !== null) {
        await prisma.mailConnection.update({
          where: { id: connectionId },
          data: { deltaToken: result.nextDeltaLink },
        });
      }

      return {
        messageIds: result.messages.map((m) => m.id),
        latestCursor: result.nextDeltaLink,
      };
    },

    async getSyncCursor() {
      const conn = await prisma.mailConnection.findUnique({ where: { id: connectionId } });
      // Explicit guard so a deleted-mid-sync row doesn't silently fall
      // through to an extra Graph round-trip.
      if (!conn) return null;
      if (conn.deltaToken) return conn.deltaToken;
      return getCurrentDeltaLink(connectionId);
    },

    async getThreadMessages(conversationId) {
      return getThreadMessages(connectionId, conversationId);
    },
  };
}
