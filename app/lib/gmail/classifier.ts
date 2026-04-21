import { getOpenAIClient, trackedChatCompletion, type TrackedCallContext } from "../llm/client";
import type { StructuredThreadState } from "../support/thread-state";

export type EmailClassification =
  | "support_client"
  | "probable_non_client"
  | "incertain";

const SYSTEM_PROMPT = `You classify incoming emails for an e-commerce customer support inbox.

Classify the email as ONE of:
- support_client: a real customer writing to ask about their order, delivery, product, return, refund, complaint, or any support question. The email is FROM a customer TO the store.
- probable_non_client: anything else, including:
  - B2B inquiries, supplier emails, marketing pitches, partnership/collaboration requests, recruitment
  - automated notifications and system emails (order placed, shipping confirmation, payment received, etc.)
  - internal emails or notifications FROM the store's own system TO the store owner
  - emails ABOUT orders that are clearly notifications, not requests (e.g. "Order #123 placed by John" is a notification, not a customer asking for help)
- incertain: cannot determine with confidence

Key distinction: a CUSTOMER writes "where is my order #123?" = support_client. The STORE's system sends "Order #123 has been placed" = probable_non_client.

If a THREAD STATE block is provided, use it as a strong prior:
  - a thread already confirmed_support stays support unless the new message is clearly off-topic spam;
  - a thread with only outgoing messages (merchant replies) and no new customer signal is not a new support request by itself.
Stay conservative — when unsure, answer incertain.

Reply with JSON only: {"classification":"..."}`;

export interface ClassifyContext extends Partial<TrackedCallContext> {
  /** Compact structured thread state (spec §6, §8). */
  threadState?: StructuredThreadState | null;
  /** Body of the true-latest message when different from the one being classified. */
  trueLatestBody?: string;
  /** Whether an agent (merchant) has already replied in this thread. */
  agentHasReplied?: boolean;
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function renderThreadStateCompact(s: StructuredThreadState): string {
  return [
    `messages=${s.messageCount}(in=${s.incomingCount},out=${s.outgoingCount})`,
    `nature=${s.supportNature}`,
    `opState=${s.operationalState}`,
    `orderResolved=${s.orderResolved}`,
    `trackingResolved=${s.trackingResolved}`,
    `lastDirection=${s.lastDirection}`,
  ].join(" | ");
}

export async function classifyEmail(
  subject: string,
  body: string,
  ctx: ClassifyContext = {},
): Promise<EmailClassification> {
  const client = getOpenAIClient();
  if (!client) return "incertain";

  try {
    const truncatedBody = truncate(body, 600);

    const parts: string[] = [];
    if (ctx.threadState && ctx.threadState.messageCount > 1) {
      parts.push("--- THREAD STATE (compact) ---");
      parts.push(renderThreadStateCompact(ctx.threadState));
      if (ctx.agentHasReplied) parts.push("agent_has_replied=true");
      parts.push("");
    }
    if (
      ctx.trueLatestBody &&
      ctx.trueLatestBody.trim() &&
      ctx.trueLatestBody !== body
    ) {
      parts.push("--- TRUE LATEST MESSAGE (any direction) ---");
      parts.push(truncate(ctx.trueLatestBody, 300));
      parts.push("");
    }
    parts.push("--- MESSAGE TO CLASSIFY ---");
    parts.push(`Subject: ${subject}`);
    parts.push("");
    parts.push("Body:");
    parts.push(truncatedBody);

    const response = await trackedChatCompletion(
      client,
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: parts.join("\n") },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 30,
      },
      { callSite: "classifier", ...ctx },
    );

    const raw = response.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as { classification?: string };

    const valid: EmailClassification[] = [
      "support_client",
      "probable_non_client",
      "incertain",
    ];
    if (valid.includes(parsed.classification as EmailClassification)) {
      return parsed.classification as EmailClassification;
    }
    return "incertain";
  } catch (err) {
    console.error("[gmail/classifier] LLM classification failed:", err);
    return "incertain";
  }
}
