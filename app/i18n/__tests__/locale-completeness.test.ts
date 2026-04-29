import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import fr from "../locales/fr.json";

function getLeafKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const full = prefix ? `${prefix}.${k}` : k;
    return typeof v === "object" && v !== null
      ? getLeafKeys(v as Record<string, unknown>, full)
      : [full];
  });
}

describe("locale completeness", () => {
  it("fr.json has every key that en.json has", () => {
    const enKeys = getLeafKeys(en).sort();
    const frKeys = getLeafKeys(fr).sort();
    const missing = enKeys.filter((k) => !frKeys.includes(k));
    expect(missing, `Keys missing from fr.json: ${missing.join(", ")}`).toEqual([]);
  });

  it("en.json has every key that fr.json has", () => {
    const enKeys = getLeafKeys(en).sort();
    const frKeys = getLeafKeys(fr).sort();
    const extra = frKeys.filter((k) => !enKeys.includes(k));
    expect(extra, `Keys in fr.json not in en.json: ${extra.join(", ")}`).toEqual([]);
  });
});
