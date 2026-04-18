/**
 * LLM-based email parser.
 * Uses gpt-4o-mini to extract identifiers and classify intent in one shot.
 * Falls back to the regex modules if the API call fails or returns unusable data.
 */

import OpenAI from "openai";
import type { ExtractedIdentifiers, ParsedEmail, SupportIntent } from "./types";
import { extractIdentifiers } from "./identifier-extractor";
import { classifyIntent } from "./intent-classifier";

const VALID_INTENTS: SupportIntent[] = [
  "where_is_my_order",
  "delivery_delay",
  "marked_delivered_not_received",
  "package_stuck",
  "refund_request",
  "unknown",
];

const SYSTEM_PROMPT = `You are an assistant that extracts structured data from customer support emails for an e-commerce store.

Given an email subject and body, return a JSON object with this exact shape:
{
  "intent": one of: "where_is_my_order" | "delivery_delay" | "marked_delivered_not_received" | "package_stuck" | "refund_request" | "unknown",
  "orderNumber": string or null,   // digits only, no # sign, e.g. "1002"
  "email": string or null,         // customer email address if present
  "customerName": string or null,  // full name of the customer if clearly stated
  "trackingNumber": string or null // tracking number if present
}

Intent definitions:
- where_is_my_order: customer wants to know where their parcel is or its tracking status
- delivery_delay: customer complains the delivery is late
- marked_delivered_not_received: carrier says delivered but customer hasn't received it
- package_stuck: tracking hasn't updated in a while, parcel seems stuck
- refund_request: customer explicitly asks for a refund or reimbursement
- unknown: none of the above clearly applies

Rules:
- Extract only what is explicitly written. Never guess or invent data.
- For orderNumber: extract digits only (e.g. "#1002" → "1002", "commande 1002" → "1002")
- Return valid JSON only. No explanation, no markdown, just the JSON object.`;

export interface LLMParseResult {
  intent: SupportIntent;
  identifiers: ExtractedIdentifiers;
  usedLLM: boolean;
}

function getClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key === "sk-your-key-here") return null;
  return new OpenAI({ apiKey: key });
}

export async function llmParseEmail(
  parsed: ParsedEmail,
): Promise<LLMParseResult> {
  const client = getClient();

  if (!client) {
    // No API key configured — fall back silently to regex.
    return {
      intent: classifyIntent(parsed),
      identifiers: extractIdentifiers(parsed),
      usedLLM: false,
    };
  }

  try {
    const userMessage = `Subject: ${parsed.subject}\n\nBody:\n${parsed.body}`;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 256,
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const parsed_json = JSON.parse(raw) as Record<string, unknown>;

    const intent: SupportIntent = VALID_INTENTS.includes(
      parsed_json.intent as SupportIntent,
    )
      ? (parsed_json.intent as SupportIntent)
      : "unknown";

    const identifiers: ExtractedIdentifiers = {
      orderNumber: strOrUndefined(parsed_json.orderNumber),
      email: strOrUndefined(parsed_json.email),
      customerName: strOrUndefined(parsed_json.customerName),
      trackingNumber: strOrUndefined(parsed_json.trackingNumber),
    };

    return { intent, identifiers, usedLLM: true };
  } catch (err) {
    console.error("[llm-parser] OpenAI call failed, falling back to regex:", err);
    return {
      intent: classifyIntent(parsed),
      identifiers: extractIdentifiers(parsed),
      usedLLM: false,
    };
  }
}

function strOrUndefined(val: unknown): string | undefined {
  if (typeof val === "string" && val.trim() !== "" && val !== "null") {
    return val.trim();
  }
  return undefined;
}
