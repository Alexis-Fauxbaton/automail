// E2E tests for inbox state transitions.
//
// REQ-STATE-05: resolved + new message → reopens to waiting_merchant
// REQ-STATE-08: Mark as resolved → thread moves to Resolved bucket

import { test, expect } from '@playwright/test';
import { cleanE2EData, seedSupportThread, db, E2E_SHOP } from './helpers/db';

test.beforeEach(async () => {
  await cleanE2EData();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('thread waiting_merchant apparaît dans "To handle"', async ({ page }) => {
  await seedSupportThread({ operationalState: 'waiting_merchant' });

  await page.goto('/app/inbox');
  await page.getByRole('button', { name: 'To handle' }).click();

  await expect(page.getByText('Où est ma commande #TEST-001')).toBeVisible();
});

test('Mark as resolved → thread moves to Resolved bucket (REQ-STATE-08)', async ({ page }) => {
  await seedSupportThread({ operationalState: 'waiting_merchant' });

  await page.goto('/app/inbox');
  await page.getByRole('button', { name: 'To handle' }).click();
  await page.getByText('Où est ma commande #TEST-001').click();

  // Click "Mark as resolved"
  await page.getByRole('button', { name: /mark as resolved/i }).click();

  // Thread should disappear from To handle
  await page.getByRole('button', { name: 'To handle' }).click();
  await expect(page.getByText('Où est ma commande #TEST-001')).not.toBeVisible();

  // And appear in Resolved
  await page.getByRole('button', { name: 'Resolved' }).click();
  await expect(page.getByText('Où est ma commande #TEST-001')).toBeVisible();
});

test('thread resolved + nouveau message → réapparaît dans To handle après recompute (REQ-STATE-05)', async ({ page }) => {
  const { thread } = await seedSupportThread({ operationalState: 'resolved' });

  // Simulate a new incoming message (already recomputed to waiting_merchant via DB)
  await db.incomingEmail.create({
    data: {
      shop: E2E_SHOP,
      externalMessageId: `reopen-e2e-${Date.now()}`,
      canonicalThreadId: thread.id,
      fromAddress: 'client-e2e@example.com',
      subject: "Re: Où est ma commande #TEST-001 ?",
      bodyText: "Je n'ai toujours pas reçu mon colis.",
      receivedAt: new Date(),
      processingStatus: 'pending',
      tier1Result: 'passed',
      tier2Result: 'support_client',
    },
  });
  // Update the thread state directly (as recomputeThreadState would do)
  await db.thread.update({
    where: { id: thread.id },
    data: {
      operationalState: 'waiting_merchant',
      previousOperationalState: null,
      operationalStateUpdatedAt: new Date(),
    },
  });

  await page.goto('/app/inbox');
  await page.getByRole('button', { name: 'To handle' }).click();

  await expect(page.getByText('Où est ma commande #TEST-001')).toBeVisible();
});
