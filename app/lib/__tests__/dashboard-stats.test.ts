import { describe, it, expect } from "vitest";
import { getPeriodBounds } from "../dashboard-stats";

describe("getPeriodBounds", () => {
  it("retourne 30 jours par défaut", () => {
    const now = new Date("2026-04-25T12:00:00Z");
    const { start, end, prevStart, prevEnd } = getPeriodBounds("30d", undefined, undefined, now);
    expect(end.toISOString()).toBe(now.toISOString());
    expect(start.toISOString()).toBe(new Date("2026-03-26T12:00:00Z").toISOString());
    expect(prevStart.toISOString()).toBe(new Date("2026-02-24T12:00:00Z").toISOString());
    expect(prevEnd.toISOString()).toBe(new Date("2026-03-26T12:00:00Z").toISOString());
  });

  it("retourne 24 heures pour range=24h", () => {
    const now = new Date("2026-04-25T12:00:00Z");
    const { start, end } = getPeriodBounds("24h", undefined, undefined, now);
    const diff = end.getTime() - start.getTime();
    expect(diff).toBe(24 * 60 * 60 * 1000);
  });

  it("retourne 7 jours pour range=7d", () => {
    const now = new Date("2026-04-25T12:00:00Z");
    const { start, end } = getPeriodBounds("7d", undefined, undefined, now);
    const diff = end.getTime() - start.getTime();
    expect(diff).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("retourne 90 jours pour range=90d", () => {
    const now = new Date("2026-04-25T12:00:00Z");
    const { start, end } = getPeriodBounds("90d", undefined, undefined, now);
    const diff = end.getTime() - start.getTime();
    expect(diff).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("utilise les bornes personnalisées quand from/to sont fournis", () => {
    const now = new Date("2026-04-25T12:00:00Z");
    const { start, end } = getPeriodBounds("custom", "2026-04-01", "2026-04-15", now);
    expect(start.toISOString().startsWith("2026-04-01")).toBe(true);
    expect(end.toISOString().startsWith("2026-04-15")).toBe(true);
  });
});
