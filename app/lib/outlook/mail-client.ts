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

export async function createOutlookClient(connection: MailConnection): Promise<MailClient> {
  const { id: connectionId, shop } = connection;

  return {
    async listRecentMessages(opts) {
      const afterDate = opts.afterDate ?? new Date(Date.now() - 7 * 24 * 3600_000);
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

      if (result.nextDeltaLink) {
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
      if (conn?.deltaToken) return conn.deltaToken;
      return getCurrentDeltaLink(connectionId);
    },

    async getThreadMessages(conversationId) {
      return getThreadMessages(connectionId, conversationId);
    },
  };
}
