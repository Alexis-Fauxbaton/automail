/** A file attachment or inline image extracted from an incoming email. */
export interface MailAttachment {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Content-ID for inline images (without angle brackets). */
  contentId?: string;
  disposition: "attachment" | "inline";
  /** Base64-encoded data for small files (< 200 KB). Undefined for large files. */
  inlineData?: string;
  /** Provider-specific attachment ID (needed to fetch large files on demand). */
  providerAttachId?: string;
  /** Zoho: folder ID the message lives in (required for attachment download). */
  providerFolderId?: string;
}

/**
 * Provider-agnostic mail message interface.
 * Both Gmail and Zoho clients produce objects conforming to this shape.
 */
export interface MailMessage {
  id: string;
  threadId: string;
  from: string;
  fromName: string;
  subject: string;
  bodyText: string;
  /** Raw HTML body (not sanitized). Undefined when no HTML part is available. */
  bodyHtml?: string;
  snippet: string;
  receivedAt: Date;
  /** Gmail label IDs (e.g. SPAM, CATEGORY_PROMOTIONS). Empty for non-Gmail providers. */
  labelIds: string[];
  /** Lowercase header map (e.g. list-unsubscribe). */
  headers: Record<string, string>;
  /** Attachments and inline images. Empty array when none. */
  attachments: MailAttachment[];
}

/**
 * Input to MailClient.send — fully-assembled message ready to ship.
 * The assembler ensures From, headers, threading, and quote are correct.
 */
export interface SendPayload {
  rfcMessageId: string;       // we generate and set this; provider may rewrite
  inReplyToRfcId: string;     // for threading
  references: string;         // space-separated chain of Message-IDs
  fromEmail: string;
  fromName?: string;
  toEmails: string[];
  ccEmails?: string[];
  subject: string;
  bodyText: string;           // plain text; provider adapter handles transport encoding
}

export interface SendResult {
  externalMessageId: string;  // provider-internal id (Gmail message.id, Outlook id, Zoho messageId)
  rfcMessageId: string;       // may differ from input if provider rewrote
}

export type MailProvider = "gmail" | "zoho" | "outlook";

/**
 * Interface that each mail provider client must implement.
 *
 * ## Error contract (all methods)
 * - **Network/auth errors throw.** Callers should wrap calls in try/catch and
 *   treat any thrown error as transient unless it's a `401`-shaped failure
 *   (in which case the connection should be marked as needing re-auth).
 * - **Empty results do NOT throw.** Methods that return arrays return `[]`
 *   when nothing matches; methods returning a single message throw a clear
 *   `not found` error when the ID does not exist.
 * - **Cursor staleness** (`listNewMessages`): when the cursor is no longer
 *   valid (Gmail history expired, Zoho cursor irrelevant), the method
 *   returns `{ messageIds: [], latestCursor: null }`. Callers must detect
 *   this and fall back to a date-based `listRecentMessages` query.
 * - **Provider absence of feature**: `getSyncCursor()` returns `null` when
 *   the provider has no incremental cursor (Zoho today). Callers MUST handle
 *   `null` and use `listRecentMessages` with `afterDate` instead.
 */
export interface MailClient {
  /**
   * List message IDs received after a given date.
   * @returns array of message IDs (empty if none, never null).
   */
  listRecentMessages(opts: {
    afterDate?: Date;
    maxResults?: number;
  }): Promise<string[]>;

  /**
   * Fetch a single message by ID with full body.
   * @throws when the message ID does not exist or the provider rejects the call.
   */
  getMessage(messageId: string): Promise<MailMessage>;

  /**
   * Incremental sync: return new message IDs since the given cursor.
   * @returns `latestCursor === null` signals the cursor is stale or the
   *          provider does not support cursors — caller should fall back
   *          to a date-based fetch.
   */
  listNewMessages(cursor: string): Promise<{
    messageIds: string[];
    latestCursor: string | null;
  }>;

  /**
   * Get the current sync cursor (e.g. Gmail historyId).
   * @returns `null` when the provider doesn't support cursors (Zoho today).
   */
  getSyncCursor(): Promise<string | null>;

  /**
   * Fetch ALL messages in a thread — inbox AND sent — ordered chronologically.
   * Used to build the full conversation context including outgoing replies.
   * @returns empty array if the threadId is unknown.
   */
  getThreadMessages(threadId: string): Promise<MailMessage[]>;

  /**
   * Send an outbound message via the provider's API.
   * @throws on auth/scope error (caller catches and triggers re-consent flow).
   * @throws on transient errors (caller may retry).
   */
  send(payload: SendPayload): Promise<SendResult>;

  /**
   * Look up a previously-sent message by its RFC822 Message-ID in the Sent
   * folder. Used by retry logic to detect "first attempt actually succeeded
   * but we didn't get the response" cases.
   * @returns null if not found.
   */
  findSentByRfcMessageId(rfcMessageId: string): Promise<SendResult | null>;
}

/**
 * Canonical factory: create a provider-specific MailClient from a MailConnection.
 * All DB access inside the returned client is scoped to `connection.id` —
 * never to `shop` alone — making this safe for multi-mailbox shops.
 *
 * Tokens stored in the DB are encrypted; each provider's auth helper decrypts
 * them before handing them to the SDK.
 */
export async function getMailClient(connection: import("@prisma/client").MailConnection): Promise<MailClient> {
  switch (connection.provider) {
    case "gmail": {
      const { createGmailClient } = await import("../gmail/mail-client");
      return createGmailClient(connection);
    }
    case "outlook": {
      const { createOutlookClient } = await import("../outlook/mail-client");
      return createOutlookClient(connection);
    }
    case "zoho": {
      const { createZohoClient } = await import("../zoho/client");
      return createZohoClient(connection);
    }
    default: {
      const provider: never = connection.provider as never;
      throw new Error(`Unknown mail provider: ${provider}`);
    }
  }
}
