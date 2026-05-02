import type { MailClient } from "../mail/types";
import {
  fetchDeltaMessages,
  fetchHistoricalMessages,
  getMessageById,
  getThreadMessages,
  getCurrentDeltaLink,
} from "./client";
import prisma from "../../db.server";

export async function createOutlookClient(shop: string): Promise<MailClient> {
  return {
    async listRecentMessages(opts) {
      const afterDate = opts.afterDate ?? new Date(Date.now() - 7 * 24 * 3600_000);
      const messages = await fetchHistoricalMessages(shop, afterDate);
      const limit = opts.maxResults ?? 100;
      return messages.slice(0, limit).map((m) => m.id);
    },

    async getMessage(messageId) {
      return getMessageById(shop, messageId);
    },

    async listNewMessages(cursor) {
      const result = await fetchDeltaMessages(shop, cursor);

      if (result.staleDeltaToken) {
        await prisma.mailConnection.update({
          where: { shop },
          data: { deltaToken: null },
        });
        return { messageIds: [], latestCursor: null };
      }

      if (result.nextDeltaLink) {
        await prisma.mailConnection.update({
          where: { shop },
          data: { deltaToken: result.nextDeltaLink },
        });
      }

      return {
        messageIds: result.messages.map((m) => m.id),
        latestCursor: result.nextDeltaLink,
      };
    },

    async getSyncCursor() {
      const conn = await prisma.mailConnection.findUnique({ where: { shop } });
      if (conn?.deltaToken) return conn.deltaToken;
      return getCurrentDeltaLink(shop);
    },

    async getThreadMessages(conversationId) {
      return getThreadMessages(shop, conversationId);
    },
  };
}
