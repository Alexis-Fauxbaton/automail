import { describe, it, expect } from "vitest";
import type { SupportAnalysis } from "../types";
import { buildRefineContext } from "../refine-context";

function baseAnalysis(): SupportAnalysis {
  return {
    intent: "unknown",
    intents: ["unknown"],
    identifiers: {},
    order: null,
    orderCandidates: [],
    trackings: [],
    warnings: [],
    confidence: "low",
    draftReply: "",
    conversation: {
      messageCount: 0,
      incomingCount: 0,
      outgoingCount: 0,
      lastMessageDirection: "incoming",
      noReplyNeeded: false,
    },
  };
}

describe("buildRefineContext", () => {
  it("returns null when nothing useful to summarise", () => {
    expect(buildRefineContext(baseAnalysis())).toBeNull();
  });
});
