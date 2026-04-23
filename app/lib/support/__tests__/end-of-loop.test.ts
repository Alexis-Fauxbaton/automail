import { describe, it, expect } from "vitest";
import { detectEndOfLoop } from "../end-of-loop";

describe("detectEndOfLoop", () => {
  it("returns false when only 1 incoming message (first reply always needed)", () => {
    const result = detectEndOfLoop({
      latestMessageBody: "thank you!",
      incomingCount: 1,
      lastMessageDirection: "incoming",
    });
    expect(result.noReplyNeeded).toBe(false);
  });

  it("returns false when last message is outgoing (we already replied)", () => {
    const result = detectEndOfLoop({
      latestMessageBody: "thanks",
      incomingCount: 2,
      lastMessageDirection: "outgoing",
    });
    expect(result.noReplyNeeded).toBe(false);
  });

  it("detects gratitude-only message as end of loop", () => {
    const result = detectEndOfLoop({
      latestMessageBody: "Thank you so much!",
      incomingCount: 2,
      lastMessageDirection: "incoming",
    });
    expect(result.noReplyNeeded).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it("detects French 'merci' as end of loop", () => {
    const result = detectEndOfLoop({
      latestMessageBody: "Merci beaucoup",
      incomingCount: 2,
      lastMessageDirection: "incoming",
    });
    expect(result.noReplyNeeded).toBe(true);
  });

  it("detects 'parfait' as end of loop", () => {
    const result = detectEndOfLoop({
      latestMessageBody: "Parfait, merci!",
      incomingCount: 2,
      lastMessageDirection: "incoming",
    });
    expect(result.noReplyNeeded).toBe(true);
  });

  it("returns false when gratitude + question present", () => {
    const result = detectEndOfLoop({
      latestMessageBody: "Thanks! But where is my refund?",
      incomingCount: 2,
      lastMessageDirection: "incoming",
    });
    expect(result.noReplyNeeded).toBe(false);
  });

  it("returns false when gratitude + 'please' present", () => {
    const result = detectEndOfLoop({
      latestMessageBody: "Thanks, please update me",
      incomingCount: 2,
      lastMessageDirection: "incoming",
    });
    expect(result.noReplyNeeded).toBe(false);
  });

  it("returns false when message has no gratitude", () => {
    const result = detectEndOfLoop({
      latestMessageBody: "Any update on my order?",
      incomingCount: 2,
      lastMessageDirection: "incoming",
    });
    expect(result.noReplyNeeded).toBe(false);
  });

  it("returns false for empty message body", () => {
    const result = detectEndOfLoop({
      latestMessageBody: "   ",
      incomingCount: 2,
      lastMessageDirection: "incoming",
    });
    expect(result.noReplyNeeded).toBe(false);
  });

  it("detects 'resolved' as end of loop", () => {
    const result = detectEndOfLoop({
      latestMessageBody: "Issue resolved, thanks",
      incomingCount: 2,
      lastMessageDirection: "incoming",
    });
    expect(result.noReplyNeeded).toBe(true);
  });
});
