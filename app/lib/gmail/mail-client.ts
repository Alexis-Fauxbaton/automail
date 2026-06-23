/**
 * Wraps the existing Gmail functions into the generic MailClient interface.
 */
import type { MailClient, SendPayload, SendResult } from "../mail/types";
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
import { renderRfc822 } from "../mail/assemble-rfc822";

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

    async send(payload: SendPayload): Promise<SendResult> {
      // Build RFC822 raw message in base64url (Gmail requirement).
      const raw = renderRfc822(payload);
      const base64url = Buffer.from(raw, "utf-8").toString("base64url");
      // Pass the original conversation's threadId so the reply lands in the
      // same Gmail thread — headers (In-Reply-To/References) alone do NOT
      // guarantee this; without threadId Gmail starts a new conversation.
      // If Gmail rejects the threadId (e.g. subject mismatch / stale thread),
      // retry once without it so Send still succeeds. A failed send creates no
      // message, so the retry cannot double-send.
      let res;
      if (payload.providerThreadId) {
        try {
          res = await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw: base64url, threadId: payload.providerThreadId },
          });
        } catch (err) {
          console.warn(`[gmail] send with threadId failed, retrying without threadId:`, err);
          res = await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw: base64url },
          });
        }
      } else {
        res = await gmail.users.messages.send({
          userId: "me",
          requestBody: { raw: base64url },
        });
      }
      // Gmail returns { id, threadId, labelIds }. Fetch the message back with
      // metadata so we can read the actual Message-ID header (Gmail may have
      // rewritten ours).
      const sent = await gmail.users.messages.get({
        userId: "me",
        id: res.data.id!,
        format: "metadata",
        metadataHeaders: ["Message-ID"],
      });
      const messageIdHeader =
        sent.data.payload?.headers?.find((h) => h.name === "Message-ID")?.value ??
        `<${payload.rfcMessageId}>`;
      return {
        externalMessageId: res.data.id!,
        // Strip angle brackets if present (RFC 2822 IDs may include them).
        rfcMessageId: messageIdHeader.replace(/^<|>$/g, ""),
      };
    },

    async findSentByRfcMessageId(rfcMessageId: string): Promise<SendResult | null> {
      // Gmail search syntax: rfc822msgid:<id> AND label:sent
      const res = await gmail.users.messages.list({
        userId: "me",
        q: `rfc822msgid:${rfcMessageId} label:sent`,
        maxResults: 1,
      });
      const msg = res.data.messages?.[0];
      if (!msg?.id) return null;
      return { externalMessageId: msg.id, rfcMessageId };
    },
  };
}
