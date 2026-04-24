/**
 * Tests for the pure functions in seventeen-track.ts.
 * No network calls — guessCarrierCode and parseTrackInfo are exercised directly.
 *
 * fetchTrackingFrom17track (the async, fetch-dependent export) is NOT tested here;
 * it is covered at the integration level via mocked tracking-service in pipeline.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// We need to test non-exported helpers. Two options:
//   A) Export them (changes the module interface)
//   B) Re-implement the logic in the test (maintenance burden)
// We go with option A — exporting as @internal is conventional and honest.
//
// If the functions are not yet exported, this file will fail to compile and
// that is intentional: it tells us we need to export them.
// ---------------------------------------------------------------------------

import {
  guessCarrierCode,
  parseTrackInfoForTest as parseTrackInfo,
  fetchTrackingFrom17track,
} from "../seventeen-track";

// ---------------------------------------------------------------------------
// guessCarrierCode — carrier code lookup from tracking number pattern
// ---------------------------------------------------------------------------

describe("guessCarrierCode — pattern matching", () => {
  it("returns UPS code for 1Z tracking numbers", () => {
    expect(guessCarrierCode("1Z999AA10123456784")).toBe(100002);
  });

  it("returns La Poste code for 13-digit numbers", () => {
    expect(guessCarrierCode("6123456789012")).toBe(100068);
  });

  it("returns La Poste code for international format (2L+9D+2L)", () => {
    expect(guessCarrierCode("AB123456789FR")).toBe(100068);
  });

  it("returns FedEx code for 12-digit numbers", () => {
    expect(guessCarrierCode("123456789012")).toBe(100003);
  });

  it("returns FedEx code for 15-digit numbers", () => {
    expect(guessCarrierCode("123456789012345")).toBe(100003);
  });

  it("returns DHL code for 10-digit numbers", () => {
    expect(guessCarrierCode("1234567890")).toBe(100001);
  });

  it("returns GLS code for 11-digit numbers", () => {
    expect(guessCarrierCode("12345678901")).toBe(100066);
  });

  it("returns Cainiao code for CK-prefixed numbers", () => {
    expect(guessCarrierCode("CK123456789CN")).toBe(190271);
  });

  it("returns null for unknown pattern with no carrier hint", () => {
    expect(guessCarrierCode("UNKNOWNXYZ")).toBeNull();
  });

  it("falls back to carrier name hint when pattern is unknown", () => {
    expect(guessCarrierCode("UNKNOWNXYZ", "Colissimo")).toBe(100068);
  });

  it("falls back to carrier name hint for 'La Poste'", () => {
    expect(guessCarrierCode("UNKNOWNXYZ", "La Poste")).toBe(100068);
  });

  it("falls back to carrier name hint for 'DHL Express'", () => {
    expect(guessCarrierCode("UNKNOWNXYZ", "DHL Express")).toBe(100001);
  });

  it("pattern match takes priority over carrier name hint", () => {
    // 13-digit number → La Poste by pattern, even if hint says UPS
    expect(guessCarrierCode("6123456789012", "UPS")).toBe(100068);
  });

  it("returns null when neither pattern nor hint matches", () => {
    expect(guessCarrierCode("WEIRDFORMAT", "SomeUnknownCarrier")).toBeNull();
  });

  it("returns Cainiao code for CNFR-prefixed numbers", () => {
    expect(guessCarrierCode("CNFR1234567890")).toBe(190271);
  });

  it("returns Yanwen code for Y[A-Z]+14digit numbers", () => {
    expect(guessCarrierCode("YT12345678901234")).toBe(190150);
  });

  it("returns 4PX code for 4PX-prefixed numbers", () => {
    expect(guessCarrierCode("4PX1234567890")).toBe(190148);
  });

  it("returns La Poste code for real prod number LV109807596FR (2L+9D+2L)", () => {
    expect(guessCarrierCode("LV109807596FR")).toBe(100068);
  });

  it("returns Chronopost code for 2L+8D+2L format", () => {
    expect(guessCarrierCode("AB12345678FR")).toBe(100174);
  });

  it("returns Mondial Relay code for MR-prefixed numbers (validates bug 3 fix)", () => {
    expect(guessCarrierCode("MR12345678")).toBe(100162);
  });

  it("returns Mondial Relay code for 24R-prefixed numbers", () => {
    expect(guessCarrierCode("24R123456789")).toBe(100162);
  });

  it("returns DPD code for 13-digit numbers starting with 08 (validates bug 2 fix)", () => {
    expect(guessCarrierCode("0812345678901")).toBe(100016);
  });

  it("returns DPD code for 13-digit numbers starting with 09", () => {
    expect(guessCarrierCode("0912345678901")).toBe(100016);
  });

  it("DPD number is NOT classified as La Poste (regression guard for bug 2)", () => {
    expect(guessCarrierCode("0812345678901")).not.toBe(100068);
  });

  it("falls back to carrier name hint for 'TNT'", () => {
    expect(guessCarrierCode("UNKNOWNXYZ", "TNT")).toBe(100010);
  });
});

// ---------------------------------------------------------------------------
// Regression — real production tracking numbers that previously failed
//
// These numbers caused NotFound because the wrong carrier code was sent to
// 17track. Any change to CARRIER_CODE_HINTS that breaks these must be caught.
// ---------------------------------------------------------------------------

describe("guessCarrierCode — regression: real production numbers", () => {
  it("CK090342615NL (Cainiao, shipped as SUNYOU) → Cainiao 190271, NOT null", () => {
    // Was sent to 17track without a carrier hint or with wrong hint → NotFound.
    // CK prefix must always resolve to Cainiao (190271).
    expect(guessCarrierCode("CK090342615NL")).toBe(190271);
  });

  it("CK090342615NL is NOT classified as SUNYOU (190072)", () => {
    expect(guessCarrierCode("CK090342615NL")).not.toBe(190072);
  });

  it("CNFR901048869170 5HD (Cainiao AliExpress FR, shipped as SUNYOU) → Cainiao 190271", () => {
    // CNFR prefix = Cainiao France. Was misclassified → NotFound.
    expect(guessCarrierCode("CNFR9010488691705HD")).toBe(190271);
  });

  it("CNFR9010488691705HD is NOT classified as SUNYOU (190072)", () => {
    expect(guessCarrierCode("CNFR9010488691705HD")).not.toBe(190072);
  });

  it("carrier name hint 'SUNYOU' does not override correct CK pattern detection", () => {
    // Even when Shopify says carrier = SUNYOU, pattern match must win.
    expect(guessCarrierCode("CK090342615NL", "SUNYOU")).toBe(190271);
  });

  it("carrier name hint 'SUNYOU' does not override correct CNFR pattern detection", () => {
    expect(guessCarrierCode("CNFR9010488691705HD", "SUNYOU")).toBe(190271);
  });
});

// ---------------------------------------------------------------------------
// parseTrackInfo — parse 17track API response into SevenTrackResult
// ---------------------------------------------------------------------------

describe("parseTrackInfo — basic fields", () => {
  it("returns pending state when track_info is absent", () => {
    const result = parseTrackInfo({ number: "123" });
    expect(result.state).toBe("pending");
    expect(result.delivered).toBe(false);
    expect(result.events).toHaveLength(0);
  });

  it("maps status and latest event fields", () => {
    const result = parseTrackInfo({
      number: "123",
      track_info: {
        latest_status: { status: "InTransit" },
        latest_event: {
          description: "Parcel in transit",
          time_iso: "2024-01-15T10:00:00Z",
          location: "Paris",
        },
      },
    });
    expect(result.state).toBe("ok");
    expect(result.status).toBe("InTransit");
    expect(result.lastEvent).toBe("Parcel in transit");
    expect(result.lastEventDate).toBe("2024-01-15T10:00:00Z");
    expect(result.lastLocation).toBe("Paris");
    expect(result.delivered).toBe(false);
  });

  it("extracts carrier name from providers[0]", () => {
    const result = parseTrackInfo({
      number: "123",
      track_info: {
        tracking: {
          providers: [{ provider: { name: "Chronopost" }, events: [] }],
        },
      },
    });
    expect(result.carrierName).toBe("Chronopost");
  });

  it("falls back to misc_info.local_provider when providers is empty", () => {
    const result = parseTrackInfo({
      number: "123",
      track_info: {
        misc_info: { local_provider: "Colissimo" },
      },
    });
    expect(result.carrierName).toBe("Colissimo");
  });

  it("returns null carrierName when no provider info available", () => {
    const result = parseTrackInfo({ number: "123", track_info: {} });
    expect(result.carrierName).toBeNull();
  });

  it("uses address.city as fallback for lastLocation", () => {
    const result = parseTrackInfo({
      number: "123",
      track_info: {
        latest_event: { address: { city: "Lyon" } },
      },
    });
    expect(result.lastLocation).toBe("Lyon");
  });

  it("uses address.country as last-resort fallback for lastLocation", () => {
    const result = parseTrackInfo({
      number: "123",
      track_info: {
        latest_event: { address: { country: "FR" } },
      },
    });
    expect(result.lastLocation).toBe("FR");
  });

  it("caps events list at 5 entries", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      time_iso: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      description: `Event ${i + 1}`,
    }));
    const result = parseTrackInfo({
      number: "123",
      track_info: {
        tracking: { providers: [{ provider: { name: "Test" }, events }] },
      },
    });
    expect(result.events).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// parseTrackInfo — delivered detection (business-critical)
// A wrong `delivered` flag could cause the draft to treat an arrived parcel as lost.
// ---------------------------------------------------------------------------

describe("parseTrackInfo — delivered detection", () => {
  it("detects delivered via status === 'Delivered'", () => {
    const result = parseTrackInfo({
      number: "123",
      track_info: { latest_status: { status: "Delivered" } },
    });
    expect(result.delivered).toBe(true);
  });

  it("detects 'livré' in description (French)", () => {
    const result = parseTrackInfo({
      number: "123",
      track_info: {
        latest_event: { description: "Colis livré au destinataire" },
      },
    });
    expect(result.delivered).toBe(true);
  });

  it("detects 'livrée' (feminine) in description", () => {
    const result = parseTrackInfo({
      number: "123",
      track_info: { latest_event: { description: "Marchandise livrée" } },
    });
    expect(result.delivered).toBe(true);
  });

  it("detects 'delivered' in English description", () => {
    const result = parseTrackInfo({
      number: "123",
      track_info: { latest_event: { description: "Package delivered to front door" } },
    });
    expect(result.delivered).toBe(true);
  });

  it("detects 'remise' in description", () => {
    const result = parseTrackInfo({
      number: "123",
      track_info: { latest_event: { description: "Remise en main propre" } },
    });
    expect(result.delivered).toBe(true);
  });

  it("detects 'distribuée' in description", () => {
    const result = parseTrackInfo({
      number: "123",
      track_info: { latest_event: { description: "Lettre distribuée" } },
    });
    expect(result.delivered).toBe(true);
  });

  it("returns delivered=false for InTransit status", () => {
    const result = parseTrackInfo({
      number: "123",
      track_info: {
        latest_status: { status: "InTransit" },
        latest_event: { description: "In transit to destination" },
      },
    });
    expect(result.delivered).toBe(false);
  });

  it("returns delivered=false when no status and no description", () => {
    const result = parseTrackInfo({ number: "123", track_info: {} });
    expect(result.delivered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchTrackingFrom17track — retry logic and edge cases
// ---------------------------------------------------------------------------

const PENDING_REJECTION = { code: 0, data: { rejected: [{ number: "LV109807596FR", error: { code: -18019909, message: "pending" } }] } };
const OK_RESPONSE = {
  code: 0,
  data: {
    accepted: [{
      number: "LV109807596FR",
      track_info: {
        latest_status: { status: "InTransit" },
        latest_event: { description: "In transit", time_iso: "2024-01-15T10:00:00Z", location: "Paris" },
        tracking: { providers: [{ provider: { name: "La Poste" }, events: [] }] },
      },
    }],
  },
};
const OTHER_REJECTION = { code: 0, data: { rejected: [{ number: "LV109807596FR", error: { code: -99999, message: "invalid carrier" } }] } };

function mockOkFetch(response: unknown) {
  return { ok: true, json: () => Promise.resolve(response) };
}

describe("fetchTrackingFrom17track — retry logic", () => {
  const ORIGINAL_KEY = process.env.SEVENTEEN_TRACK_API_KEY;

  beforeEach(() => {
    process.env.SEVENTEEN_TRACK_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env.SEVENTEEN_TRACK_API_KEY = ORIGINAL_KEY;
    vi.unstubAllGlobals();
  });

  it("returns null immediately when no API key is set", async () => {
    process.env.SEVENTEEN_TRACK_API_KEY = "";
    const result = await fetchTrackingFrom17track("LV109807596FR");
    expect(result).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns parsed result when data is available on first poll", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOkFetch({ code: 0 }) as unknown as Response)   // register
      .mockResolvedValueOnce(mockOkFetch(OK_RESPONSE) as unknown as Response);  // gettrackinfo

    const result = await fetchTrackingFrom17track("LV109807596FR");
    expect(result?.state).toBe("ok");
    expect(result?.status).toBe("InTransit");
    expect(result?.carrierName).toBe("La Poste");
  });

  it("retries on pending (-18019909) and returns result on second poll", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOkFetch({ code: 0 }) as unknown as Response)            // register
      .mockResolvedValueOnce(mockOkFetch(PENDING_REJECTION) as unknown as Response)      // poll 1: pending
      .mockResolvedValueOnce(mockOkFetch(OK_RESPONSE) as unknown as Response);           // poll 2: data ready

    const result = await fetchTrackingFrom17track("LV109807596FR");
    expect(result?.state).toBe("ok");
  });

  it("returns pending state after 3 pending polls", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOkFetch({ code: 0 }) as unknown as Response)
      .mockResolvedValueOnce(mockOkFetch(PENDING_REJECTION) as unknown as Response)
      .mockResolvedValueOnce(mockOkFetch(PENDING_REJECTION) as unknown as Response)
      .mockResolvedValueOnce(mockOkFetch(PENDING_REJECTION) as unknown as Response);

    const result = await fetchTrackingFrom17track("LV109807596FR");
    expect(result?.state).toBe("pending");
  });

  it("returns null on unexpected rejection", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOkFetch({ code: 0 }) as unknown as Response)
      .mockResolvedValueOnce(mockOkFetch(OTHER_REJECTION) as unknown as Response);

    const result = await fetchTrackingFrom17track("LV109807596FR");
    expect(result).toBeNull();
  });

  it("returns null on HTTP error (fetch throws)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

    const result = await fetchTrackingFrom17track("LV109807596FR");
    expect(result).toBeNull();
  });

  it("returns null on HTTP error status (res.ok = false)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response);

    const result = await fetchTrackingFrom17track("LV109807596FR");
    expect(result).toBeNull();
  });
});
