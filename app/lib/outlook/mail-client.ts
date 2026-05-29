import type { MailClient, SendPayload, SendResult } from "../mail/types";
import type { MailConnection } from "@prisma/client";
import {
  fetchDeltaMessages,
  fetchHistoricalMessages,
  getMessageById,
  getThreadMessages,
  getCurrentDeltaLink,
} from "./client";
import { getAuthenticatedClientByConnection } from "./auth";
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

    async send(payload: SendPayload): Promise<SendResult> {
      const { accessToken } = await getAuthenticatedClientByConnection(connection);

      // Step 1: Create a draft. We use the create-draft + send-draft pattern
      // rather than /me/sendMail because sendMail returns 202 No Content —
      // we'd lose the message ID needed for the pre-emptive outgoing insert.
      const draftBody = {
        subject: payload.subject,
        body: { contentType: "text", content: payload.bodyText },
        toRecipients: payload.toEmails.map((e) => ({ emailAddress: { address: e } })),
        ccRecipients: (payload.ccEmails ?? []).map((e) => ({ emailAddress: { address: e } })),
        from: { emailAddress: { address: payload.fromEmail, name: payload.fromName } },
        internetMessageId: `<${payload.rfcMessageId}>`,
        internetMessageHeaders: [
          payload.inReplyToRfcId ? { name: "In-Reply-To", value: `<${payload.inReplyToRfcId}>` } : null,
          payload.references ? { name: "References", value: payload.references } : null,
        ].filter(Boolean) as Array<{ name: string; value: string }>,
      };

      const createRes = await fetch("https://graph.microsoft.com/v1.0/me/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(draftBody),
      });
      if (!createRes.ok) {
        const text = await createRes.text();
        throw new Error(`Outlook create draft failed: ${createRes.status} ${text}`);
      }
      const created = await createRes.json() as { id: string };
      const internalId = created.id;

      // Step 2: Send the draft. Returns 202 Accepted with no body.
      const sendRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${internalId}/send`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (!sendRes.ok) {
        const text = await sendRes.text();
        throw new Error(`Outlook send draft failed: ${sendRes.status} ${text}`);
      }

      // Step 3: Read back the (possibly rewritten) internetMessageId.
      // After send the message moves to Sent Items; the internal id is unchanged.
      let rfcId = payload.rfcMessageId;
      try {
        const readRes = await fetch(
          `https://graph.microsoft.com/v1.0/me/messages/${internalId}?$select=internetMessageId`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (readRes.ok) {
          const data = await readRes.json() as { internetMessageId?: string };
          if (data.internetMessageId) {
            rfcId = data.internetMessageId.replace(/^<|>$/g, "");
          }
        }
      } catch {
        // Best-effort; fall back to our own rfcMessageId.
      }

      return { externalMessageId: internalId, rfcMessageId: rfcId };
    },

    async findSentByRfcMessageId(rfcMessageId: string): Promise<SendResult | null> {
      const { accessToken } = await getAuthenticatedClientByConnection(connection);

      // Graph OData filter on the Sent Items folder by internetMessageId.
      const filter = `internetMessageId eq '<${rfcMessageId}>'`;
      const url =
        `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages` +
        `?$filter=${encodeURIComponent(filter)}&$select=id,internetMessageId&$top=1`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;

      const data = await res.json() as { value?: Array<{ id: string; internetMessageId?: string }> };
      const msg = data.value?.[0];
      if (!msg?.id) return null;

      return { externalMessageId: msg.id, rfcMessageId };
    },
  };
}
