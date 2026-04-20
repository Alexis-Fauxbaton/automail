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

const GRATITUDE_PATTERNS: RegExp[] = [
  /\bthank you\b/i,
  /\bthanks\b/i,
  /\bthx\b/i,
  /\bmerci\b/i,
  /\bmerci beaucoup\b/i,
  /\bgrand merci\b/i,
  /\bparfait\b/i,
  /\bc'?est bon\b/i,
  /\btop\b/i,
  /\bresolved\b/i,
  /\br[eé]solu\b/i,
];

const ACTION_PATTERNS: RegExp[] = [
  /\?/,
  /\bwhere\b/i,
  /\bwhen\b/i,
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bplease\b/i,
  /\bneed\b/i,
  /\bstatus\b/i,
  /\btracking\b/i,
  /\brefund\b/i,
  /\bhelp\b/i,
  /\bo[uù]\b/i,
  /\bpouvez\b/i,
  /\bmerci de\b/i,
  /\bbesoin\b/i,
  /\bsuivi\b/i,
  /\brembourse\b/i,
  /\baide\b/i,
  /\bprobl[eè]me\b/i,
];

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

  const isGratitudeOrClosure = GRATITUDE_PATTERNS.some((re) => re.test(text));
  const asksForAction = ACTION_PATTERNS.some((re) => re.test(text));

  if (isGratitudeOrClosure && !asksForAction) {
    return {
      noReplyNeeded: true,
      reason: "Client en fin de boucle (remerciement/confirmation sans demande).",
    };
  }

  return { noReplyNeeded: false };
}
