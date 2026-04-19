/**
 * Per-shop support copilot settings.
 * Stored in Prisma; one row per Shopify shop (shop domain = primary key).
 */

import prisma from "../../db.server";

export type Tone = "friendly" | "formal" | "neutral";
export type Language = "auto" | "fr" | "en";
export type CustomerGreetingStyle = "auto" | "first_name" | "full_name" | "neutral";

export interface SupportSettings {
  shop: string;
  signatureName: string;
  brandName: string;
  tone: Tone;
  language: Language;
  closingPhrase: string;
  shareTrackingNumber: boolean;
  customerGreetingStyle: CustomerGreetingStyle;
  /** Free-text refund / return policy shown to the LLM when handling refund requests. */
  refundPolicy: string;
}

export const DEFAULT_SETTINGS: Omit<SupportSettings, "shop"> = {
  signatureName: "Customer Support",
  brandName: "",
  tone: "friendly",
  language: "auto",
  closingPhrase: "",
  shareTrackingNumber: true,
  customerGreetingStyle: "auto",
  refundPolicy: "",
};

const VALID_TONES: Tone[] = ["friendly", "formal", "neutral"];
const VALID_LANGUAGES: Language[] = ["auto", "fr", "en"];

export async function getSettings(shop: string): Promise<SupportSettings> {
  const row = await prisma.supportSettings.findUnique({ where: { shop } });
  if (!row) return { shop, ...DEFAULT_SETTINGS };
  return {
    shop: row.shop,
    signatureName: row.signatureName,
    brandName: row.brandName,
    tone: (VALID_TONES as string[]).includes(row.tone)
      ? (row.tone as Tone)
      : DEFAULT_SETTINGS.tone,
    language: (VALID_LANGUAGES as string[]).includes(row.language)
      ? (row.language as Language)
      : DEFAULT_SETTINGS.language,
    closingPhrase: row.closingPhrase,
    shareTrackingNumber: row.shareTrackingNumber,
    customerGreetingStyle: (row.customerGreetingStyle as CustomerGreetingStyle) ?? DEFAULT_SETTINGS.customerGreetingStyle,
    refundPolicy: row.refundPolicy ?? "",
  };
}

export interface SaveSettingsInput {
  signatureName: string;
  brandName: string;
  tone: string;
  language: string;
  closingPhrase: string;
  shareTrackingNumber: boolean;
  customerGreetingStyle: string;
  refundPolicy: string;
}

/** Sanitize and persist settings. Unknown tone/language values fall back to defaults. */
export async function saveSettings(
  shop: string,
  input: SaveSettingsInput,
): Promise<SupportSettings> {
  const tone: Tone = VALID_TONES.includes(input.tone as Tone)
    ? (input.tone as Tone)
    : DEFAULT_SETTINGS.tone;
  const language: Language = VALID_LANGUAGES.includes(input.language as Language)
    ? (input.language as Language)
    : DEFAULT_SETTINGS.language;

  const VALID_GREETING_STYLES: CustomerGreetingStyle[] = ["auto", "first_name", "full_name", "neutral"];
  const customerGreetingStyle: CustomerGreetingStyle = VALID_GREETING_STYLES.includes(
    input.customerGreetingStyle as CustomerGreetingStyle,
  )
    ? (input.customerGreetingStyle as CustomerGreetingStyle)
    : DEFAULT_SETTINGS.customerGreetingStyle;

  const data = {
    signatureName: input.signatureName.trim().slice(0, 80) || DEFAULT_SETTINGS.signatureName,
    brandName: input.brandName.trim().slice(0, 80),
    tone,
    language,
    closingPhrase: input.closingPhrase.trim().slice(0, 120),
    shareTrackingNumber: input.shareTrackingNumber,
    customerGreetingStyle,
    refundPolicy: input.refundPolicy.trim().slice(0, 2000),
  };

  const row = await prisma.supportSettings.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });

  return {
    shop: row.shop,
    signatureName: row.signatureName,
    brandName: row.brandName,
    tone: row.tone as Tone,
    language: row.language as Language,
    closingPhrase: row.closingPhrase,
    shareTrackingNumber: row.shareTrackingNumber,
    customerGreetingStyle: (row.customerGreetingStyle as CustomerGreetingStyle) ?? DEFAULT_SETTINGS.customerGreetingStyle,
    refundPolicy: row.refundPolicy ?? "",
  };
}
