// E2E tests for the draft editor and attachments.
//
// REQ-INBOX-07: draft is displayed in the editor and can be saved
// REQ-INBOX-11: attachments — 2 KB accepted, > 10 MB rejected with error

import { test, expect } from '@playwright/test';
import { cleanE2EData, seedSupportThread, db } from './helpers/db';

test.beforeEach(async () => {
  await cleanE2EData();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('draft existant s\'affiche dans l\'éditeur (REQ-INBOX-07)', async ({ page }) => {
  await seedSupportThread({
    operationalState: 'waiting_merchant',
    draftBody: 'Bonjour, votre commande TEST-001 est en cours de livraison.',
  });

  await page.goto('/app/inbox');
  await page.getByRole('button', { name: 'To handle' }).click();
  await page.getByText('Où est ma commande #TEST-001').click();

  // The draft body should be visible in the s-text-area labelled "Editable draft"
  const draftArea = page.locator('s-text-area').filter({ hasText: /editable draft/i }).or(
    page.locator('s-text-area[label="Editable draft"]')
  );
  await expect(draftArea.locator('textarea').or(page.getByLabel('Editable draft'))).toContainText('commande TEST-001');
});

test('édition manuelle du draft est sauvegardée (REQ-INBOX-07)', async ({ page }) => {
  const { email } = await seedSupportThread({
    operationalState: 'waiting_merchant',
    draftBody: 'Draft initial.',
  });

  await page.goto('/app/inbox');
  await page.getByRole('button', { name: 'To handle' }).click();
  await page.getByText('Où est ma commande #TEST-001').click();

  // Fill the draft via shadow DOM textarea
  const textarea = page.locator('s-text-area[label="Editable draft"]').locator('textarea');
  await textarea.fill('Draft modifié manuellement.');

  // Wait for autosave debounce (800ms + margin)
  await page.waitForTimeout(1500);

  // Verify persistence in DB
  const draft = await db.replyDraft.findUnique({ where: { emailId: email.id } });
  expect(draft?.body).toBe('Draft modifié manuellement.');
});

test('upload pièce jointe 2 KB → nom affiché (REQ-INBOX-11)', async ({ page }) => {
  await seedSupportThread({ operationalState: 'waiting_merchant', draftBody: 'Draft.' });

  await page.goto('/app/inbox');
  await page.getByRole('button', { name: 'To handle' }).click();
  await page.getByText('Où est ma commande #TEST-001').click();

  const fileContent = Buffer.alloc(2048, 'a');
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /ajouter une pj/i }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'test-attachment.txt',
    mimeType: 'text/plain',
    buffer: fileContent,
  });

  await expect(page.getByText('test-attachment.txt')).toBeVisible({ timeout: 5000 });
});

test('upload fichier > 10 MB → message d\'erreur (REQ-INBOX-11)', async ({ page }) => {
  await seedSupportThread({ operationalState: 'waiting_merchant', draftBody: 'Draft.' });

  await page.goto('/app/inbox');
  await page.getByRole('button', { name: 'To handle' }).click();
  await page.getByText('Où est ma commande #TEST-001').click();

  const fileContent = Buffer.alloc(11 * 1024 * 1024, 'a');
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /ajouter une pj/i }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'too-big.txt',
    mimeType: 'text/plain',
    buffer: fileContent,
  });

  await expect(page.locator('[data-testid="attachment-error"]')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-testid="attachment-error"]')).toContainText(/10 MB|too large/i);
});
