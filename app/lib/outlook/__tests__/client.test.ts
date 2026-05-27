import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../auth", () => ({
  getAuthenticatedClientById: vi.fn().mockResolvedValue({ accessToken: "test-token" }),
}));

import {
  fetchDeltaMessages,
  fetchHistoricalMessages,
  getMessageById,
  getThreadMessages,
  parseGraphMessage,
} from "../client";

const SAMPLE_GRAPH_MSG = {
  id: "msg-001",
  conversationId: "conv-abc",
  subject: "Order #1234 issue",
  receivedDateTime: "2026-05-01T10:00:00Z",
  from: { emailAddress: { name: "Jane Doe", address: "jane@example.com" } },
  body: { contentType: "text" as const, content: "Hello, where is my order?" },
  internetMessageHeaders: [
    { name: "Message-ID", value: "<abc@mail.example.com>" },
    { name: "In-Reply-To", value: "<prev@mail.example.com>" },
  ],
  internetMessageId: "<abc@mail.example.com>",
  categories: [] as string[],
  inferenceClassification: "focused" as const,
  hasAttachments: false,
};

describe("parseGraphMessage", () => {
  it("maps Graph message fields to MailMessage shape", () => {
    const msg = parseGraphMessage(SAMPLE_GRAPH_MSG);
    expect(msg.id).toBe("msg-001");
    expect(msg.threadId).toBe("conv-abc");
    expect(msg.from).toBe("jane@example.com");
    expect(msg.fromName).toBe("Jane Doe");
    expect(msg.subject).toBe("Order #1234 issue");
    expect(msg.bodyText).toBe("Hello, where is my order?");
    expect(msg.receivedAt).toEqual(new Date("2026-05-01T10:00:00Z"));
    expect(msg.labelIds).toEqual([]);
    expect(msg.headers["message-id"]).toBe("<abc@mail.example.com>");
    expect(msg.headers["in-reply-to"]).toBe("<prev@mail.example.com>");
    expect(msg.attachments).toEqual([]);
  });

  it("strips HTML tags and sets bodyText from html body", () => {
    const htmlMsg = {
      ...SAMPLE_GRAPH_MSG,
      body: { contentType: "html" as const, content: "<p>Hello <b>world</b></p>" },
    };
    const msg = parseGraphMessage(htmlMsg);
    expect(msg.bodyText).toContain("Hello world");
    expect(msg.bodyHtml).toBe("<p>Hello <b>world</b></p>");
  });

  it("maps inferenceClassification=other to labelIds=[OUTLOOK_OTHER]", () => {
    const otherMsg = { ...SAMPLE_GRAPH_MSG, inferenceClassification: "other" as const };
    const msg = parseGraphMessage(otherMsg);
    expect(msg.labelIds).toContain("OUTLOOK_OTHER");
  });

  it("maps categories to labelIds", () => {
    const promoMsg = { ...SAMPLE_GRAPH_MSG, categories: ["Promotions"] };
    const msg = parseGraphMessage(promoMsg);
    expect(msg.labelIds).toContain("OUTLOOK_CATEGORY_Promotions");
  });
});

describe("fetchDeltaMessages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns messages and deltaLink on first call (no token)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        value: [SAMPLE_GRAPH_MSG],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=ABC123",
      }),
    });

    const result = await fetchDeltaMessages("conn-test-1", null);
    expect(result.staleDeltaToken).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("msg-001");
    expect(result.nextDeltaLink).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=ABC123",
    );
  });

  it("paginates via @odata.nextLink until @odata.deltaLink appears", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [SAMPLE_GRAPH_MSG],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=page2",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=FINAL",
        }),
      });

    const result = await fetchDeltaMessages("conn-test-1", null);
    expect(result.messages).toHaveLength(1);
    expect(result.nextDeltaLink).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=FINAL",
    );
  });

  it("returns staleDeltaToken=true on 410 Gone", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 410, json: async () => ({}) });

    const result = await fetchDeltaMessages("conn-test-1", "https://graph.microsoft.com/stale");
    expect(result.staleDeltaToken).toBe(true);
    expect(result.messages).toEqual([]);
  });
});

describe("fetchHistoricalMessages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches messages after a given date with pagination", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [SAMPLE_GRAPH_MSG],
          "@odata.nextLink": "https://graph.microsoft.com/next",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

    const afterDate = new Date("2026-04-01T00:00:00Z");
    const messages = await fetchHistoricalMessages("conn-test-1", afterDate);
    expect(messages).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
