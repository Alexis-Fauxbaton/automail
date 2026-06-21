/**
 * 17track API adapter — v2.2
 *
 * Flow: register → gettrackinfo (17track fetches data asynchronously after register).
 * First call may return "pending" if data isn't ready yet; subsequent calls return full data.
 *
 * API key: https://www.17track.net/en/api (free: 100 trackings/month)
 */

// API version overridable via env so a 17track upgrade doesn't require a
// code redeploy. Default kept at v2.2 (current stable as of 2026-05).
const SEVENTEEN_TRACK_VERSION = process.env.SEVENTEEN_TRACK_API_VERSION || "v2.2";
const BASE = `https://api.17track.net/track/${SEVENTEEN_TRACK_VERSION}`;

import {
  isOpen as breakerOpen,
  recordSuccess as breakerSuccess,
  recordFailure as breakerFailure,
} from "../seventeen-track-breaker";
import { createSemaphore } from "../../../util/semaphore";
import { selectCarrierCandidate } from "../carrier-selection";
import {
  seventeenTrackInFlight,
  seventeenTrackQueued,
} from "../../../metrics/definitions";

// Process-wide semaphore for 17track.
//
// Why: 17track's API key is shared across all shops on this process, and a
// single auto-sync cycle issues many parallel tracking lookups via
// Promise.all (one per fulfillment + crawler calls). With N shops syncing
// concurrently this trivially bursts past 17track's per-second limit and
// trips the circuit breaker on 429s. The breaker is the right last resort;
// the semaphore stops us from getting there in the first place by
// shaping steady-state throughput.
const SEVENTEEN_TRACK_MAX_CONCURRENT = Math.max(
  1,
  Number(process.env.SEVENTEEN_TRACK_MAX_CONCURRENT ?? "2"),
);
const sevenTrackSem = createSemaphore(SEVENTEEN_TRACK_MAX_CONCURRENT);

// ---------------------------------------------------------------------------
// API response types (v2.2 actual structure)
// ---------------------------------------------------------------------------

interface TrackEvent {
  time_iso?: string;
  description?: string;
  location?: string;
  address?: { country?: string; city?: string };
  sub_status?: string;
  stage?: string;
}

interface TrackInfo {
  latest_status?: {
    status?: string;        // e.g. "InTransit", "Delivered"
    sub_status?: string;
  };
  latest_event?: TrackEvent;
  time_metrics?: {
    estimated_delivery_date?: {
      from?: string | null;
      to?: string | null;
    };
  };
  misc_info?: {
    local_provider?: string;
  };
  shipping_info?: {
    recipient_address?: { country?: string };
    shipper_address?: { country?: string };
  };
  tracking?: {
    providers?: Array<{
      provider?: { name?: string; homepage?: string };
      events?: TrackEvent[];
    }>;
  };
}

interface AcceptedItem {
  number: string;
  carrier?: number;
  track_info?: TrackInfo;
}

interface RejectedItem {
  number: string;
  error?: { code: number; message: string };
}

interface ApiResponse {
  code: number;
  data?: {
    accepted?: AcceptedItem[];
    rejected?: RejectedItem[];
  };
}

// ---------------------------------------------------------------------------
// Public result
// ---------------------------------------------------------------------------

export interface SevenTrackResult {
  /**
   * - "ok": data returned
   * - "pending": registered but 17track hasn't fetched data yet
   * - "quota_exhausted": our 17track plan ran out for the period — not a
   *   transient error, retry won't help until the next billing cycle
   * - "error": transient or unexpected failure
   * - "corroboration_mismatch": every data candidate's recipient country
   *   contradicts the order country — likely another customer's parcel, so we
   *   refuse to surface it and fall back to Shopify data downstream.
   */
  state: "ok" | "pending" | "error" | "quota_exhausted" | "corroboration_mismatch";
  carrierName: string | null;
  carrierCode: number | null;
  status: string | null;
  lastEvent: string | null;
  lastLocation: string | null;
  lastEventDate: string | null;
  delivered: boolean;
  events: Array<{ date: string | null; description: string | null; location: string | null }>;
  /** Alpha-2 country code of the recipient as reported by 17track (e.g. "FR").
   *  Used downstream to corroborate against the Shopify shipping address country.
   *  Null when 17track does not provide it. */
  recipientCountry: string | null;
  /** True when the chosen carrier could not be corroborated against the order
   *  country (its recipient country was absent) — the result is usable but the
   *  carrier identity is a best guess, not verified. */
  inferredCarrier?: boolean;
  /** True when data was retrieved only after the reactive register-add (hint)
   *  branch ran — i.e. the first poll returned NotFound, we re-registered with
   *  a derived carrier hint, and the re-poll found the parcel. This is the
   *  signal for the `ok_hint_recovered` resolution metric. */
  recoveredViaHint?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApiKey(): string | null {
  const key = process.env.SEVENTEEN_TRACK_API_KEY;
  return key && key !== "your-17track-key-here" ? key : null;
}

function headers(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", "17token": apiKey };
}

async function postJson<T>(url: string, body: unknown, apiKey: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { httpStatus?: number };
    err.httpStatus = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

const DELIVERED_RE = /livr[ée]|delivered|remis[eé]|distribuée/i;

/** @internal exported for unit testing only */
export const parseTrackInfoForTest = parseTrackInfo;

function parseTrackInfo(item: AcceptedItem): SevenTrackResult {
  const info = item.track_info;
  if (!info) {
    return { state: "pending", carrierName: null, carrierCode: null, status: null, lastEvent: null, lastLocation: null, lastEventDate: null, delivered: false, events: [], recipientCountry: null };
  }

  const latestEvent = info.latest_event;
  const status = info.latest_status?.status ?? null;
  const description = latestEvent?.description ?? null;
  const lastEventDate = latestEvent?.time_iso ?? null;
  const lastLocation =
    latestEvent?.location ??
    latestEvent?.address?.city ??
    latestEvent?.address?.country ??
    null;

  const provider = info.tracking?.providers?.[0];
  const carrierName =
    provider?.provider?.name ?? info.misc_info?.local_provider ?? null;

  const events = (provider?.events ?? []).slice(0, 5).map((e) => ({
    date: e.time_iso ?? null,
    description: e.description ?? null,
    location: e.location ?? e.address?.city ?? e.address?.country ?? null,
  }));

  const delivered =
    status === "Delivered" ||
    (description ? DELIVERED_RE.test(description) : false);

  const recipientCountry = info.shipping_info?.recipient_address?.country ?? null;

  return {
    state: "ok",
    carrierName,
    carrierCode: item.carrier ?? null,
    status,
    lastEvent: description,
    lastLocation,
    lastEventDate,
    delivered,
    events,
    recipientCountry,
  };
}

// ---------------------------------------------------------------------------
// Carrier code hints for 17track
// Numeric codes from https://www.17track.net/en/apidoc (carrier list)
// ---------------------------------------------------------------------------

export const CARRIER_CODE_HINTS: Array<{ re: RegExp; code: number; name: string }> = [
  // Cainiao (190271 — NOT 190072 which is SUNYOU)
  { re: /^CK\d/i,         code: 190271, name: "Cainiao" },
  { re: /^CNFR/i,         code: 190271, name: "Cainiao" },
  // Yanwen
  { re: /^Y[A-Z]\d{14}$/i, code: 190150, name: "Yanwen" },
  // 4PX
  { re: /^4PX/i, code: 190148, name: "4PX" },
  // UPS
  { re: /^1Z[0-9A-Z]{16}$/, code: 100002, name: "UPS" },
  // FedEx (12 or 15 digits)
  { re: /^\d{12}$|^\d{15}$/, code: 100003, name: "FedEx" },
  // DHL Express (10 digits)
  { re: /^\d{10}$/, code: 100001, name: "DHL Express" },
  // DPD France (13 digits starting with 08 or 09 — must come BEFORE generic 13-digit La Poste)
  { re: /^(08|09)\d{11}$/, code: 100016, name: "DPD" },
  // La Poste Colissimo (13 digits) — official 17track code: 6051
  { re: /^\d{13}$/, code: 6051, name: "La Poste" },
  // La Poste / ePacket international (2 letters + 9 digits + 2 letters) — official 17track code: 6051
  { re: /^[A-Z]{2}\d{9}[A-Z]{2}$/, code: 6051, name: "La Poste" },
  // Chronopost — official 17track code: 100273 (not 100174)
  { re: /^[A-Z]{2}\d{8}[A-Z]{2}$/i, code: 100273, name: "Chronopost" },
  // GLS (11 digits)
  { re: /^\d{11}$/, code: 100066, name: "GLS" },
  // Mondial Relay (MR or 24R prefix followed by digits)
  { re: /^(MR|24R)\d+$/i, code: 100162, name: "Mondial Relay" },
];

/**
 * Return the 17track numeric carrier code if we can guess it from the tracking
 * number format, or null if unknown. Passing a hint dramatically improves
 * detection rates for carriers 17track doesn't auto-detect.
 */
// Carrier name keywords (from Shopify) → 17track numeric code
export const CARRIER_NAME_MAP: Array<{ keywords: RegExp; code: number }> = [
  // Cainiao (190271 — NOT 190072 which is SUNYOU)
  { keywords: /cainiao/i,         code: 190271 },
  { keywords: /yanwen/i,          code: 190150 },
  { keywords: /4px/i,             code: 190148 },
  { keywords: /ups/i,             code: 100002 },
  { keywords: /fedex/i,           code: 100003 },
  { keywords: /dhl/i,             code: 100001 },
  // La Poste / Colissimo — official 17track code: 6051 (not 100068)
  { keywords: /colissimo|la.?poste/i, code: 6051 },
  // Chronopost — official 17track code: 100273 (not 100174)
  { keywords: /chronopost/i,      code: 100273 },
  { keywords: /mondial.?relay/i,  code: 100162 },
  { keywords: /gls/i,             code: 100066 },
  { keywords: /dpd/i,             code: 100016 },
  { keywords: /tnt/i,             code: 100010 },
];

export function guessCarrierCode(trackingNumber: string, carrierNameHint?: string | null): number | null {
  // 1. Pattern match (most reliable)
  for (const { re, code } of CARRIER_CODE_HINTS) {
    if (re.test(trackingNumber)) return code;
  }
  // 2. Shopify carrier name hint (fallback)
  if (carrierNameHint) {
    for (const { keywords, code } of CARRIER_NAME_MAP) {
      if (keywords.test(carrierNameHint)) return code;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Carrier hint from the Shopify tracking URL host.
//
// The tracking number alone is often ambiguous (e.g. an "AP…" Cainiao number
// looks like Australia Post), and Shopify's `company` field is frequently
// "Other". The Shopify tracking URL host, when it is a real carrier domain, is
// the merchant's de-facto declared carrier — the same link shown as "Voir le
// suivi". We map a curated allowlist of carrier hosts to 17track codes and pass
// that as a register hint. Unknown hosts return null → no hint → 17track
// auto-detects exactly as before. See spec 2026-06-19.
// ---------------------------------------------------------------------------
export const CARRIER_URL_HOSTS: Array<{ host: string; code: number; name: string }> = [
  { host: "cainiao.com", code: 190271, name: "Cainiao" }, // covers global.cainiao.com
  // La Poste — official 17track code: 6051 (Colissimo), not 100068
  { host: "laposte.fr",  code: 6051, name: "La Poste" },
  { host: "ups.com",     code: 100002, name: "UPS" },
];

/**
 * Return the 17track carrier code for a Shopify tracking URL whose host is a
 * known carrier domain, or null otherwise. Matches on exact host or exact
 * dot-boundary suffix (so "notcainiao.com" never matches "cainiao.com").
 */
export function carrierCodeFromTrackingUrl(
  url: string | null | undefined,
): number | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const { host: h, code } of CARRIER_URL_HOSTS) {
    if (host === h || host.endsWith("." + h)) return code;
  }
  return null;
}

/**
 * Best-effort 17track carrier code for a number: the Shopify tracking-URL host
 * first (the merchant's de-facto declared carrier), then the number-format
 * pattern. Neither alone is sufficient — "AP…" has only the URL signal,
 * "CK…NL" has only the number-pattern signal (its URL is a misleading
 * last-mile page). Returns null when neither recognises the carrier.
 */
export function deriveCarrierHint(
  trackingNumber: string,
  trackingUrl?: string | null,
): number | null {
  return carrierCodeFromTrackingUrl(trackingUrl) ?? guessCarrierCode(trackingNumber);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function fetchTrackingFrom17track(
  trackingNumber: string,
  opts: {
    /** "<Alpha-2 country>-<postal code>" (e.g. "FR-75001"). Required by some
     *  carriers (Cainiao / postal) to register a number; ignored by the rest. */
    param?: string | null;
    /** Shopify tracking URL — its host, when a known carrier domain, feeds the
     *  reactive carrier hint when 17track returns NotFound. */
    trackingUrl?: string | null;
    /** Shopify shipping-address country (alpha-2) used to corroborate the
     *  recipient country reported by 17track and reject other-customer parcels. */
    orderCountry?: string | null;
    /** Carrier code chosen on a previous resolution, used as a tie-breaker so
     *  the displayed carrier stays stable across refreshes. */
    previousCarrierCode?: number | null;
  } = {},
): Promise<SevenTrackResult | null> {
  const { param = null, trackingUrl = null, orderCountry = null, previousCarrierCode = null } = opts;
  const maybeKey = getApiKey();
  if (!maybeKey) return null;
  // Bind to a non-null const so the nested `poll` closure keeps the narrowing
  // (TS widens captured `let`/outer vars back to nullable inside closures).
  const apiKey: string = maybeKey;
  if (breakerOpen()) {
    console.log(`[17track] breaker open — skipping call for ${trackingNumber}`);
    return null;
  }

  const bare = [{ number: trackingNumber, ...(param ? { param } : {}) }];

  seventeenTrackQueued.inc();
  const release = await sevenTrackSem.acquire();
  seventeenTrackQueued.dec();
  seventeenTrackInFlight.inc();

  // Re-check the breaker after the semaphore wait: an earlier holder may
  // have tripped it while we were queued, and we'd rather skip than pile on.
  if (breakerOpen()) {
    seventeenTrackInFlight.dec();
    release();
    console.log(`[17track] breaker open — skipping call for ${trackingNumber}`);
    return null;
  }

  // Poll gettrackinfo (carrier-agnostic) up to MAX_POLL; returns the typed
  // outcome. `null` = API failure; "pending" / "quota" passthrough; otherwise
  // the array of parsed candidates (possibly empty).
  const MAX_POLL = 3;
  const RETRY_DELAY_MS = 1500;
  async function poll(): Promise<SevenTrackResult[] | "pending" | "quota" | null> {
    for (let p = 1; p <= MAX_POLL; p++) {
      if (p > 1) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      const res = await postJson<ApiResponse>(`${BASE}/gettrackinfo`, bare, apiKey);
      const accepted = res.data?.accepted ?? [];
      const rejected = res.data?.rejected ?? [];
      if (accepted.length > 0) { breakerSuccess(); return accepted.map(parseTrackInfo); }
      const code = rejected[0]?.error?.code;
      if (code === -18019909 || code === -18019902) {
        // -18019909 = data not ready; -18019902 = not registered yet (we just
        // registered bare). Both are transient → keep polling, then pending.
        if (p < MAX_POLL) continue;
        breakerSuccess();
        return "pending";
      }
      // Real account/quota errors only: the -180100xx family. Must NOT include
      // the -180199xx registration/status codes (e.g. -18019902 not-registered).
      if (typeof code === "number" && code >= -18010999 && code <= -18010000) {
        breakerSuccess();
        return "quota";
      }
      console.warn("[17track] Unexpected rejection:", rejected[0]);
      breakerFailure();
      return null;
    }
    return null;
  }

  function emptyState(state: SevenTrackResult["state"]): SevenTrackResult {
    return { state, carrierName: null, carrierCode: null, status: null, recipientCountry: null,
      lastEvent: null, lastLocation: null, lastEventDate: null, delivered: false, events: [] };
  }

  try {
    await postJson<ApiResponse>(`${BASE}/register`, bare, apiKey);
    let candidates = await poll();
    if (candidates === "pending") return emptyState("pending");
    if (candidates === "quota") return emptyState("quota_exhausted");
    if (candidates === null) return null;

    let selection = selectCarrierCandidate(candidates, orderCountry, { previousCarrierCode });

    // Reactive recovery: nothing usable AND we can derive a carrier hint not
    // already among the candidates → register-add the hint and re-read once.
    const noData = !selection.chosen || selection.chosen.status === "NotFound";
    const hint = deriveCarrierHint(trackingNumber, trackingUrl);
    const alreadyHave = hint != null && candidates.some((c) => c.carrierCode === hint);
    let recoveredViaHint = false;
    if (noData && hint != null && !alreadyHave && !selection.corroborationMismatch) {
      await postJson<ApiResponse>(`${BASE}/register`, [{ number: trackingNumber, carrier: hint, ...(param ? { param } : {}) }], apiKey);
      const recovered = await poll();
      if (Array.isArray(recovered)) {
        candidates = recovered;
        selection = selectCarrierCandidate(candidates, orderCountry, { hintCarrierCode: hint, previousCarrierCode });
        // Mark recovered only when the re-poll actually yielded a usable (non-NotFound) result.
        if (selection.chosen && selection.chosen.status !== "NotFound" && !selection.corroborationMismatch) {
          recoveredViaHint = true;
        }
      }
    }

    if (selection.corroborationMismatch) return emptyState("corroboration_mismatch");
    if (!selection.chosen) return emptyState("pending"); // registered but no data yet
    return { ...selection.chosen, inferredCarrier: selection.unverified, recoveredViaHint } as SevenTrackResult;
  } catch (err) {
    if ((err as { httpStatus?: number })?.httpStatus === 429) {
      console.warn(`[17track] rate-limited (429) for ${trackingNumber}; transient`);
      breakerSuccess(); // a rate-limit is not a breaker-worthy failure
      return emptyState("pending");
    }
    console.error("[17track] Request failed:", err);
    breakerFailure();
    return null;
  } finally {
    release();
    seventeenTrackInFlight.dec();
  }
}
