// E2E tests for the dashboard.
//
// REQ-DASH-05: bar chart is visible
// REQ-DASH-11: preset switch recalculates KPIs
// REQ-DASH-13: empty state — all KPIs show 0 without error

import { test, expect } from '@playwright/test';
import { cleanE2EData, db, E2E_SHOP } from './helpers/db';

test.beforeEach(async () => {
  await cleanE2EData();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('dashboard affiche les KPIs à 0 quand il n\'y a pas de données (REQ-DASH-13)', async ({ page }) => {
  await page.goto('/app/dashboard');

  await expect(page.getByText(/dashboard/i).first()).toBeVisible();

  // KPI "Mails reçus" should show 0
  const mailsRecusCard = page.locator('.ui-metric').filter({ hasText: 'Mails reçus' });
  await expect(mailsRecusCard.locator('.ui-metric__value')).toContainText('0');

  // No error on the page
  await expect(page.locator('[data-error]')).not.toBeVisible();
});

test('bar chart quotidien est présent (REQ-DASH-05)', async ({ page }) => {
  await page.goto('/app/dashboard');

  // Click the 7 jours preset to ensure the chart loads
  await page.getByRole('button', { name: '7 jours' }).click();
  await page.waitForLoadState('networkidle');

  await expect(page.locator('[data-testid="chart-daily-breakdown"]')).toBeVisible();
});

test('changement de preset 7 jours → 30 jours recalcule les KPIs (REQ-DASH-11)', async ({ page }) => {
  // Insert one email 20 days ago (outside 7d, inside 30d)
  const thread = await db.thread.create({
    data: {
      shop: E2E_SHOP,
      provider: 'gmail',
      lastMessageAt: new Date(),
      firstMessageAt: new Date(),
      operationalStateUpdatedAt: new Date(),
      operationalState: 'waiting_merchant',
      supportNature: 'confirmed_support',
      historyStatus: 'complete',
    },
  });
  await db.incomingEmail.create({
    data: {
      shop: E2E_SHOP,
      externalMessageId: `dash-e2e-${Date.now()}`,
      canonicalThreadId: thread.id,
      fromAddress: 'a@b.com',
      subject: 'Test',
      bodyText: 'Corps',
      receivedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      processingStatus: 'analyzed',
    },
  });

  await page.goto('/app/dashboard');

  // Select 7 jours — the email (20 days old) is outside this period
  await page.getByRole('button', { name: '7 jours' }).click();
  await page.waitForLoadState('networkidle');
  const kpi7d = await page
    .locator('.ui-metric').filter({ hasText: 'Mails reçus' })
    .locator('.ui-metric__value')
    .textContent();

  // Select 30 jours — the email is now within the period
  await page.getByRole('button', { name: '30 jours' }).click();
  await page.waitForLoadState('networkidle');
  const kpi30d = await page
    .locator('.ui-metric').filter({ hasText: 'Mails reçus' })
    .locator('.ui-metric__value')
    .textContent();

  // The two values must differ
  expect(kpi7d).not.toBe(kpi30d);
});
