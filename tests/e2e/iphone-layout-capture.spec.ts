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
import { cleanE2EData, seedSupportThread, db } from './helpers/db';

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
