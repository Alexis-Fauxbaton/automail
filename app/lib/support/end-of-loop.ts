import type { MessageDirection } from "./types";

export interface EndOfLoopInput {
  latestMessageBody: string;
  incomingCount: number;
  lastMessageDirection: MessageDirection;
}

export interface EndOfLoopResult {
  noReplyNeeded: boolean;
  reason?: string;
}

// Single combined alternation regex per category — running 20+ separate
// regexes via .some(.test) with backtracking is wasteful on long bodies.
const GRATITUDE_RE =
  /\b(?:thank\s+you|thanks|thx|merci(?:\s+beaucoup)?|grand\s+merci|parfait|c'?est\s+bon|top|resolved|r[eé]solu)\b/i;

const ACTION_RE =
  /\?|\b(?:where|when|can\s+you|could\s+you|please|need|status|tracking|refund|help|o[uù]|pouvez|merci\s+de|besoin|suivi|rembourse|aide|probl[eè]me)\b/i;

export function detectEndOfLoop(input: EndOfLoopInput): EndOfLoopResult {
  if (input.incomingCount <= 1) {
    return { noReplyNeeded: false };
  }

  if (input.lastMessageDirection !== "incoming") {
    return { noReplyNeeded: false };
  }

  const text = input.latestMessageBody.trim();
  if (!text) {
    return { noReplyNeeded: false };
  }

  const isGratitudeOrClosure = GRATITUDE_RE.test(text);
  const asksForAction = ACTION_RE.test(text);

  if (isGratitudeOrClosure && !asksForAction) {
    return {
      noReplyNeeded: true,
      reason: "Client en fin de boucle (remerciement/confirmation sans demande).",
    };
  }

  return { noReplyNeeded: false };
}
