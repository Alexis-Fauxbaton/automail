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
// Main export
// ---------------------------------------------------------------------------

export async function fetchTrackingFrom17track(
  trackingNumber: string,
): Promise<SevenTrackResult | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  try {
    // Step 1: register (idempotent — safe to call every time)
    await postJson<ApiResponse>(
      `${BASE}/register`,
      [{ number: trackingNumber }],
      apiKey,
    );

    // Step 2: get tracking info — retry up to MAX_ATTEMPTS times with a short
    // delay between attempts. 17track fetches carrier data asynchronously after
    // register, so the first call may return "pending" for new trackings.
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 1500;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }

      const infoRes = await postJson<ApiResponse>(
        `${BASE}/gettrackinfo`,
        [{ number: trackingNumber }],
        apiKey,
      );

      const accepted = infoRes.data?.accepted ?? [];
      const rejected = infoRes.data?.rejected ?? [];

      if (accepted.length > 0) {
        return parseTrackInfo(accepted[0]);
      }

      // -18019909 = "No tracking information at this time" (data pending)
      const rejection = rejected[0];
      if (rejection?.error?.code === -18019909) {
        if (attempt < MAX_ATTEMPTS) {
          console.log(`[17track] pending for ${trackingNumber}, retry ${attempt}/${MAX_ATTEMPTS - 1}…`);
          continue;
        }
        // All attempts exhausted
        return {
          state: "pending",
          carrierName: null,
          status: null,
          lastEvent: null,
          lastLocation: null,
          lastEventDate: null,
          delivered: false,
          events: [],
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
