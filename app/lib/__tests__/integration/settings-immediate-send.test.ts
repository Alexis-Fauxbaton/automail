import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getSettings, saveSettings } from "../../support/settings";
import { resetTestDb, disconnectTestDb, TEST_SHOP } from "./helpers/db";

const baseInput = {
  signatureName: "Support",
  brandName: "Brand",
  tone: "friendly",
  language: "auto",
  closingPhrase: "",
  shareTrackingNumber: true,
  customerGreetingStyle: "auto",
  refundPolicy: "",
};

describe("settings immediateSend", () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("defaults to false when no row exists", async () => {
    const s = await getSettings(TEST_SHOP);
    expect(s.immediateSend).toBe(false);
  });

  it("round-trips true through save and get", async () => {
    await saveSettings(TEST_SHOP, { ...baseInput, immediateSend: true });
    const s = await getSettings(TEST_SHOP);
    expect(s.immediateSend).toBe(true);
  });

  it("round-trips false through save and get", async () => {
    await saveSettings(TEST_SHOP, { ...baseInput, immediateSend: true });
    await saveSettings(TEST_SHOP, { ...baseInput, immediateSend: false });
    const s = await getSettings(TEST_SHOP);
    expect(s.immediateSend).toBe(false);
  });
});
