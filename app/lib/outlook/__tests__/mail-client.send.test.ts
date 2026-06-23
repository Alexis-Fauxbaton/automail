import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../auth", () => ({
  getAuthenticatedClientByConnection: vi
    .fn()
    .mockResolvedValue({ accessToken: "test-token" }),
}));

// createOutlookClient imports prisma (db.server) at module load; stub it so the
// import resolves. The send path under test never touches the DB.
vi.mock("../../../db.server", () => ({ default: {} }));

import { createOutlookClient } from "../mail-client";
import type { SendPayload } from "../../mail/types";
import type { MailConnection } from "@prisma/client";

const CONN = { id: "conn-1", shop: "x.myshopify.com" } as unknown as MailConnection;

const BASE_PAYLOAD: SendPayload = {
  rfcMessageId: "out-1@x.myshopify.com",
  references: "",
  fromEmail: "info@ambienthome.fr",
  fromName: "AMBIENT HOME",
  toEmails: ["client@gmail.com"],
  subject: "Re: Question",
  bodyText: "<p>Bonjour</p>",
};

/** Parse the JSON body of a captured fetch call. */
function bodyOf(call: any): any {
  return JSON.parse(call[1].body as string);
}

describe("Outlook send — From display name in the Graph payload", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("standalone-draft path (no original id) sets from.name = payload.fromName", async () => {
    // POST /me/messages -> created draft; POST .../send -> 202; GET -> internetMessageId
    mockFetch.mockImplementation(async (url: string, init: any) => {
      if (url.endsWith("/me/messages") && init.method === "POST") {
        return { ok: true, json: async () => ({ id: "draft-1" }) };
      }
      if (url.endsWith("/draft-1/send")) {
        return { ok: true, text: async () => "" };
      }
      if (url.includes("/draft-1?$select=internetMessageId")) {
        return { ok: true, json: async () => ({ internetMessageId: "<srv-1@outlook.com>" }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const client = await createOutlookClient(CONN);
    // No inReplyToExternalMessageId -> standalone-draft path.
    await client.send(BASE_PAYLOAD);

    const createCall = mockFetch.mock.calls.find(
      (c) => (c[0] as string).endsWith("/me/messages") && c[1].method === "POST",
    );
    expect(createCall).toBeTruthy();
    const draft = bodyOf(createCall);
    expect(draft.from).toEqual({
      emailAddress: { address: "info@ambienthome.fr", name: "AMBIENT HOME" },
    });
  });

  // Characterization test: the normal reply path (createReply) intentionally
  // does NOT send a `from` field — Microsoft applies the mailbox's own
  // configured sender name. This locks in that gap so any future change that
  // starts overriding the From name on replies is a deliberate, reviewed one.
  it("reply path (createReply) does NOT set from — Microsoft controls the sender name", async () => {
    mockFetch.mockImplementation(async (url: string, init: any) => {
      if (url.includes("/createReply")) {
        return { ok: true, json: async () => ({ id: "reply-1" }) };
      }
      if (url.endsWith("/reply-1/send")) {
        return { ok: true, text: async () => "" };
      }
      if (url.includes("/reply-1?$select=internetMessageId")) {
        return { ok: true, json: async () => ({ internetMessageId: "<srv-2@outlook.com>" }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const client = await createOutlookClient(CONN);
    await client.send({ ...BASE_PAYLOAD, inReplyToExternalMessageId: "orig-graph-id" });

    const replyCall = mockFetch.mock.calls.find((c) =>
      (c[0] as string).includes("/createReply"),
    );
    expect(replyCall).toBeTruthy();
    const replyBody = bodyOf(replyCall);
    // The reply body only overrides the message body; no `from` is sent.
    expect(replyBody.message?.from).toBeUndefined();
  });
});
