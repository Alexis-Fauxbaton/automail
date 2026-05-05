// tests/e2e/iphone-layout-capture.spec.ts
//
// Diagnostic-only spec: captures full-page PNG screenshots of the inbox
// in three states across the three projects. The PNGs land in
// tests/e2e/screenshots/<project-name>/ and are NOT assertions —
// they are artifacts the assistant reads to diagnose iOS-Safari-only
// layout bugs.
//
// Run with:
//   npm run test:e2e -- --project=mobile-webkit-iphone tests/e2e/iphone-layout-capture.spec.ts
//   npm run test:e2e -- --project=mobile-chromium-android tests/e2e/iphone-layout-capture.spec.ts
import { test } from '@playwright/test';
import path from 'node:path';
import { cleanE2EData, seedSupportThread, seedMailConnection, db } from './helpers/db';

const SCREENSHOT_DIR = 'tests/e2e/screenshots';

function shotPath(projectName: string, name: string): string {
  return path.join(SCREENSHOT_DIR, projectName, `${name}.png`);
}

test.beforeEach(async () => {
  await cleanE2EData();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('capture: inbox empty', async ({ page }, testInfo) => {
  await page.goto('/app/inbox');
  await page.waitForLoadState('networkidle');
  await page.screenshot({
    path: shotPath(testInfo.project.name, 'inbox-empty'),
    fullPage: true,
  });
});

test('capture: inbox with thread list', async ({ page }, testInfo) => {
  await seedMailConnection();
  await seedSupportThread({ operationalState: 'waiting_merchant' });

  await page.goto('/app/inbox');
  // Wait for the "To handle" tab to appear (assertion-based wait — more
  // reliable than networkidle in a Shopify-embedded App Bridge iframe).
  const toHandleTab = page.getByRole('button', { name: /to handle/i });
  await toHandleTab.waitFor({ state: 'visible' });
  await toHandleTab.click();

  // Wait for the seeded thread to render before capturing.
  await page.getByText('Où est ma commande #TEST-001').waitFor({ state: 'visible' });

  await page.screenshot({
    path: shotPath(testInfo.project.name, 'inbox-with-thread-list'),
    fullPage: true,
  });
});

test('capture: inbox thread detail (mobile full-screen view)', async ({ page }, testInfo) => {
  await seedMailConnection();
  await seedSupportThread({ operationalState: 'waiting_merchant' });

  await page.goto('/app/inbox');
  // Open the "To handle" tab and wait for the seeded thread to appear.
  const toHandleTab = page.getByRole('button', { name: /to handle/i });
  await toHandleTab.waitFor({ state: 'visible' });
  await toHandleTab.click();

  const threadRow = page.getByText('Où est ma commande #TEST-001');
  await threadRow.waitFor({ state: 'visible' });
  await threadRow.click();

  // On mobile (≤768px) the inbox renders a full-screen detail view with a
  // back button. On desktop (chromium project) it shows a sticky side panel
  // — both are valid layouts to capture.
  // Wait for either the mobile back button OR a desktop-only marker so we
  // can capture once the detail view has rendered in either layout.
  await Promise.race([
    page.getByRole('button', { name: /back to (?:inbox|list)/i }).waitFor({ state: 'visible' }),
    page.locator('.ui-detail-panel').waitFor({ state: 'visible' }),
  ]);

  await page.screenshot({
    path: shotPath(testInfo.project.name, 'inbox-thread-detail'),
    fullPage: true,
  });
});
