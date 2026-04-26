// E2E tests for the settings page.
//
// REQ-SET-02: tone setting saved to DB
// REQ-SET-04: saved settings take effect immediately (reflected in UI on reload)

import { test, expect } from '@playwright/test';
import { db, E2E_SHOP } from './helpers/db';

test.afterAll(async () => {
  await db.$disconnect();
});

test('modification du ton → sauvegardé en DB (REQ-SET-02, REQ-SET-04)', async ({ page }) => {
  await page.goto('/app/settings');

  // s-select renders a native <select> in its shadow DOM — pierce it
  const toneSelect = page.locator('s-select[name="tone"]').locator('select');
  await toneSelect.selectOption('formal');

  // Click the save button (s-button with type="submit" contains a native <button>)
  await page.locator('s-button[type="submit"]').click();

  // UI should confirm the save
  await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 5000 });

  // DB must reflect the change
  const settings = await db.supportSettings.findUnique({ where: { shop: E2E_SHOP } });
  expect(settings?.tone).toBe('formal');
});

test('paramètres rechargés après save (REQ-SET-04)', async ({ page }) => {
  await page.goto('/app/settings');

  const toneSelect = page.locator('s-select[name="tone"]').locator('select');
  await toneSelect.selectOption('formal');
  await page.locator('s-button[type="submit"]').click();
  await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 5000 });

  // Reload and verify the tone is still "formal"
  await page.reload();
  await page.waitForLoadState('networkidle');

  // The select should reflect the saved value
  const savedValue = await page.locator('s-select[name="tone"]').locator('select').inputValue();
  expect(savedValue).toBe('formal');
});
