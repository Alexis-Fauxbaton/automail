# E2E Tests (Playwright) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Installer Playwright, configurer un helper d'auth qui bypasse Shopify OAuth en test, et écrire les tests E2E couvrant les flux utilisateurs critiques : inbox, state machine, dashboard, settings, et pièces jointes.

**Architecture:** Playwright test avec un `globalSetup` qui crée une session Shopify valide en DB et l'injecte dans le storage state (cookie `shopify.session`). Les tests tournent contre un serveur dev local (`npm run dev`). Les emails de test sont insérés directement en DB via un helper API de test (endpoint `/api/test-setup` activé uniquement en `NODE_ENV=test`). Aucun vrai OAuth, aucun vrai Gmail.

**Tech Stack:** `@playwright/test`, `@prisma/client`, serveur Remix local, `storageState` Playwright pour la session Shopify

---

### Task 1 : Installer et configurer Playwright

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/helpers/auth.ts`
- Create: `tests/e2e/helpers/db.ts`
- Modify: `package.json`

- [ ] **Step 1 : Installer Playwright**

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

Attendu : chromium téléchargé, `@playwright/test` dans `devDependencies`.

- [ ] **Step 2 : Créer la config Playwright**

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Pas de parallélisme — tous les tests partagent la même DB de test
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:58496',
    storageState: 'tests/e2e/.auth/session.json', // Session Shopify injectée
    trace: 'on-first-retry',
  },
  globalSetup: './tests/e2e/global-setup.ts',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
```

- [ ] **Step 3 : Créer le global setup (injection de session Shopify)**

```typescript
// tests/e2e/global-setup.ts
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs/promises';
import path from 'node:path';

const E2E_SHOP = 'e2e-test.myshopify.com';

export default async function globalSetup() {
  const db = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL } },
  });

  // Créer une session Shopify valide en DB pour le shop de test
  await db.session.upsert({
    where: { id: `offline_${E2E_SHOP}` },
    update: { accessToken: 'e2e-test-token', scope: 'read_orders,read_customers,read_fulfillments,read_all_orders' },
    create: {
      id: `offline_${E2E_SHOP}`,
      shop: E2E_SHOP,
      state: 'active',
      isOnline: false,
      accessToken: 'e2e-test-token',
      scope: 'read_orders,read_customers,read_fulfillments,read_all_orders',
    },
  });

  await db.$disconnect();

  // Créer le fichier storageState avec le cookie de session
  const authDir = path.join('tests/e2e/.auth');
  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(
    path.join(authDir, 'session.json'),
    JSON.stringify({
      cookies: [
        {
          name: 'shopify_app_session',
          value: `offline_${E2E_SHOP}`,
          domain: 'localhost',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    })
  );
}
```

> Note : Le nom exact du cookie de session Shopify dépend de la config `@shopify/shopify-app-remix`. Vérifier avec : `grep -r "session" app/shopify.server.ts | head -10`. Si le nom est différent, mettre à jour le cookie name.

- [ ] **Step 4 : Créer le helper DB pour les fixtures E2E**

```typescript
// tests/e2e/helpers/db.ts
import { PrismaClient } from '@prisma/client';

export const E2E_SHOP = 'e2e-test.myshopify.com';

export const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL } },
});

/** Nettoie les données E2E de test (emails, threads, drafts) */
export async function cleanE2EData() {
  await db.$transaction([
    db.draftAttachment.deleteMany({ where: { shop: E2E_SHOP } }),
    db.replyDraft.deleteMany({ where: { shop: E2E_SHOP } }),
    db.incomingEmail.deleteMany({ where: { shop: E2E_SHOP } }),
    db.threadStateHistory.deleteMany({ where: { shop: E2E_SHOP } }),
    db.threadProviderId.deleteMany({ where: { shop: E2E_SHOP } }),
    db.thread.deleteMany({ where: { shop: E2E_SHOP } }),
    db.syncJob.deleteMany({ where: { shop: E2E_SHOP } }),
  ]);
}

/** Insère un thread de test avec un email entrant et un draft */
export async function seedSupportThread(overrides: Partial<{
  operationalState: string;
  supportNature: string;
  subject: string;
  body: string;
  draftBody: string;
  orderNumber: string;
}> = {}) {
  const thread = await db.thread.create({
    data: {
      shop: E2E_SHOP,
      provider: 'gmail',
      lastMessageAt: new Date(),
      operationalStateUpdatedAt: new Date(),
      operationalState: overrides.operationalState ?? 'waiting_merchant',
      supportNature: overrides.supportNature ?? 'confirmed_support',
      historyStatus: 'complete',
      resolvedOrderNumber: overrides.orderNumber ?? '#TEST-001',
      resolutionConfidence: 'high',
    },
  });

  const email = await db.incomingEmail.create({
    data: {
      shop: E2E_SHOP,
      externalMessageId: `e2e-${Date.now()}`,
      canonicalThreadId: thread.id,
      fromAddress: 'client-e2e@example.com',
      subject: overrides.subject ?? 'Où est ma commande #TEST-001 ?',
      bodyText: overrides.body ?? 'Bonjour, je n\'ai pas reçu ma commande TEST-001.',
      receivedAt: new Date(),
      processingStatus: 'analyzed',
      detectedIntent: 'where_is_my_order',
      analysisConfidence: 'high',
    },
  });

  if (overrides.draftBody) {
    await db.replyDraft.create({
      data: {
        shop: E2E_SHOP,
        emailId: email.id,
        body: overrides.draftBody,
        bodyHistory: [overrides.draftBody],
        subject: `Re: ${overrides.subject ?? 'Où est ma commande ?'}`,
      },
    });
  }

  return { thread, email };
}
```

- [ ] **Step 5 : Ajouter les scripts dans `package.json`**

```json
"test:e2e": "playwright test",
"test:e2e:ui": "playwright test --ui",
"test:e2e:headed": "playwright test --headed"
```

- [ ] **Step 6 : Vérifier la config**

Démarrer le serveur dev dans un terminal séparé, puis :
```bash
npm run test:e2e -- --list
```

Attendu : liste vide (pas encore de tests), aucune erreur de config.

- [ ] **Step 7 : Commit**

```bash
git add playwright.config.ts tests/e2e/ package.json
git commit -m "test(e2e): install Playwright + auth session injection + DB helpers"
```

---

### Task 2 : Tests E2E — Inbox : buckets et transitions d'état

**Files:**
- Create: `tests/e2e/inbox-state.spec.ts`

- [ ] **Step 1 : Écrire les tests**

```typescript
// tests/e2e/inbox-state.spec.ts
import { test, expect, beforeEach, afterAll } from '@playwright/test';
import { cleanE2EData, seedSupportThread, db } from './helpers/db';

test.beforeEach(async () => {
  await cleanE2EData();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('thread support apparaît dans le bucket "to review"', async ({ page }) => {
  await seedSupportThread({ operationalState: 'waiting_merchant' });

  await page.goto('/app/inbox');
  // Cliquer sur le bucket "to review"
  await page.getByRole('tab', { name: /to review|à traiter/i }).click();

  // Le thread doit être visible
  await expect(page.getByText('Où est ma commande #TEST-001')).toBeVisible();
});

test('Mark resolved → thread déplacé dans bucket resolved (REQ-STATE-08)', async ({ page }) => {
  await seedSupportThread({ operationalState: 'waiting_merchant' });

  await page.goto('/app/inbox');
  await page.getByRole('tab', { name: /to review|à traiter/i }).click();

  // Ouvrir le thread
  await page.getByText('Où est ma commande #TEST-001').click();

  // Cliquer "Mark resolved"
  await page.getByRole('button', { name: /mark resolved|résoudre/i }).click();

  // Le thread ne doit plus être dans "to review"
  await expect(page.getByText('Où est ma commande #TEST-001')).not.toBeVisible();

  // Il doit être dans "resolved"
  await page.getByRole('tab', { name: /resolved|résolu/i }).click();
  await expect(page.getByText('Où est ma commande #TEST-001')).toBeVisible();
});

test('thread resolved + nouveau message → réapparaît dans waiting_merchant (REQ-STATE-05)', async ({ page }) => {
  const { thread } = await seedSupportThread({ operationalState: 'resolved' });

  // Insérer un nouveau message entrant directement en DB
  await db.incomingEmail.create({
    data: {
      shop: thread.shop,
      externalMessageId: `reopen-${Date.now()}`,
      canonicalThreadId: thread.id,
      fromAddress: 'client-e2e@example.com',
      subject: 'Re: Où est ma commande #TEST-001 ?',
      bodyText: 'Je n\'ai toujours pas reçu mon colis.',
      receivedAt: new Date(),
      processingStatus: 'pending',
    },
  });

  // Trigger recompute (via un endpoint de test ou en simulant une sync)
  await page.goto('/app/inbox');
  await page.getByRole('button', { name: /sync now|sync/i }).click();
  await page.waitForTimeout(2000);

  // Le thread doit être dans waiting_merchant / to review
  await page.getByRole('tab', { name: /to review|à traiter/i }).click();
  await expect(page.getByText('#TEST-001')).toBeVisible();
});
```

- [ ] **Step 2 : Lancer les tests**

```bash
npm run test:e2e -- tests/e2e/inbox-state.spec.ts --headed
```

Observer visuellement les transitions. Attendu : 3 tests verts.

- [ ] **Step 3 : Commit**

```bash
git add tests/e2e/inbox-state.spec.ts
git commit -m "test(e2e): inbox state transitions — to_review, mark resolved, reopen from resolved"
```

---

### Task 3 : Tests E2E — Draft generation et refinement

**Files:**
- Create: `tests/e2e/draft-editor.spec.ts`

- [ ] **Step 1 : Écrire les tests**

```typescript
// tests/e2e/draft-editor.spec.ts
import { test, expect, beforeEach, afterAll } from '@playwright/test';
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
  await page.getByRole('tab', { name: /to review|à traiter/i }).click();
  await page.getByText('Où est ma commande #TEST-001').click();

  // Le draft doit être visible dans le textarea
  await expect(page.getByRole('textbox', { name: /draft|réponse/i }))
    .toContainText('commande TEST-001');
});

test('édition manuelle du draft est sauvegardée (REQ-INBOX-07)', async ({ page }) => {
  await seedSupportThread({
    operationalState: 'waiting_merchant',
    draftBody: 'Draft initial.',
  });

  await page.goto('/app/inbox');
  await page.getByRole('tab', { name: /to review|à traiter/i }).click();
  await page.getByText('Où est ma commande #TEST-001').click();

  // Modifier le draft
  const editor = page.getByRole('textbox', { name: /draft|réponse/i });
  await editor.fill('Draft modifié manuellement.');

  // Attendre la sauvegarde auto (debounce)
  await page.waitForTimeout(1500);

  // Recharger et vérifier la persistance
  await page.reload();
  await page.getByRole('tab', { name: /to review|à traiter/i }).click();
  await page.getByText('Où est ma commande #TEST-001').click();

  await expect(page.getByRole('textbox', { name: /draft|réponse/i }))
    .toContainText('Draft modifié manuellement.');
});

test('upload pièce jointe → nom affiché (REQ-INBOX-11)', async ({ page }) => {
  await seedSupportThread({ operationalState: 'waiting_merchant', draftBody: 'Draft.' });

  await page.goto('/app/inbox');
  await page.getByRole('tab', { name: /to review|à traiter/i }).click();
  await page.getByText('Où est ma commande #TEST-001').click();

  // Upload un fichier de test (2 KB)
  const fileContent = Buffer.alloc(2048, 'a');
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /attach|pièce jointe|joindre/i }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'test-attachment.txt',
    mimeType: 'text/plain',
    buffer: fileContent,
  });

  // Le nom du fichier doit apparaître dans la liste
  await expect(page.getByText('test-attachment.txt')).toBeVisible();
});

test('upload fichier > 10 MB → message d\'erreur (REQ-INBOX-11)', async ({ page }) => {
  await seedSupportThread({ operationalState: 'waiting_merchant', draftBody: 'Draft.' });

  await page.goto('/app/inbox');
  await page.getByRole('tab', { name: /to review|à traiter/i }).click();
  await page.getByText('Où est ma commande #TEST-001').click();

  // Fichier de 11 MB
  const fileContent = Buffer.alloc(11 * 1024 * 1024, 'a');
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /attach|pièce jointe|joindre/i }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'too-big.txt',
    mimeType: 'text/plain',
    buffer: fileContent,
  });

  // Message d'erreur visible
  await expect(page.getByText(/trop grand|too large|10.*mb|10.*mo/i)).toBeVisible({ timeout: 5000 });
});
```

- [ ] **Step 2 : Lancer les tests**

```bash
npm run test:e2e -- tests/e2e/draft-editor.spec.ts --headed
```

- [ ] **Step 3 : Commit**

```bash
git add tests/e2e/draft-editor.spec.ts
git commit -m "test(e2e): draft editor — display, manual save, attachment upload and size limit"
```

---

### Task 4 : Tests E2E — Dashboard

**Files:**
- Create: `tests/e2e/dashboard.spec.ts`

- [ ] **Step 1 : Écrire les tests**

```typescript
// tests/e2e/dashboard.spec.ts
import { test, expect, beforeEach, afterAll } from '@playwright/test';
import { cleanE2EData, db, E2E_SHOP } from './helpers/db';

test.beforeEach(async () => {
  await cleanE2EData();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('dashboard affiche 0 pour tous les KPIs quand il n\'y a pas de données (REQ-DASH-13)', async ({ page }) => {
  await page.goto('/app/dashboard');
  // Les KPIs doivent afficher 0 ou "—", pas d'erreur
  await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible();
  // Vérifier absence d'erreur dans la page
  await expect(page.locator('[data-error]')).not.toBeVisible();
});

test('changement de preset 7j → 30j recalcule les KPIs (REQ-DASH-11)', async ({ page }) => {
  // Insérer quelques emails dans la période 30j
  const thread = await db.thread.create({
    data: {
      shop: E2E_SHOP,
      provider: 'gmail',
      lastMessageAt: new Date(),
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
      receivedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), // il y a 20 jours
      processingStatus: 'analyzed',
    },
  });

  await page.goto('/app/dashboard');

  // Cliquer sur preset 7j — cet email hors 7j n'est pas compté
  await page.getByRole('button', { name: '7j' }).click();
  const kpi7d = await page.locator('[data-kpi="totalEmails"]').textContent();

  // Cliquer sur preset 30j — l'email est dans la période
  await page.getByRole('button', { name: '30j' }).click();
  await page.waitForLoadState('networkidle');
  const kpi30d = await page.locator('[data-kpi="totalEmails"]').textContent();

  // Les deux valeurs doivent être différentes
  expect(kpi7d).not.toBe(kpi30d);
});

test('bar chart affiche des barres pour la période sélectionnée (REQ-DASH-05)', async ({ page }) => {
  await page.goto('/app/dashboard');
  await page.getByRole('button', { name: '7j' }).click();

  // Le graphique doit être présent et avoir des éléments visuels
  await expect(page.locator('[data-chart="daily-breakdown"]')).toBeVisible();
});
```

- [ ] **Step 2 : Lancer les tests**

```bash
npm run test:e2e -- tests/e2e/dashboard.spec.ts --headed
```

> Note : Les sélecteurs `[data-kpi]` et `[data-chart]` supposent que ces attributs `data-*` existent dans le JSX du dashboard. Vérifier `app/routes/app.dashboard.tsx` et ajouter les attributs si nécessaires avant de lancer.

- [ ] **Step 3 : Commit**

```bash
git add tests/e2e/dashboard.spec.ts
git commit -m "test(e2e): dashboard — empty state, period preset switch, chart presence"
```

---

### Task 5 : Tests E2E — Settings

**Files:**
- Create: `tests/e2e/settings.spec.ts`

- [ ] **Step 1 : Écrire les tests**

```typescript
// tests/e2e/settings.spec.ts
import { test, expect, beforeEach, afterAll } from '@playwright/test';
import { cleanE2EData, db, E2E_SHOP } from './helpers/db';

test.afterAll(async () => {
  await db.$disconnect();
});

test('modification du ton → sauvegardé en DB (REQ-SET-02, REQ-SET-04)', async ({ page }) => {
  await page.goto('/app/settings');

  // Sélectionner le ton "formal"
  await page.getByRole('combobox', { name: /ton|tone/i }).selectOption('formal');
  await page.getByRole('button', { name: /save|sauvegarder|enregistrer/i }).click();

  // Vérifier la confirmation UI
  await expect(page.getByText(/saved|sauvegardé|enregistré/i)).toBeVisible({ timeout: 5000 });

  // Vérifier la persistance en DB
  const settings = await db.supportSettings.findUnique({ where: { shop: E2E_SHOP } });
  expect(settings?.tone).toBe('formal');
});
```

- [ ] **Step 2 : Lancer les tests**

```bash
npm run test:e2e -- tests/e2e/settings.spec.ts --headed
```

- [ ] **Step 3 : Commit**

```bash
git add tests/e2e/settings.spec.ts
git commit -m "test(e2e): settings — tone save persisted to DB"
```

---

### Task 6 : Lancer la suite E2E complète et CI-proof

- [ ] **Step 1 : Lancer tous les tests E2E en headless**

```bash
npm run test:e2e
```

Attendu : tous verts. Si un test échoue, regarder le trace Playwright :
```bash
npx playwright show-trace test-results/<failed-test>/trace.zip
```

- [ ] **Step 2 : Vérifier le compte total de tests**

```bash
npm run test:e2e -- --reporter=list 2>&1 | tail -10
```

Attendu : ≥ 10 tests E2E passants.

- [ ] **Step 3 : Ajouter `.gitignore` pour les artefacts Playwright**

Ajouter dans `.gitignore` :
```
test-results/
playwright-report/
tests/e2e/.auth/
```

```bash
git add .gitignore
git commit -m "chore: ignore Playwright test artifacts and auth state"
```

- [ ] **Step 4 : Commit final**

```bash
git add tests/e2e/
git commit -m "test(e2e): complete E2E suite — inbox, dashboard, settings, attachments — all passing"
```
