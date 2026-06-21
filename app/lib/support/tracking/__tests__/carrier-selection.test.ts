import { describe, it, expect } from "vitest";
import { selectCarrierCandidate } from "../carrier-selection";
import type { SevenTrackResult } from "../adapters/seventeen-track";

function cand(p: Partial<SevenTrackResult>): SevenTrackResult {
  return {
    state: "ok", carrierName: null, carrierCode: null, status: null,
    recipientCountry: null, lastEvent: null, lastLocation: null,
    lastEventDate: null, delivered: false, events: [], ...p,
  };
}

describe("selectCarrierCandidate", () => {
  it("drops a candidate whose recipient country contradicts the order", () => {
    const dpdDE = cand({ carrierCode: 100016, carrierName: "DPD (DE)", status: "Delivered", recipientCountry: "DE", delivered: true });
    const r = selectCarrierCandidate([dpdDE], "FR");
    expect(r.chosen).toBeNull();
    expect(r.corroborationMismatch).toBe(true);
  });

  it("picks the non-NotFound candidate over a NotFound one", () => {
    const postnl = cand({ carrierCode: 14041, status: "NotFound" });
    const cainiao = cand({ carrierCode: 190271, status: "InTransit", recipientCountry: "FR" });
    const r = selectCarrierCandidate([postnl, cainiao], "FR");
    expect(r.chosen?.carrierCode).toBe(190271);
    expect(r.unverified).toBe(false);
  });

  it("prefers a Delivered candidate (terminal, stable)", () => {
    const a = cand({ carrierCode: 1, status: "InTransit", recipientCountry: "FR", lastEventDate: "2026-06-18T00:00:00Z" });
    const b = cand({ carrierCode: 2, status: "Delivered", recipientCountry: "FR", delivered: true, lastEventDate: "2026-06-10T00:00:00Z" });
    const r = selectCarrierCandidate([a, b], "FR");
    expect(r.chosen?.carrierCode).toBe(2);
  });

  it("among non-delivered, prefers the hint carrier (stable identity, not recency)", () => {
    const a = cand({ carrierCode: 1, status: "InTransit", recipientCountry: "FR", lastEventDate: "2026-06-18T00:00:00Z" });
    const b = cand({ carrierCode: 190271, status: "InTransit", recipientCountry: "FR", lastEventDate: "2026-06-10T00:00:00Z" });
    const r = selectCarrierCandidate([a, b], "FR", { hintCarrierCode: 190271 });
    expect(r.chosen?.carrierCode).toBe(190271);
  });

  it("among non-delivered with no hint, prefers the previously chosen carrier", () => {
    const a = cand({ carrierCode: 1, status: "InTransit", recipientCountry: "FR" });
    const b = cand({ carrierCode: 2, status: "InTransit", recipientCountry: "FR" });
    const r = selectCarrierCandidate([a, b], "FR", { previousCarrierCode: 2 });
    expect(r.chosen?.carrierCode).toBe(2);
  });

  it("flags unverified when the chosen candidate has no recipient country", () => {
    const c = cand({ carrierCode: 190271, status: "InTransit", recipientCountry: null });
    const r = selectCarrierCandidate([c], "FR");
    expect(r.chosen?.carrierCode).toBe(190271);
    expect(r.unverified).toBe(true);
  });

  it("returns NotFound (chosen) when only NotFound candidates remain", () => {
    const c = cand({ carrierCode: 14041, status: "NotFound" });
    const r = selectCarrierCandidate([c], "FR");
    expect(r.chosen?.status).toBe("NotFound");
  });

  it("returns null chosen when there are no candidates", () => {
    expect(selectCarrierCandidate([], "FR").chosen).toBeNull();
  });
});
