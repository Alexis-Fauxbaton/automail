import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
const getMock = vi.fn();

vi.mock("googleapis", () => ({
  google: { gmail: () => ({ users: { messages: { send: sendMock, get: getMock } } }) },
}));
vi.mock("../auth", () => ({
  getAuthenticatedClientByConnection: vi.fn().mockResolvedValue({}),
}));

import { createGmailClient } from "../mail-client";
import type { MailConnection } from "@prisma/client";
import type { SendPayload } from "../../mail/types";

const CONN = { id: "c1" } as unknown as MailConnection;
const PAYLOAD: SendPayload = {
  rfcMessageId: "out@x.com",
  inReplyToRfcId: "orig@x.com",
  references: "<orig@x.com>",
  fromEmail: "s@b.com",
  toEmails: ["c@g.com"],
  subject: "Re: hi",
  bodyText: "<p>hi</p>",
};

describe("Gmail send — threadId", () => {
  beforeEach(() => {
    sendMock.mockReset();
    getMock.mockReset();
    getMock.mockResolvedValue({
      data: { payload: { headers: [{ name: "Message-ID", value: "<srv@x.com>" }] } },
    });
  });

  it("includes threadId when payload.providerThreadId is set", async () => {
    sendMock.mockResolvedValue({ data: { id: "m1" } });
    const client = await createGmailClient(CONN);
    await client.send({ ...PAYLOAD, providerThreadId: "T1" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].requestBody).toMatchObject({ threadId: "T1" });
    expect(sendMock.mock.calls[0][0].requestBody.raw).toBeTruthy();
  });

  it("omits threadId when not provided", async () => {
    sendMock.mockResolvedValue({ data: { id: "m1" } });
    const client = await createGmailClient(CONN);
    await client.send(PAYLOAD);
    expect(sendMock.mock.calls[0][0].requestBody.threadId).toBeUndefined();
  });

  it("retries once WITHOUT threadId when the threadId send fails", async () => {
    sendMock
      .mockRejectedValueOnce(new Error("Gmail 400 invalid threadId"))
      .mockResolvedValueOnce({ data: { id: "m2" } });
    const client = await createGmailClient(CONN);
    const res = await client.send({ ...PAYLOAD, providerThreadId: "BAD" });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][0].requestBody.threadId).toBe("BAD");
    expect(sendMock.mock.calls[1][0].requestBody.threadId).toBeUndefined();
    expect(res.externalMessageId).toBe("m2");
  });
});
