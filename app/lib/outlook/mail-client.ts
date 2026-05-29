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

      // Microsoft Graph rejects standard RFC headers (In-Reply-To, References,
      // Message-ID) in `internetMessageHeaders` — only `X-` prefixed custom
      // headers are allowed. We therefore rely on Outlook's native conversation
      // threading: create the draft via /me/messages/{originalId}/createReply
      // which inherits the original message's `conversationId`. Customer
      // replies then automatically chain back to the same conversation in
      // Outlook, and our sync's incoming-side dedup also picks up the chain.
      //
      // Fallback to a standalone create-draft when the original message is no
      // longer in the merchant's mailbox (404) — threading will degrade but
      // the send still succeeds with subject "Re: …" preserving readability.
      let internalId: string;

      const originalId = payload.inReplyToExternalMessageId;
      if (originalId) {
        const replyRes = await fetch(
          `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(originalId)}/createReply`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            // Microsoft pre-fills `toRecipients` (original sender), `subject`
            // ("RE: …"), and an empty body scaffold. We override the body with
            // our content. Leaving `toRecipients` to Microsoft is intentional —
            // it inherits the canonical sender from the original message.
            body: JSON.stringify({
              message: {
                body: { contentType: "html", content: payload.bodyText },
              },
            }),
          },
        );
        if (replyRes.ok) {
          const draft = await replyRes.json() as { id: string };
          internalId = draft.id;
        } else if (replyRes.status === 404) {
          // Original deleted/archived — fall back to standalone draft.
          internalId = await createStandaloneDraft(accessToken, payload);
        } else {
          const text = await replyRes.text();
          throw new Error(`Outlook createReply failed: ${replyRes.status} ${text}`);
        }
      } else {
        // No original message id available — use the standalone-draft path.
        internalId = await createStandaloneDraft(accessToken, payload);
      }

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

/**
 * Create a standalone (non-threaded) draft via POST /me/messages. Used as a
 * fallback when the original message we'd reply to is no longer in the
 * mailbox (404 from createReply), or when no original id was provided.
 */
async function createStandaloneDraft(
  accessToken: string,
  payload: SendPayload,
): Promise<string> {
  const draftBody = {
    subject: payload.subject,
    body: { contentType: "html", content: payload.bodyText },
    toRecipients: payload.toEmails.map((e) => ({ emailAddress: { address: e } })),
    ccRecipients: (payload.ccEmails ?? []).map((e) => ({ emailAddress: { address: e } })),
    from: { emailAddress: { address: payload.fromEmail, name: payload.fromName } },
  };
  const res = await fetch("https://graph.microsoft.com/v1.0/me/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(draftBody),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Outlook create draft failed: ${res.status} ${text}`);
  }
  const created = await res.json() as { id: string };
  return created.id;
}
