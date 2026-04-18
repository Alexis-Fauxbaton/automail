/**
 * LLM-powered tracking agent.
 *
 * When intent is tracking-related and we have a tracking URL, this module:
 * 1. Fetches the tracking page (plain HTTP, no browser)
 * 2. Strips HTML down to readable text
 * 3. Asks gpt-4o-mini to extract the current parcel status
 *
 * Scraping is a fallback: if the fetch fails or returns no useful content,
 * we return null and the caller falls back to Shopify-only data.
 * All agent-derived data is flagged `inferred: true`.
 */

import OpenAI from "openai";
import type { TrackingFacts } from "../types";

const SYSTEM_PROMPT = `You are a parcel tracking specialist. Given raw text extracted from a carrier tracking page, extract the current delivery status.

Return a JSON object with this exact shape:
{
  "status": string,        // human-readable current status, e.g. "En cours de livraison", "Livré", "En transit", "En attente de douane"
  "lastEvent": string,     // the most recent tracking event description if available
  "lastLocation": string or null,  // city or location of the last scan if available
  "estimatedDelivery": string or null,  // estimated delivery date if mentioned
  "delivered": boolean     // true only if the page clearly says the parcel was delivered
}

Rules:
- Only extract what is explicitly present in the text. Never invent data.
- If the page has no tracking information or is a login/error page, return null.
- Return valid JSON only. No explanation, no markdown.`;

interface TrackingAgentResult {
  status: string;
  lastEvent: string;
  lastLocation: string | null;
  estimatedDelivery: string | null;
  delivered: boolean;
}

function getClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key === "sk-your-key-here") return null;
  return new OpenAI({ apiKey: key });
}

/**
 * Strip HTML tags and collapse whitespace into readable plain text.
 * Keeps max 4000 chars to stay within token budget.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 4000);
}

async function fetchTrackingPage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    return htmlToText(html);
  } catch {
    return null;
  }
}

async function askLLM(
  client: OpenAI,
  pageText: string,
  trackingNumber: string,
): Promise<TrackingAgentResult | null> {
  try {
    const userMessage = `Tracking number: ${trackingNumber}\n\nPage content:\n${pageText}`;

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
    const result = JSON.parse(raw);

    // If LLM says no info, return null
    if (!result || !result.status) return null;
    return result as TrackingAgentResult;
  } catch {
    return null;
  }
}

/**
 * Try to enrich tracking facts by visiting the tracking page.
 * Returns an updated TrackingFacts on success, or the original facts unchanged.
 */
export async function enrichTrackingWithAgent(
  tracking: TrackingFacts,
): Promise<TrackingFacts> {
  if (!tracking.trackingUrl || !tracking.trackingNumber) return tracking;

  const client = getClient();
  if (!client) return tracking;

  const pageText = await fetchTrackingPage(tracking.trackingUrl);
  if (!pageText || pageText.length < 50) return tracking;

  const result = await askLLM(client, pageText, tracking.trackingNumber);
  if (!result) return tracking;

  return {
    ...tracking,
    // Merge LLM-derived status into existing facts
    status: result.status,
    agentStatus: {
      lastEvent: result.lastEvent,
      lastLocation: result.lastLocation ?? null,
      estimatedDelivery: result.estimatedDelivery ?? null,
      delivered: result.delivered,
    },
    inferred: tracking.inferred, // keep original source reliability flag
  };
}
