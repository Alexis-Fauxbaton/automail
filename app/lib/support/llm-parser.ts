/**
 * LLM-based email parser.
 * Uses gpt-4o-mini to extract identifiers and classify intent in one shot.
 * Falls back to the regex modules if the API call fails or returns unusable data.
 */

import { getOpenAIClient, trackedChatCompletion, type TrackedCallContext } from "../llm/client";
import { SUPPORT_INTENTS, type ExtractedIdentifiers, type ParsedEmail, type SupportIntent } from "./types";
import { extractIdentifiers } from "./identifier-extractor";
import { classifyIntent, classifyIntents } from "./intent-classifier";

const VALID_INTENTS: readonly SupportIntent[] = SUPPORT_INTENTS;

const SYSTEM_PROMPT = `You are an assistant that extracts structured data from customer support emails for an e-commerce store.

Given an email subject and body, return a JSON object with this exact shape:
{
  "intent": one primary intent, one of: "where_is_my_order" | "delivery_delay" | "marked_delivered_not_received" | "damaged_product" | "order_error" | "refund_request" | "pre_purchase_question" | "unknown",
  "intents": array of all matching intents, ordered from most important to least important. Use ["unknown"] only if no support intent applies,
  "orderNumber": string or null,   // digits only, no # sign, e.g. "1002"
  "email": string or null,         // customer email address if present
  "customerName": string or null,  // full name of the customer if clearly stated
  "trackingNumber": string or null // tracking number if present
}

Intent definitions:
- where_is_my_order: customer wants to know where their parcel is or its tracking status
- delivery_delay: customer complains the delivery is late
- marked_delivered_not_received: carrier says delivered but customer hasn't received it
- damaged_product: customer says an item/product arrived damaged, broken, or unusable
- order_error: customer reports a wrong item, wrong size/color, missing item, or another order preparation mistake
- delivery_delay also covers parcels whose tracking has not updated in a while or appears stuck
- refund_request: customer explicitly asks for a refund or reimbursement
- pre_purchase_question: customer asks a question before buying or placing an order
- unknown: none of the above clearly applies

Rules:
- Extract only what is explicitly written. Never guess or invent data.
- For orderNumber: extract digits only (e.g. "#1002" → "1002", "commande 1002" → "1002")
- Return valid JSON only. No explanation, no markdown, just the JSON object.`;

export interface LLMParseResult {
  intent: SupportIntent;
  intents: SupportIntent[];
  identifiers: ExtractedIdentifiers;
  usedLLM: boolean;
}

export async function llmParseEmail(
  parsed: ParsedEmail,
  ctx?: Partial<TrackedCallContext>,
): Promise<LLMParseResult> {
  const client = getOpenAIClient();

  if (!client) {
    // No API key configured — fall back silently to regex.
    return {
      intent: classifyIntent(parsed),
      intents: classifyIntents(parsed),
      identifiers: extractIdentifiers(parsed),
      usedLLM: false,
    };
  }

  try {
    // Cap input size to bound LLM cost. Anything past 30 KB is almost certainly
    // quoted history or a malicious payload — the parser only needs the visible
    // text to extract identifiers and intent.
    const MAX_BODY_BYTES = 30_000;
    const truncatedBody =
      parsed.body.length > MAX_BODY_BYTES
        ? parsed.body.slice(0, MAX_BODY_BYTES) + "\n\n[... body truncated for analysis]"
        : parsed.body;
    const userMessage = `Subject: ${parsed.subject.slice(0, 500)}\n\nBody:\n${truncatedBody}`;

    const response = await trackedChatCompletion(
      client,
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 256,
      },
      { callSite: "llm-parser", ...ctx },
    );

    const raw = response.choices[0]?.message?.content ?? "";
    const candidate: unknown = JSON.parse(raw);
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("LLM did not return a JSON object");
    }
    const parsed_json = candidate as Record<string, unknown>;

    const parsedIntent = coerceIntent(parsed_json.intent);

    const intents = normalizeIntents(parsed_json.intents, parsedIntent);
    const intent = intents[0] ?? "unknown";

    const identifiers: ExtractedIdentifiers = {
      orderNumber: strOrUndefined(parsed_json.orderNumber),
      email: strOrUndefined(parsed_json.email),
      customerName: strOrUndefined(parsed_json.customerName),
      trackingNumber: strOrUndefined(parsed_json.trackingNumber),
    };

    return { intent, intents, identifiers, usedLLM: true };
  } catch (err) {
    console.error("[llm-parser] OpenAI call failed, falling back to regex:", err);
    return {
      intent: classifyIntent(parsed),
      intents: classifyIntents(parsed),
      identifiers: extractIdentifiers(parsed),
      usedLLM: false,
    };
  }
}

function normalizeIntents(value: unknown, primary: SupportIntent): SupportIntent[] {
  const parsed = Array.isArray(value) ? value.map(coerceIntent).filter((intent) => intent !== "unknown") : [];
  const meaningful = parsed.filter((intent) => intent !== "unknown");
  const ordered = primary !== "unknown" ? [primary, ...meaningful] : meaningful;
  const unique = [...new Set(ordered)];
  return unique.length > 0 ? unique : ["unknown"];
}

function coerceIntent(value: unknown): SupportIntent {
  if (value === "package_stuck") return "delivery_delay";
  return VALID_INTENTS.includes(value as SupportIntent) ? (value as SupportIntent) : "unknown";
}

function strOrUndefined(val: unknown): string | undefined {
  if (typeof val === "string" && val.trim() !== "" && val !== "null") {
    return val.trim();
  }
  return undefined;
}
