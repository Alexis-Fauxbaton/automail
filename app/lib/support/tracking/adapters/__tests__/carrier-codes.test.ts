/**
 * Guards our hard-coded 17track carrier codes against the official list
 * (res.17track.net/asset/carrier/info/apicarrier.all.json, retrieved 2026-06-19).
 * No network: the official codes are pinned here as literals; if our tables
 * drift, this test fails and forces an intentional update.
 */
import { describe, it, expect } from "vitest";
import {
  CARRIER_CODE_HINTS,
  CARRIER_NAME_MAP,
  CARRIER_URL_HOSTS,
} from "../seventeen-track";

// name → official 17track code
const OFFICIAL: Record<string, number> = {
  Cainiao: 190271,
  "La Poste": 6051,
  "Australia Post": 1151,
  PostNL: 14041,
  "Colis Privé": 100027,
  Chronopost: 100273,
  UPS: 100002,
};

describe("carrier codes match the official 17track list", () => {
  it("CARRIER_URL_HOSTS use official codes", () => {
    const laposte = CARRIER_URL_HOSTS.find((h) => h.host === "laposte.fr");
    expect(laposte?.code).toBe(OFFICIAL["La Poste"]);
    const cainiao = CARRIER_URL_HOSTS.find((h) => h.host === "cainiao.com");
    expect(cainiao?.code).toBe(OFFICIAL["Cainiao"]);
    const ups = CARRIER_URL_HOSTS.find((h) => h.host === "ups.com");
    expect(ups?.code).toBe(OFFICIAL["UPS"]);
  });

  it("La Poste pattern hint uses 6051 (Colissimo), not 100068", () => {
    const laposteHints = CARRIER_CODE_HINTS.filter((h) => h.code === 100068);
    expect(laposteHints).toHaveLength(0);
    expect(CARRIER_CODE_HINTS.some((h) => h.code === 6051)).toBe(true);
  });

  it("Chronopost uses 100273, not 100174", () => {
    expect(CARRIER_CODE_HINTS.some((h) => h.code === 100174)).toBe(false);
    expect(CARRIER_CODE_HINTS.some((h) => h.code === 100273)).toBe(true);
  });

  it("CARRIER_NAME_MAP La Poste maps to 6051", () => {
    const entry = CARRIER_NAME_MAP.find((m) => m.keywords.test("Colissimo"));
    expect(entry?.code).toBe(6051);
  });
});
