import { describe, it, expect } from "vitest";
import { normalizeBody, computeSimilarity, classifyDraft } from "../draft-usage-heuristic";

describe("normalizeBody", () => {
  it("strips HTML tags", () => {
    expect(normalizeBody("<p>Bonjour <b>Jean</b></p>")).toBe("bonjour jean");
  });

  it("strips French quoted text (Le X a écrit :)", () => {
    const input = "Ma réponse\n\nLe 01/05/2026, Client a écrit :\n> bonjour";
    expect(normalizeBody(input)).toBe("ma reponse");
  });

  it("strips quoted lines starting with >", () => {
    expect(normalizeBody("Voici ma réponse\n> Ligne citée")).toBe("voici ma reponse");
  });

  it("strips signature after --", () => {
    expect(normalizeBody("Corps du message\n--\nCordialement,\nSupport")).toBe("corps du message");
  });

  it("lowercases and strips accents", () => {
    expect(normalizeBody("Éàü")).toBe("eau");
  });

  it("normalizes whitespace", () => {
    expect(normalizeBody("  foo   bar  ")).toBe("foo bar");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeBody("")).toBe("");
  });
});

describe("computeSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(computeSimilarity("hello world", "hello world")).toBe(1);
  });

  it("returns 1 for two empty strings", () => {
    expect(computeSimilarity("", "")).toBe(1);
  });

  it("returns 0 when one string is empty and other is not", () => {
    expect(computeSimilarity("hello", "")).toBe(0);
    expect(computeSimilarity("", "hello")).toBe(0);
  });

  it("returns high similarity for minor edits", () => {
    expect(computeSimilarity("bonjour monsieur", "bonjour monsieur!")).toBeGreaterThan(0.9);
  });

  it("returns low similarity for very different strings", () => {
    expect(computeSimilarity("aaa", "zzz")).toBe(0);
  });
});

describe("classifyDraft", () => {
  it("returns as_is when normalized similarity >= 0.85", () => {
    const text = "merci pour votre message nous allons traiter votre demande";
    expect(classifyDraft(text, text + "!")).toBe("as_is");
  });

  it("returns ignored when similarity < 0.30", () => {
    const draft = "merci pour votre patience";
    const outgoing = "xyzzy lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempus";
    expect(classifyDraft(draft, outgoing)).toBe("ignored");
  });

  it("returns as_is for identical bodies", () => {
    const text = "Bonjour, votre commande est en cours.";
    expect(classifyDraft(text, text)).toBe("as_is");
  });
});
