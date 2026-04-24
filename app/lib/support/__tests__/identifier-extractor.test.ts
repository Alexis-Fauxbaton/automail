import { describe, it, expect } from "vitest";
import { extractIdentifiers } from "../identifier-extractor";
import { parseMessage } from "../message-parser";

function extract(subject: string, body: string) {
  return extractIdentifiers(parseMessage(subject, body));
}

describe("extractIdentifiers", () => {
  // --- Order number ---
  it("extracts order number with # in subject", () => {
    expect(extract("#1234", "")).toMatchObject({ orderNumber: "1234" });
  });

  it("extracts order number with # in body", () => {
    expect(extract("", "my order #5678 hasn't arrived")).toMatchObject({ orderNumber: "5678" });
  });

  it("extracts order number with 'order' keyword", () => {
    expect(extract("", "order 9012 is late")).toMatchObject({ orderNumber: "9012" });
  });

  it("extracts order number with 'commande' keyword", () => {
    expect(extract("", "ma commande 3456 n'est pas arrivée")).toMatchObject({ orderNumber: "3456" });
  });

  it("extracts order number with n° notation", () => {
    expect(extract("", "n°7890 est en retard")).toMatchObject({ orderNumber: "7890" });
  });

  it("does not extract order numbers shorter than 3 digits", () => {
    expect(extract("", "order #12")).not.toHaveProperty("orderNumber");
  });

  it("prefers #-prefixed over keyword match", () => {
    // Both forms present — # wins
    expect(extract("", "order 1111 but also #2222")).toMatchObject({ orderNumber: "2222" });
  });

  // --- Email ---
  it("extracts email address", () => {
    expect(extract("", "contact me at john@example.com please")).toMatchObject({
      email: "john@example.com",
    });
  });

  it("lowercases email", () => {
    expect(extract("", "email: TEST@EXAMPLE.COM")).toMatchObject({
      email: "test@example.com",
    });
  });

  it("does not extract malformed email", () => {
    expect(extract("", "contact notanemail please")).not.toHaveProperty("email");
  });

  // --- Tracking number ---
  it("extracts tracking number with keyword", () => {
    expect(extract("", "tracking: AB123456789CD")).toMatchObject({
      trackingNumber: "AB123456789CD",
    });
  });

  it("extracts tracking number with 'suivi' keyword", () => {
    expect(extract("", "n° de suivi: 1234567890123")).toMatchObject({
      trackingNumber: "1234567890123",
    });
  });

  it("extracts UPS tracking number without keyword", () => {
    expect(extract("", "1Z999AA10123456784")).toMatchObject({
      trackingNumber: "1Z999AA10123456784",
    });
  });

  it("extracts 13-digit carrier tracking without keyword", () => {
    expect(extract("", "my colissimo is 6123456789012")).toMatchObject({
      trackingNumber: "6123456789012",
    });
  });

  it("extracts 13-digit number as tracking (not confused with order)", () => {
    // ORDER_WITH_KEYWORD is limited to 3-10 digits, so a 13-digit number written
    // after "order" will NOT be captured as an order number — only as tracking.
    const result = extract("", "order 6123456789012 where is it");
    expect(result.orderNumber).toBeUndefined();
    expect(result.trackingNumber).toBe("6123456789012");
  });

  it("prefers keyword-matched tracking over carrier pattern", () => {
    expect(
      extract("", "tracking: MYTRACKING123 and also 6123456789012"),
    ).toMatchObject({ trackingNumber: "MYTRACKING123" });
  });

  // --- Customer name ---
  it("extracts customer name from 'my name is'", () => {
    expect(extract("", "Hi, my name is Jean Dupont")).toMatchObject({
      customerName: "Jean Dupont",
    });
  });

  it("extracts customer name from 'Je m'appelle' (sentence case)", () => {
    expect(extract("", "Je m'appelle Marie Martin")).toMatchObject({
      customerName: "Marie Martin",
    });
  });

  it("extracts single-word name from 'I am'", () => {
    const result = extract("", "I am Pierre");
    expect(result.customerName).toBe("Pierre");
  });

  // --- 13-digit numbers: cannot be both order number and tracking number ---
  it("13-digit number with # prefix is NOT captured as order number (regex limit is 10 digits)", () => {
    // ORDER_WITH_HASH = /\d{3,10}/ — intentionally capped at 10 digits to avoid
    // conflating tracking numbers with Shopify order numbers. A 13-digit # value
    // is therefore captured only as a carrier tracking number, never an orderNumber.
    const result = extract("#6123456789012", "my order #6123456789012 has not arrived");
    expect(result.orderNumber).toBeUndefined();
    expect(result.trackingNumber).toBe("6123456789012");
  });

  // --- Curly apostrophe (iOS/Mac Unicode) ---
  it("extracts name with curly apostrophe from iOS/Mac email client", () => {
    expect(extract("", "je m’appelle Jean Dupont")).toMatchObject({ customerName: "Jean Dupont" });
  });

  // --- Empty / combined ---
  it("returns empty object on empty input", () => {
    expect(extract("", "")).toEqual({});
  });

  it("extracts all fields when all are present", () => {
    const result = extract(
      "#1234",
      "My name is Jean Dupont, email: jean@example.com. Tracking: 1Z999AA10123456784",
    );
    expect(result.orderNumber).toBe("1234");
    expect(result.email).toBe("jean@example.com");
    expect(result.trackingNumber).toBe("1Z999AA10123456784");
    expect(result.customerName).toBe("Jean Dupont");
  });
});
