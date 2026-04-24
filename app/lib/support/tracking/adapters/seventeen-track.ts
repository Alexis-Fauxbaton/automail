/**
 * 17track API adapter — v2.2
 *
 * Flow: register → gettrackinfo (17track fetches data asynchronously after register).
 * First call may return "pending" if data isn't ready yet; subsequent calls return full data.
 *
 * API key: https://www.17track.net/en/api (free: 100 trackings/month)
 */

const BASE = "https://api.17track.net/track/v2.2";

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
  /** "pending" = registered but 17track hasn't fetched data yet */
  state: "ok" | "pending" | "error";
  carrierName: string | null;
  status: string | null;
  lastEvent: string | null;
  lastLocation: string | null;
  lastEventDate: string | null;
  delivered: boolean;
  events: Array<{ date: string | null; description: string | null; location: string | null }>;
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const DELIVERED_RE = /livr[ée]|delivered|remis[eé]|distribuée/i;

/** @internal exported for unit testing only */
export const parseTrackInfoForTest = parseTrackInfo;

function parseTrackInfo(item: AcceptedItem): SevenTrackResult {
  const info = item.track_info;
  if (!info) {
    return { state: "pending", carrierName: null, status: null, lastEvent: null, lastLocation: null, lastEventDate: null, delivered: false, events: [] };
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

  return {
    state: "ok",
    carrierName,
    status,
    lastEvent: description,
    lastLocation,
    lastEventDate,
    delivered,
    events,
  };
}

// ---------------------------------------------------------------------------
// Carrier code hints for 17track
// Numeric codes from https://www.17track.net/en/apidoc (carrier list)
// ---------------------------------------------------------------------------

const CARRIER_CODE_HINTS: Array<{ re: RegExp; code: number; name: string }> = [
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
  // La Poste Colissimo (13 digits)
  { re: /^\d{13}$/, code: 100068, name: "La Poste" },
  // La Poste / ePacket international (2 letters + 9 digits + 2 letters)
  { re: /^[A-Z]{2}\d{9}[A-Z]{2}$/, code: 100068, name: "La Poste" },
  // Chronopost
  { re: /^[A-Z]{2}\d{8}[A-Z]{2}$/i, code: 100174, name: "Chronopost" },
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
const CARRIER_NAME_MAP: Array<{ keywords: RegExp; code: number }> = [
  // Cainiao (190271 — NOT 190072 which is SUNYOU)
  { keywords: /cainiao/i,         code: 190271 },
  { keywords: /yanwen/i,          code: 190150 },
  { keywords: /4px/i,             code: 190148 },
  { keywords: /ups/i,             code: 100002 },
  { keywords: /fedex/i,           code: 100003 },
  { keywords: /dhl/i,             code: 100001 },
  { keywords: /colissimo|la.?poste/i, code: 100068 },
  { keywords: /chronopost/i,      code: 100174 },
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
// Main export
// ---------------------------------------------------------------------------

export async function fetchTrackingFrom17track(
  trackingNumber: string,
  _carrierNameHint?: string | null,
): Promise<SevenTrackResult | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  // Always let 17track auto-detect the carrier — passing a carrier code locks
  // the lookup to that carrier's system, causing NotFound if the code is wrong.
  const payload = [{ number: trackingNumber }];

  try {
    await postJson<ApiResponse>(`${BASE}/register`, payload, apiKey);

    const MAX_POLL = 3;
    const RETRY_DELAY_MS = 1500;

    for (let poll = 1; poll <= MAX_POLL; poll++) {
      if (poll > 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }

      const infoRes = await postJson<ApiResponse>(`${BASE}/gettrackinfo`, payload, apiKey);

      const accepted = infoRes.data?.accepted ?? [];
      const rejected = infoRes.data?.rejected ?? [];

      if (accepted.length > 0) {
          // 17track may return multiple entries for the same number (one per past carrier
          // registration). Prefer the first entry that has real data over a stale "NotFound".
          const best =
            accepted.find((a) => a.track_info?.latest_status?.status !== "NotFound") ??
            accepted[0];
          return parseTrackInfo(best);
        }

      const rejection = rejected[0];

      // -18019909 = "No tracking information at this time" (data pending)
      if (rejection?.error?.code === -18019909) {
        if (poll < MAX_POLL) {
          console.log(`[17track] pending for ${trackingNumber}, retry ${poll}/${MAX_POLL - 1}…`);
          continue;
        }
        return {
          state: "pending",
          carrierName: null, status: null, lastEvent: null,
          lastLocation: null, lastEventDate: null, delivered: false, events: [],
        };
      }

      console.warn("[17track] Unexpected rejection:", rejection);
      return null;
    }

    return null;
  } catch (err) {
    console.error("[17track] Request failed:", err);
    return null;
  }
}
