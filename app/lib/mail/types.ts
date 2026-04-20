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
  snippet: string;
  receivedAt: Date;
  /** Gmail label IDs (e.g. SPAM, CATEGORY_PROMOTIONS). Empty for non-Gmail providers. */
  labelIds: string[];
  /** Lowercase header map (e.g. list-unsubscribe). */
  headers: Record<string, string>;
}

export type MailProvider = "gmail" | "zoho";

/**
 * Interface that each mail provider client must implement.
 */
export interface MailClient {
  /**
   * List message IDs received after a given date.
   */
  listRecentMessages(opts: {
    afterDate?: Date;
    maxResults?: number;
  }): Promise<string[]>;

  /**
   * Fetch a single message by ID with full body.
   */
  getMessage(messageId: string): Promise<MailMessage>;

  /**
   * Incremental sync: return new message IDs since the given cursor.
   * Returns null for latestCursor if the provider doesn't support cursors.
   */
  listNewMessages(cursor: string): Promise<{
    messageIds: string[];
    latestCursor: string | null;
  }>;

  /**
   * Get the current sync cursor (e.g. Gmail historyId).
   * Returns null if the provider doesn't support cursors.
   */
  getSyncCursor(): Promise<string | null>;

  /**
   * Fetch ALL messages in a thread — inbox AND sent — ordered chronologically.
   * Used to build the full conversation context including outgoing replies.
   */
  getThreadMessages(threadId: string): Promise<MailMessage[]>;
}
