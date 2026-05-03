// tests/e2e/mobile.spec.ts
import { test, expect } from '@playwright/test';
import { cleanE2EData, seedSupportThread, db } from './helpers/db';

const MOBILE_VIEWPORT = { width: 375, height: 812 };

test.beforeEach(async ({ page }) => {
  await cleanE2EData();
  await page.setViewportSize(MOBILE_VIEWPORT);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('inbox list has no horizontal scroll on mobile', async ({ page }) => {
  await page.goto('/app/inbox');

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);

  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2); // 2px tolerance
});

test('filter tabs fit on one line (no wrap) on mobile', async ({ page }) => {
  await page.goto('/app/inbox');

  await expect(page.getByRole('button', { name: /to handle/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /resolved/i })).toBeVisible();

  const tabsBox = await page.locator('.ui-tabs').first().boundingBox();
  expect(tabsBox).not.toBeNull();
  expect(tabsBox!.width).toBeLessThanOrEqual(375);
});

test('clicking a thread on mobile shows full-screen detail with back button', async ({ page }) => {
  await seedSupportThread({ operationalState: 'waiting_merchant' });

  await page.goto('/app/inbox');
  await page.getByRole('button', { name: 'To handle' }).click();
  await page.getByText('Où est ma commande #TEST-001').click();

  await expect(page.getByRole('button', { name: /back to inbox/i })).toBeVisible();
});

test('back button returns to inbox list on mobile', async ({ page }) => {
  await seedSupportThread({ operationalState: 'waiting_merchant' });

  await page.goto('/app/inbox');
  await page.getByRole('button', { name: 'To handle' }).click();
  await page.getByText('Où est ma commande #TEST-001').click();

  await page.getByRole('button', { name: /back to inbox/i }).click();

  await expect(page.getByRole('button', { name: 'To handle' })).toBeVisible();
});

test('stats cards appear in 2-column grid on mobile', async ({ page }) => {
  await page.goto('/app/inbox');

  const cards = page.locator('.ui-grid-4 .ui-card');
  const count = await cards.count();
  if (count >= 2) {
    const box0 = await cards.nth(0).boundingBox();
    const box1 = await cards.nth(1).boundingBox();
    expect(Math.abs(box0!.y - box1!.y)).toBeLessThanOrEqual(2);
  }
});

test('dashboard has no horizontal scroll on mobile', async ({ page }) => {
  await page.goto('/app/dashboard');

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);

  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
});
