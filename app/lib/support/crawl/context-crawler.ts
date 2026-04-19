/**
 * Context crawler — smart retrieval layer.
 *
 * Strategy for tracking pages:
 * 1. Detect carrier from tracking number pattern (carrier-detector.ts)
 * 2. Fetch the carrier's own tracking page (SSR-friendly)
 * 3. Extract text + JSON-LD + embedded JSON blobs
 * 4. LLM extracts structured summary
 *
 * Aggregators (ordertracker.com, parcelsapp.com, etc.) are NOT used as
 * primary sources — they all render client-side and return empty shells.
 */

import OpenAI from "openai";
import { resolveCarrierUrls } from "./carrier-detector";
import { fetchTrackingFrom17track } from "../tracking/adapters/seventeen-track";
import type { OrderFacts, SupportIntent, TrackingFacts } from "../types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CrawlTask {
  url: string;
  purpose: string;
  extractionHint: string;
}

export interface CrawledContext {
  url: string;
  purpose: string;
  extractedText: string;
  success: boolean;
}

// ---------------------------------------------------------------------------
// Page fetching & content extraction
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
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
    .trim();
}

/** Extract JSON-LD structured data (schema.org etc.) */
function extractJsonLd(html: string): string {
  const chunks: string[] = [];
  const matches = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const m of matches) {
    try {
      const parsed = JSON.parse(m[1]);
      chunks.push(JSON.stringify(parsed));
    } catch {
      chunks.push(m[1].slice(0, 1000));
    }
  }
  return chunks.join("\n");
}

/** Extract Next.js / Nuxt / generic SPA embedded data from script tags */
function extractEmbeddedJson(html: string): string {
  const chunks: string[] = [];

  const nextData = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextData?.[1]) {
    try {
      chunks.push(JSON.stringify(JSON.parse(nextData[1])));
    } catch {
      chunks.push(nextData[1].slice(0, 3000));
    }
  }

  const initState = html.match(
    /window\.__(?:INITIAL_STATE|NUXT|STATE|DATA)__\s*=\s*(\{[\s\S]{20,5000}?\});/,
  );
  if (initState?.[1]) {
    try {
      chunks.push(JSON.stringify(JSON.parse(initState[1])));
    } catch {
      chunks.push(initState[1].slice(0, 2000));
    }
  }

  // Generic application/json blocks (not __NEXT_DATA__)
  const jsonScripts = html.matchAll(
    /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const m of jsonScripts) {
    if (m[0].includes("__NEXT_DATA__")) continue;
    try {
      chunks.push(JSON.stringify(JSON.parse(m[1])));
    } catch {
      chunks.push(m[1].slice(0, 1000));
    }
  }

  return chunks.join("\n").slice(0, 5000);
}

function pageToText(html: string): string {
  const jsonLd = extractJsonLd(html);
  const embedded = extractEmbeddedJson(html);
  const visible = stripHtml(html).slice(0, 3000);

  const parts = [
    jsonLd ? `[Structured data (JSON-LD)]\n${jsonLd}` : "",
    embedded ? `[Embedded app data]\n${embedded}` : "",
    `[Visible text]\n${visible}`,
  ].filter(Boolean);

  return parts.join("\n\n").slice(0, 8000);
}

/**
 * Allowlist of carrier/tracking domains that fetchPage() may contact.
 * This prevents SSRF: URLs are built from user-supplied tracking numbers,
 * so without a whitelist an attacker could craft a number that resolves
 * to an internal address.
 */
const ALLOWED_FETCH_DOMAINS = new Set([
  "www.laposte.fr",
  "laposte.fr",
  "www.chronopost.fr",
  "chronopost.fr",
  "www.colissimo.fr",
  "colissimo.fr",
  "www.dpd.fr",
  "dpd.fr",
  "www.gls-france.com",
  "gls-france.com",
  "www.mondialrelay.fr",
  "mondialrelay.fr",
  "www.ups.com",
  "ups.com",
  "www.fedex.com",
  "fedex.com",
  "www.dhl.com",
  "dhl.com",
  "www.colisprive.com",
  "colisprive.com",
  "parcelsapp.com",
  "ordertracker.com",
]);

function isAllowedUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    // HTTPS only
    if (parsed.protocol !== "https:") return false;
    // Hostname must be in the allowlist
    const hostname = parsed.hostname.toLowerCase();
    return ALLOWED_FETCH_DOMAINS.has(hostname);
  } catch {
    return false;
  }
}

async function fetchPage(url: string): Promise<string | null> {
  if (!isAllowedUrl(url)) {
    console.warn("[crawler] fetchPage blocked non-allowlisted URL:", url);
    return null;
  }
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(10000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM = `You are an information extraction assistant for an e-commerce customer support tool.
Given content from a carrier tracking page (may be HTML text, JSON-LD, or embedded JSON) and a task,
extract only the relevant delivery facts.
Return a concise plain-text summary (2-6 sentences).
If the content has no useful tracking information (login wall, empty page, JS-only placeholder), reply exactly: NO_USEFUL_CONTENT
Never invent or assume facts not present in the content.`;

async function extractWithLLM(
  client: OpenAI,
  pageText: string,
  task: CrawlTask,
): Promise<string | null> {
  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM },
        {
          role: "user",
          content: `Task: ${task.extractionHint}\n\nPage content:\n${pageText}`,
        },
      ],
      temperature: 0,
      max_tokens: 300,
    });
    const result = response.choices[0]?.message?.content?.trim() ?? "";
    if (!result || result === "NO_USEFUL_CONTENT") return null;
    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Task builders
// ---------------------------------------------------------------------------

export function buildCrawlTasks(
  intent: SupportIntent,
  tracking: TrackingFacts | null,
  _order: OrderFacts | null,
): CrawlTask[] {
  const tasks: CrawlTask[] = [];

  const trackingIntents: SupportIntent[] = [
    "where_is_my_order",
    "delivery_delay",
    "marked_delivered_not_received",
    "package_stuck",
    "refund_request", // needed: if package not received, live status informs the reply
  ];

  if (!trackingIntents.includes(intent) || !tracking?.trackingNumber) {
    return tasks;
  }

  const num = tracking.trackingNumber;
  const carrierCandidates = resolveCarrierUrls(num, tracking.trackingUrl);

  for (const candidate of carrierCandidates) {
    tasks.push({
      url: candidate.trackingUrl,
      purpose: `Live tracking status for ${num} (${candidate.name})`,
      extractionHint: `Extract the current delivery status, most recent scan event with date/time, last known location, and estimated delivery date for tracking number ${num}. If the parcel is marked as delivered, state when and where.`,
    });
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function crawlContexts(tasks: CrawlTask[]): Promise<CrawledContext[]> {
  if (tasks.length === 0) return [];

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey || openaiKey === "sk-your-key-here") return [];

  const client = new OpenAI({ apiKey: openaiKey });

  // Group by base purpose (tracking number), try sources in order, stop at first success
  const byPurposeBase = new Map<string, CrawlTask[]>();
  for (const task of tasks) {
    const base = task.purpose.replace(/\s*\([^)]+\)$/, "");
    if (!byPurposeBase.has(base)) byPurposeBase.set(base, []);
    byPurposeBase.get(base)!.push(task);
  }

  const results: CrawledContext[] = [];

  for (const [basePurpose, purposeTasks] of byPurposeBase) {
    let succeeded = false;

    // --- Strategy 1: 17track API (most reliable, no WAF issues) ---
    // Extract tracking number from the purpose string "Live tracking status for XXXX"
    const numMatch = basePurpose.match(/for\s+([A-Z0-9]+)/i);
    const trackingNumber = numMatch?.[1] ?? null;

    if (trackingNumber) {
      try {
        const result = await fetchTrackingFrom17track(trackingNumber);
        if (result) {
          const lines: string[] = [];
          if (result.carrierName) lines.push(`Carrier: ${result.carrierName}`);
          if (result.status) lines.push(`Status: ${result.status}`);
          if (result.lastEventDate) lines.push(`Date: ${result.lastEventDate}`);
          if (result.lastLocation) lines.push(`Location: ${result.lastLocation}`);
          if (result.delivered) lines.push("The parcel has been delivered.");
          if (result.events.length > 1) {
            const prev = result.events[1];
            if (prev.description) {
              lines.push(
                `Previous event: ${prev.description}${prev.location ? ` — ${prev.location}` : ""}${prev.date ? ` (${prev.date})` : ""}`,
              );
            }
          }

          if (lines.length > 0) {
            results.push({
              url: "17track API",
              purpose: basePurpose,
              extractedText: lines.join("\n"),
              success: true,
            });
            succeeded = true;
          }
        }
      } catch (err) {
        console.error("[crawler] 17track lookup failed:", err);
      }
    }

    // --- Strategy 2: SSR carrier page + LLM extraction (fallback) ---
    // Carrier websites often WAF-block fetch(), but worth trying as fallback.
    if (!succeeded) {
      for (const task of purposeTasks) {
        if (succeeded) break;

        const html = await fetchPage(task.url);
        if (!html) continue;

        const text = pageToText(html);
        if (text.length < 100) continue;

        const extracted = await extractWithLLM(client, text, task);
        if (!extracted) continue;

        results.push({
          url: task.url,
          purpose: basePurpose,
          extractedText: extracted,
          success: true,
        });
        succeeded = true;
      }
    }

    if (!succeeded) {
      results.push({
        url: purposeTasks[0]?.url ?? "17track API",
        purpose: basePurpose,
        extractedText: "",
        success: false,
      });
    }
  }

  return results;
}
