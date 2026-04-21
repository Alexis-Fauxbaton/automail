/**
 * LLM-based draft reply generator.
 *
 * The LLM receives verified facts + settings and produces a ready-to-send draft.
 * Language is locked for the ENTIRE reply (body + closing + signature area) —
 * no mixing allowed. Falls back to templates if the API is unavailable.
 */

import { getOpenAIClient, trackedChatCompletion, type TrackedCallContext } from "../llm/client";
import { buildDraft as templateFallback } from "./response-draft";
import type { CrawledContext } from "./crawl/context-crawler";
import type { SupportSettings } from "./settings";
import type {
  ConversationMessage,
  FulfillmentTrackingFacts,
  OrderFacts,
  ParsedEmail,
  SupportIntent,
  Warning,
} from "./types";

function buildSystemPrompt(settings: SupportSettings): string {
  const toneMap: Record<string, string> = {
    friendly: "Warm, human and empathetic. Conversational but professional.",
    formal: "Formal and professional. No contractions, no colloquial expressions.",
    neutral: "Neutral, clear and professional. Neither overly warm nor cold.",
  };
  const tone = toneMap[settings.tone] ?? toneMap.friendly;

  // Language rule — this is the core of the fix.
  // "auto" means: detect from the email, then lock that language for the whole reply.
  const langRule =
    settings.language === "fr"
      ? `LANGUAGE RULE: Reply in French. Every single word — greeting, body, closing phrase, and signature area — must be in French. No English words anywhere.`
      : settings.language === "en"
        ? `LANGUAGE RULE: Reply in English. Every single word — greeting, body, closing phrase, and signature area — must be in English. No French words anywhere.`
        : `LANGUAGE RULE: Read the customer's email and decide: is it written in French or English?
Once you have decided, use ONLY that language for the ENTIRE reply — greeting, body, closing phrase, and signature area.
Do NOT mix languages. If the preferred closing phrase below is in the wrong language, translate it.`;

  const signatureName = settings.signatureName || "Customer Support";
  const brandLine = settings.brandName ? `\n${settings.brandName}` : "";

  // The closing phrase is the user's preference. We tell the LLM to translate it
  // if it doesn't match the detected/configured language.
  const closingNote = settings.closingPhrase
    ? `Preferred closing phrase: "${settings.closingPhrase}" — translate it to match the reply language if needed.`
    : `Use a closing appropriate for the chosen language and tone (e.g. "Cordialement," for French formal, "Belle journée," for French friendly, "Kind regards," for English formal, "Best regards," for English friendly).`;

  const greetingStyleMap: Record<string, string> = {
    auto: `Address the customer using your best judgment:
- If the customer name is clearly a person's first name, use it (e.g. "Bonjour Karine,").
- If the name is a company name or ambiguous (e.g. "GIBSEN SARL", "K. Ruby"), do NOT use it — use a neutral greeting instead ("Bonjour," or "Hello,").
- If the gender is not clearly inferrable from the name, use the first name only without any title (never assume "M." or "Mme").`,
    first_name: `Always use only the customer's first name in the greeting (e.g. "Bonjour Karine,"). If no first name is available or the name looks like a company, use a neutral greeting.`,
    full_name: `Use the customer's full name in the greeting (e.g. "Bonjour Karine Ruby,"). If no name is available or the name looks like a company, use a neutral greeting.`,
    neutral: `Never use the customer's name. Always use a neutral greeting ("Bonjour," or "Hello,").`,
  };
  const greetingRule =
    greetingStyleMap[settings.customerGreetingStyle ?? "auto"] ??
    greetingStyleMap.auto;

  return `You are a customer support agent drafting replies for an e-commerce store.

## Tone
${tone}

## Customer greeting
${greetingRule}

## ${langRule}

## Signature block
End every reply with this exact block. The closing phrase MUST be in the reply language:
<closing phrase here>
${signatureName}${brandLine}

${closingNote}

## Strict data rules
- NEVER invent order numbers, dates, amounts, tracking numbers, carrier names or delivery statuses.
- NEVER claim a parcel is lost unless the tracking data explicitly says so.
- NEVER claim a refund was issued unless order data confirms it.
- NEVER promise a specific outcome you cannot guarantee.
- If multiple orders matched, acknowledge the ambiguity and ask the customer to confirm.
- Be concise. No unnecessary filler.
- NEVER mention the contents of the package (product names, item descriptions) in the reply.
- NEVER tell the customer to "contact us" by email or phone — you ARE already replying to them. Handle their request directly or ask follow-up questions inline.

## Draft cleanliness — critical
- NEVER mention internal system failures, data retrieval issues, API errors, or any technical limitation. The customer must not know about internal operations.
- NEVER write phrases like "we were unable to retrieve real-time tracking", "our system could not fetch the data", "the tracking requires manual verification due to a technical issue", or any equivalent.
- If tracking data is partial or inferred, share what you know and offer to help further — without explaining the technical reason for the gap.
- If live tracking context is available, use it naturally without citing its source.

## Output
Plain text only. No subject line, no markdown, no JSON.`;
}

function buildUserMessage(
  parsed: ParsedEmail,
  intent: SupportIntent,
  order: OrderFacts | null,
  orderCandidates: OrderFacts[],
  trackings: FulfillmentTrackingFacts[],
  crawledContexts: CrawledContext[],
  warnings: Warning[],
  shareTrackingNumber: boolean,
  refundPolicy: string,
  conversationMessages?: ConversationMessage[],
): string {
  const sections: string[] = [];

  if (conversationMessages && conversationMessages.length > 1) {
    // Multi-message thread: render each message explicitly
    sections.push("## Conversation history (full thread, chronological order)");
    sections.push(`Subject: ${parsed.subject}`);
    for (const msg of conversationMessages) {
      const label =
        msg.direction === "outgoing"
          ? "[YOUR REPLY — outgoing]"
          : "[CUSTOMER — incoming]";
      const latestMarker = msg.isLatest ? " ← LATEST MESSAGE" : "";
      sections.push(
        [
          `--- ${label}${latestMarker} ---`,
          `Date: ${msg.receivedAt}`,
          `From: ${msg.fromAddress}`,
          `Body:\n${msg.body}`,
        ].join("\n"),
      );
    }
    sections.push(
      "IMPORTANT — the draft reply MUST take into account the ENTIRE conversation above. " +
      "Apply all extracted identifiers (order number, tracking, customer name…) to any message in the thread, not just the latest one.",
    );
  } else {
    // Single email
    sections.push("## Customer email");
    sections.push(`Subject: ${parsed.subject}`);
    sections.push(`Body:\n${parsed.body}`);
  }

  sections.push("## Detected intent");
  sections.push(intent);

  if (order) {
    sections.push("## Verified order facts (Shopify — do not alter)");
    sections.push(`Order: ${order.name}`);
    sections.push(`Created: ${order.createdAt}`);
    if (order.customerName) sections.push(`Customer name: ${order.customerName}`);
    if (order.customerEmail) sections.push(`Customer email: ${order.customerEmail}`);
    if (order.displayFulfillmentStatus)
      sections.push(`Fulfillment status: ${order.displayFulfillmentStatus}`);
    if (order.displayFinancialStatus)
      sections.push(`Financial status: ${order.displayFinancialStatus}`);
    if (orderCandidates.length > 1)
      sections.push(
        `⚠ Ambiguity: ${orderCandidates.length} orders matched. Show the above order but acknowledge the ambiguity and ask the customer to confirm.`,
      );
  } else {
    sections.push("## Order lookup result");
    sections.push("No matching order was found in Shopify.");
  }

  // Tracking: one block per fulfillment that has data
  const shippedTrackings = trackings.filter((t) => t.source !== "none");
  if (shippedTrackings.length > 0) {
    const plural = shippedTrackings.length > 1;
    sections.push(`## Tracking facts${plural ? ` (${shippedTrackings.length} shipments)` : ""}`);

    for (const t of shippedTrackings) {
      const label = plural ? `### Shipment ${t.fulfillmentIndex + 1}` : null;
      if (label) sections.push(label);

      // Items in this shipment
      if (t.lineItems.length > 0) {
        sections.push(
          `Items: ${t.lineItems.map((li) => `${li.quantity}× ${li.title}`).join(", ")}`,
        );
      }

      sections.push(
        `Source: ${t.source}${t.inferred ? " (INFERRED — not verified by carrier API)" : ""}`,
      );
      if (t.carrier) sections.push(`Carrier: ${t.carrier}`);

      if (shareTrackingNumber) {
        if (t.trackingNumber) sections.push(`Tracking number: ${t.trackingNumber}`);
        if (t.trackingUrl) sections.push(`Tracking URL: ${t.trackingUrl}`);
      } else {
        sections.push(
          "TRACKING NUMBER RULE: Do NOT mention the tracking number or tracking URL in the reply. The merchant has chosen not to share it.",
        );
      }

      if (t.status) sections.push(`Status: ${t.status}`);
      if (t.lastEvent) sections.push(`Last event: ${t.lastEvent}`);
      if (t.lastLocation) sections.push(`Last location: ${t.lastLocation}`);
      if (t.lastEventDate) sections.push(`Last event date: ${t.lastEventDate}`);
      if (t.delivered) sections.push(`Delivered: yes`);
    }
  } else if (trackings.length === 0 && !order) {
    // No order means no tracking context to show
  } else if (order && order.fulfillments.length === 0) {
    sections.push("## Tracking facts");
    sections.push("No fulfillment yet — the order has not been shipped.");
  }

  if (refundPolicy && intent === "refund_request") {
    sections.push("## Shop refund & return policy");
    sections.push(refundPolicy);
    sections.push(
      "IMPORTANT — apply this policy with judgment:\n" +
      "- Read the customer's situation carefully before applying any rule from the policy.\n" +
      "- If the situation doesn't fit the standard policy (e.g. the package has not been received yet, " +
      "so a 'return' window hasn't started), acknowledge what applies instead and explain the next steps.\n" +
      "- You are already replying to the customer — do NOT redirect them to 'contact us by email'. Handle the request here.\n" +
      "- If you need specific information (e.g. photos, reason), ask for it directly in this reply.",
    );
  }

  if (crawledContexts.length > 0) {
    sections.push("## Live context from external sources");
    for (const ctx of crawledContexts) {
      sections.push(`### ${ctx.purpose} (from ${ctx.url})`);
      sections.push(ctx.extractedText);
    }
  }

  if (warnings.length > 0) {
    sections.push("## Warnings — take into account");
    for (const w of warnings) sections.push(`- [${w.code}] ${w.message}`);
  }

  return sections.join("\n\n");
}

export interface LLMDraftInput {
  parsed: ParsedEmail;
  intent: SupportIntent;
  order: OrderFacts | null;
  orderCandidates: OrderFacts[];
  trackings: FulfillmentTrackingFacts[];
  crawledContexts: CrawledContext[];
  warnings: Warning[];
  settings: SupportSettings;
  /** Full ordered conversation messages (oldest first). When provided and >1, the full thread history is injected into the prompt. */
  conversationMessages?: ConversationMessage[];
  /** Optional tracking context for LLM cost logging. */
  trackedCallContext?: Partial<TrackedCallContext>;
}

export async function generateLLMDraft(input: LLMDraftInput): Promise<string> {
  const client = getOpenAIClient();
  const shareTracking = input.settings.shareTrackingNumber ?? true;
  const primaryTracking = (shareTracking ? input.trackings[0] : null) ?? null;

  if (!client) {
    return templateFallback({
      intent: input.intent,
      order: input.order,
      orderCandidates: input.orderCandidates,
      trackings: input.trackings,
      confidence: "low",
      warnings: input.warnings,
      identifiers: {},
      conversation: {
        messageCount: 1,
        incomingCount: 1,
        outgoingCount: 0,
        lastMessageDirection: "incoming",
        noReplyNeeded: false,
      },
      settings: input.settings,
      parsed: input.parsed,
    });
  }

  try {
    const response = await trackedChatCompletion(
      client,
      {
        model: "gpt-4o",
        messages: [
          { role: "system", content: buildSystemPrompt(input.settings) },
          {
            role: "user",
            content: buildUserMessage(
              input.parsed,
              input.intent,
              input.order,
              input.orderCandidates,
              input.trackings,
              input.crawledContexts,
              input.warnings,
              shareTracking,
              input.settings.refundPolicy ?? "",
              input.conversationMessages,
            ),
          },
        ],
        temperature: 0.3,
        max_tokens: 600,
      },
      { callSite: "llm-draft", ...input.trackedCallContext },
    );

    const draft = response.choices[0]?.message?.content?.trim() ?? "";
    if (!draft) throw new Error("Empty response from OpenAI");
    return draft;
  } catch (err) {
    console.error("[llm-draft] OpenAI call failed, using template fallback:", err);
    return templateFallback({
      intent: input.intent,
      order: input.order,
      orderCandidates: input.orderCandidates,
      trackings: input.trackings,
      confidence: "low",
      warnings: input.warnings,
      identifiers: {},
      conversation: {
        messageCount: 1,
        incomingCount: 1,
        outgoingCount: 0,
        lastMessageDirection: "incoming",
        noReplyNeeded: false,
      },
      settings: input.settings,
      parsed: input.parsed,
    });
  }
}
