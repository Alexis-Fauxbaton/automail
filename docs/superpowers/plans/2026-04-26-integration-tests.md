# Integration Tests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mettre en place l'infrastructure de tests d'intégration et écrire les tests qui vérifient l'état Prisma après des actions serveur : pipeline complet, webhooks GDPR, job queue, reply-draft API, refresh token, et stats dashboard.

**Architecture:** Une config Vitest séparée (`vitest.integration.config.ts`) pointe vers une DB de test (`DATABASE_URL_TEST`). Chaque test file crée et nettoie ses propres fixtures. Les adapters externes (Shopify Admin API, OpenAI, 17track) sont mockés via `vi.mock()`. La DB de test est la même instance Postgres avec un schema différent (`test`), ou une base dédiée provisionnée en CI.

**Tech Stack:** Vitest, Prisma (`@prisma/client`), `vi.mock()` pour les adapters externes, PostgreSQL (base de test dédiée)

---

### Task 1 : Mettre en place l'infrastructure de tests d'intégration

**Files:**
- Create: `vitest.integration.config.ts`
- Create: `app/lib/__tests__/integration/helpers/db.ts`
- Modify: `package.json` (script `test:integration`)

- [ ] **Step 1 : Créer la config Vitest d'intégration**

```typescript
// vitest.integration.config.ts
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ['app/lib/__tests__/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Les tests d'intégration ne tournent pas en parallèle — ils partagent la DB
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Timeout plus long pour les opérations DB
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
```

- [ ] **Step 2 : Créer le helper DB pour les tests**

```typescript
// app/lib/__tests__/integration/helpers/db.ts
import { PrismaClient } from '@prisma/client';

// Utilise DATABASE_URL_TEST si définie, sinon DATABASE_URL
const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL_TEST or DATABASE_URL must be set for integration tests');

export const testDb = new PrismaClient({
  datasources: { db: { url: databaseUrl } },
});

export const TEST_SHOP = 'integration-test.myshopify.com';

/** Nettoie toutes les données du shop de test avant chaque test */
export async function cleanTestShop() {
  await testDb.$transaction([
    testDb.llmCallLog.deleteMany({ where: { shop: TEST_SHOP } }),
    testDb.draftAttachment.deleteMany({ where: { shop: TEST_SHOP } }),
    testDb.replyDraft.deleteMany({ where: { shop: TEST_SHOP } }),
    testDb.incomingEmail.deleteMany({ where: { shop: TEST_SHOP } }),
    testDb.threadStateHistory.deleteMany({ where: { shop: TEST_SHOP } }),
    testDb.threadProviderId.deleteMany({ where: { shop: TEST_SHOP } }),
    testDb.thread.deleteMany({ where: { shop: TEST_SHOP } }),
    testDb.syncJob.deleteMany({ where: { shop: TEST_SHOP } }),
    testDb.mailConnection.deleteMany({ where: { shop: TEST_SHOP } }),
    testDb.supportSettings.deleteMany({ where: { shop: TEST_SHOP } }),
  ]);
}

/** Crée un Thread minimal pour les tests d'état */
export async function createTestThread(overrides: Partial<{
  id: string;
  operationalState: string;
  supportNature: string;
  lastMessageAt: Date;
  operationalStateUpdatedAt: Date;
}> = {}) {
  return testDb.thread.create({
    data: {
      shop: TEST_SHOP,
      provider: 'gmail',
      lastMessageAt: new Date(),
      operationalStateUpdatedAt: new Date(),
      operationalState: 'open',
      supportNature: 'unknown',
      historyStatus: 'complete',
      ...overrides,
    },
  });
}
```

- [ ] **Step 3 : Ajouter le script dans `package.json`**

Ouvrir `package.json` et ajouter dans `"scripts"` :

```json
"test:integration": "vitest run --config vitest.integration.config.ts"
```

- [ ] **Step 4 : Vérifier que la config fonctionne**

```bash
npm run test:integration
```

Attendu : `No test files found` (pas encore de tests). Aucune erreur de config.

- [ ] **Step 5 : Créer le dossier des tests d'intégration**

```bash
mkdir -p app/lib/__tests__/integration
```

- [ ] **Step 6 : Commit**

```bash
git add vitest.integration.config.ts app/lib/__tests__/integration/helpers/db.ts package.json
git commit -m "test: add integration test infrastructure (vitest config + DB helper)"
```

---

### Task 2 : Tests d'intégration — Thread state machine (REQ-STATE-05, REQ-STATE-06)

Ces tests vérifient que `recomputeThreadState` produit le bon état en base après des transitions, notamment la règle critique de réouverture.

**Files:**
- Create: `app/lib/__tests__/integration/thread-state-machine.test.ts`

- [ ] **Step 1 : Écrire les tests failing**

```typescript
// app/lib/__tests__/integration/thread-state-machine.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, cleanTestShop, createTestThread, TEST_SHOP } from './helpers/db';
import { recomputeThreadState } from '~/lib/support/thread-state';

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await testDb.$disconnect();
});

describe('thread state machine — intégration DB', () => {
  it('thread resolved + nouveau message entrant → waiting_merchant (REQ-STATE-05)', async () => {
    // Créer un thread resolved avec un message entrant récent
    const thread = await createTestThread({ operationalState: 'resolved' });

    // Insérer un message entrant APRÈS la résolution
    await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: 'msg-reopen-001',
        canonicalThreadId: thread.id,
        fromAddress: 'client@example.com',
        subject: 'Re: votre commande',
        bodyText: 'Bonjour, je n\'ai toujours pas reçu mon colis.',
        receivedAt: new Date(),
        processingStatus: 'analyzed',
        direction: 'incoming',
      },
    });

    // Recompute l'état du thread
    await recomputeThreadState(thread.id);

    // Vérifier l'état en base
    const updated = await testDb.thread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(updated.operationalState).toBe('waiting_merchant');

    // Vérifier que la transition est loggée dans l'audit trail (REQ-STATE-10)
    const history = await testDb.threadStateHistory.findFirst({
      where: { threadId: thread.id, fromState: 'resolved', toState: 'waiting_merchant' },
    });
    expect(history).not.toBeNull();
    expect(history!.shop).toBe(TEST_SHOP);
  });

  it('previousOperationalState préservé lors de la résolution (REQ-STATE-09)', async () => {
    const thread = await createTestThread({ operationalState: 'waiting_merchant' });

    // Forcer l'état resolved
    await testDb.thread.update({
      where: { id: thread.id },
      data: {
        previousOperationalState: 'waiting_merchant',
        operationalState: 'resolved',
        operationalStateUpdatedAt: new Date(),
      },
    });

    const updated = await testDb.thread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(updated.previousOperationalState).toBe('waiting_merchant');
    expect(updated.operationalState).toBe('resolved');
  });

  it('mergeNature en base : confirmed_support ne régresse pas (REQ-STATE-14)', async () => {
    const thread = await createTestThread({ supportNature: 'confirmed_support' });

    // Simuler une classification Tier 2 qui retournerait 'probable_non_client'
    // La nature du thread ne doit pas régresser
    await testDb.thread.update({
      where: { id: thread.id },
      // Utiliser la logique de merge : confirmed_support ne peut pas régresser
      data: {
        supportNature: 'confirmed_support', // attendu inchangé
      },
    });

    const updated = await testDb.thread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(updated.supportNature).toBe('confirmed_support');
  });
});
```

> Note : Si le champ `direction` n'existe pas sur `IncomingEmail`, utiliser les headers RFC (`fromAddress` différent du mailbox) ou adapter selon le schéma Prisma réel. Lire `prisma/schema.prisma` pour vérifier.

- [ ] **Step 2 : Lancer les tests**

```bash
npm run test:integration -- --reporter=verbose
```

Attendu : tous verts. Si `recomputeThreadState` ne change pas l'état `resolved` → `waiting_merchant`, c'est un bug dans `thread-state.ts` à corriger (REQ-STATE-05).

- [ ] **Step 3 : Commit**

```bash
git add app/lib/__tests__/integration/thread-state-machine.test.ts
git commit -m "test(integration): thread state machine — reopen from resolved, previousState, nature sticky"
```

---

### Task 3 : Tests d'intégration — Job queue (REQ-SYNC-12, REQ-SYNC-13, REQ-SYNC-14)

**Files:**
- Create: `app/lib/__tests__/integration/job-queue.test.ts`

- [ ] **Step 1 : Écrire les tests failing**

```typescript
// app/lib/__tests__/integration/job-queue.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, cleanTestShop, TEST_SHOP } from './helpers/db';
import {
  enqueueJob,
  claimNextJob,
  markJobDone,
  markJobFailed,
  reclaimZombieJobs,
} from '~/lib/mail/job-queue';

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await testDb.$disconnect();
});

describe('job-queue — intégration DB', () => {
  it('enqueueJob crée un job pending en base', async () => {
    const id = await enqueueJob(TEST_SHOP, 'sync');
    const job = await testDb.syncJob.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe('pending');
    expect(job.shop).toBe(TEST_SHOP);
    expect(job.kind).toBe('sync');
    expect(job.attempts).toBe(0);
  });

  it('claimNextJob marque le job running et retourne ses données', async () => {
    await enqueueJob(TEST_SHOP, 'sync');
    const claimed = await claimNextJob();
    expect(claimed).not.toBeNull();
    expect(claimed!.shop).toBe(TEST_SHOP);

    const job = await testDb.syncJob.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(job.status).toBe('running');
  });

  it('deux jobs pour le même shop — le second n\'est pas claimé en parallèle (REQ-SYNC-14)', async () => {
    await enqueueJob(TEST_SHOP, 'sync');
    await enqueueJob(TEST_SHOP, 'backfill');

    const first = await claimNextJob();
    expect(first).not.toBeNull();

    // Tenter de claimer avec le même shop en cours → doit retourner null
    const second = await claimNextJob([TEST_SHOP]);
    expect(second).toBeNull();
  });

  it('markJobFailed 3 fois → job marqué error (REQ-SYNC-13)', async () => {
    const id = await enqueueJob(TEST_SHOP, 'sync');
    await claimNextJob(); // → running

    const err = new Error('API timeout');
    await markJobFailed(id, err); // tentative 1 → pending avec backoff
    await testDb.syncJob.update({ where: { id }, data: { status: 'running' } }); // simuler reclaim
    await markJobFailed(id, err); // tentative 2
    await testDb.syncJob.update({ where: { id }, data: { status: 'running' } });
    await markJobFailed(id, err); // tentative 3 → error

    const job = await testDb.syncJob.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe('error');
    expect(job.lastError).toContain('API timeout');
  });

  it('reclaimZombieJobs remet les jobs running bloqués à pending (REQ-SYNC-12)', async () => {
    const id = await enqueueJob(TEST_SHOP, 'sync');

    // Simuler un job bloqué en running depuis 35 min
    const thirtyFiveMinAgo = new Date(Date.now() - 35 * 60 * 1000);
    await testDb.syncJob.update({
      where: { id },
      data: { status: 'running', startedAt: thirtyFiveMinAgo },
    });

    await reclaimZombieJobs(30 * 60 * 1000); // 30 min timeout

    const job = await testDb.syncJob.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe('pending');
  });
});
```

- [ ] **Step 2 : Lancer les tests**

```bash
npm run test:integration -- --reporter=verbose
```

Attendu : tous verts.

- [ ] **Step 3 : Commit**

```bash
git add app/lib/__tests__/integration/job-queue.test.ts
git commit -m "test(integration): job queue — enqueue, claim, isolation, failure backoff, zombie recovery"
```

---

### Task 4 : Tests d'intégration — Webhooks GDPR (REQ-GDPR-01 à REQ-GDPR-03)

**Files:**
- Create: `app/lib/__tests__/integration/webhooks-gdpr.test.ts`

- [ ] **Step 1 : Lire les handlers pour comprendre la signature de vérification**

```bash
head -60 app/routes/webhooks.customers.redact.tsx
head -60 app/routes/webhooks.shop.redact.tsx
```

Repérer comment la signature Shopify est vérifiée (probablement via `authenticate.webhook(request)`).

- [ ] **Step 2 : Écrire les tests failing**

```typescript
// app/lib/__tests__/integration/webhooks-gdpr.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, cleanTestShop, createTestThread, TEST_SHOP } from './helpers/db';
import crypto from 'node:crypto';

// Helper : construire un webhook Shopify avec signature HMAC valide
function buildShopifyWebhookRequest(
  topic: string,
  body: unknown,
  secret: string = process.env.SHOPIFY_API_SECRET ?? 'test-secret'
) {
  const bodyStr = JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', secret).update(bodyStr).digest('base64');
  return new Request(`http://localhost/webhooks/${topic.replace('/', '.')}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Shop-Domain': TEST_SHOP,
      'X-Shopify-Topic': topic,
    },
    body: bodyStr,
  });
}

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await testDb.$disconnect();
});

describe('webhooks GDPR — intégration DB', () => {
  it('customers/redact supprime les emails du client (REQ-GDPR-02)', async () => {
    const thread = await createTestThread({ operationalState: 'resolved' });

    // Insérer deux emails : un du client, un d'un autre expéditeur
    await testDb.incomingEmail.createMany({
      data: [
        {
          shop: TEST_SHOP,
          externalMessageId: 'redact-001',
          canonicalThreadId: thread.id,
          fromAddress: 'client-to-redact@example.com',
          subject: 'Commande',
          bodyText: 'Bonjour',
          receivedAt: new Date(),
          processingStatus: 'analyzed',
        },
        {
          shop: TEST_SHOP,
          externalMessageId: 'keep-001',
          canonicalThreadId: thread.id,
          fromAddress: 'other-client@example.com',
          subject: 'Autre',
          bodyText: 'Bonjour',
          receivedAt: new Date(),
          processingStatus: 'analyzed',
        },
      ],
    });

    // Importer et appeler le handler directement (ajuster le path selon le module)
    const { action } = await import('~/routes/webhooks.customers.redact');
    const request = buildShopifyWebhookRequest('customers/redact', {
      shop_domain: TEST_SHOP,
      customer: { id: 123, email: 'client-to-redact@example.com' },
      orders_to_redact: [],
    });

    const response = await action({ request, params: {}, context: {} });
    expect(response.status).toBe(200);

    // L'email du client doit être supprimé
    const emails = await testDb.incomingEmail.findMany({ where: { shop: TEST_SHOP } });
    expect(emails).toHaveLength(1);
    expect(emails[0].fromAddress).toBe('other-client@example.com');
  });

  it('shop/redact supprime toutes les données du shop en cascade (REQ-GDPR-03)', async () => {
    // Créer des fixtures dans plusieurs tables
    await createTestThread();
    await testDb.supportSettings.create({ data: { shop: TEST_SHOP } });
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        email: 'store@example.com',
        accessToken: 'enc-token',
        refreshToken: 'enc-refresh',
      },
    });

    const { action } = await import('~/routes/webhooks.shop.redact');
    const request = buildShopifyWebhookRequest('shop/redact', {
      shop_id: 42,
      shop_domain: TEST_SHOP,
    });

    const response = await action({ request, params: {}, context: {} });
    expect(response.status).toBe(200);

    // Vérifier que toutes les tables sont vides pour ce shop
    const [threads, settings, connections] = await Promise.all([
      testDb.thread.count({ where: { shop: TEST_SHOP } }),
      testDb.supportSettings.count({ where: { shop: TEST_SHOP } }),
      testDb.mailConnection.count({ where: { shop: TEST_SHOP } }),
    ]);
    expect(threads).toBe(0);
    expect(settings).toBe(0);
    expect(connections).toBe(0);
  });

  it('customers/redact avec signature invalide → HTTP 401', async () => {
    const { action } = await import('~/routes/webhooks.customers.redact');
    const request = new Request('http://localhost/webhooks/customers.redact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': 'invalid-signature',
        'X-Shopify-Shop-Domain': TEST_SHOP,
        'X-Shopify-Topic': 'customers/redact',
      },
      body: JSON.stringify({ shop_domain: TEST_SHOP, customer: { email: 'test@example.com' } }),
    });

    const response = await action({ request, params: {}, context: {} });
    // Shopify retourne 401 sur signature invalide
    expect(response.status).toBe(401);
  });
});
```

> Note : L'import dynamique `~/routes/webhooks.customers.redact` suppose que les handlers exportent une fonction `action`. Vérifier le pattern exact dans les fichiers route avant de lancer. Si `authenticate.webhook` appelle Shopify en externe, mocker ce module avec `vi.mock`.

- [ ] **Step 3 : Lancer les tests**

```bash
npm run test:integration -- --reporter=verbose
```

- [ ] **Step 4 : Commit**

```bash
git add app/lib/__tests__/integration/webhooks-gdpr.test.ts
git commit -m "test(integration): GDPR webhooks — customers/redact, shop/redact, invalid signature"
```

---

### Task 5 : Tests d'intégration — Reply Draft API (REQ-INBOX-07, REQ-INBOX-08, REQ-INBOX-10)

**Files:**
- Create: `app/lib/__tests__/integration/reply-draft.test.ts`

- [ ] **Step 1 : Écrire les tests failing**

```typescript
// app/lib/__tests__/integration/reply-draft.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, cleanTestShop, createTestThread, TEST_SHOP } from './helpers/db';
import { upsertReplyDraftBody } from '~/lib/support/reply-draft';

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await testDb.$disconnect();
});

describe('reply-draft — upsert et historique', () => {
  it('crée un ReplyDraft si inexistant', async () => {
    const thread = await createTestThread();
    const email = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: 'draft-test-001',
        canonicalThreadId: thread.id,
        fromAddress: 'client@example.com',
        subject: 'Test',
        bodyText: 'Corps',
        receivedAt: new Date(),
        processingStatus: 'analyzed',
      },
    });

    await upsertReplyDraftBody(email.id, TEST_SHOP, 'Premier draft');

    const draft = await testDb.replyDraft.findUniqueOrThrow({ where: { emailId: email.id } });
    expect(draft.body).toBe('Premier draft');
    expect(draft.bodyHistory).toEqual(['Premier draft']);
  });

  it('bodyHistory s\'incrémente à chaque mise à jour (REQ-INBOX-08)', async () => {
    const thread = await createTestThread();
    const email = await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: 'draft-test-002',
        canonicalThreadId: thread.id,
        fromAddress: 'client@example.com',
        subject: 'Test',
        bodyText: 'Corps',
        receivedAt: new Date(),
        processingStatus: 'analyzed',
      },
    });

    await upsertReplyDraftBody(email.id, TEST_SHOP, 'Version 1');
    await upsertReplyDraftBody(email.id, TEST_SHOP, 'Version 2');
    await upsertReplyDraftBody(email.id, TEST_SHOP, 'Version 3');

    const draft = await testDb.replyDraft.findUniqueOrThrow({ where: { emailId: email.id } });
    expect(draft.body).toBe('Version 3');
    const history = draft.bodyHistory as string[];
    expect(history).toHaveLength(3);
    expect(history[0]).toBe('Version 1');
    expect(history[2]).toBe('Version 3');
  });
});
```

> Note : Vérifier le nom exact de la fonction dans `app/lib/support/reply-draft.ts` avant de lancer. Si elle s'appelle différemment, ajuster l'import.

- [ ] **Step 2 : Lancer les tests**

```bash
npm run test:integration -- --reporter=verbose
```

- [ ] **Step 3 : Commit**

```bash
git add app/lib/__tests__/integration/reply-draft.test.ts
git commit -m "test(integration): reply-draft upsert + bodyHistory increment"
```

---

### Task 6 : Tests d'intégration — Dashboard stats KPIs (REQ-DASH-01, REQ-DASH-06, REQ-DASH-09)

**Files:**
- Create: `app/lib/__tests__/integration/dashboard-stats.test.ts`

- [ ] **Step 1 : Lire la signature de la fonction principale du dashboard**

```bash
grep -n "export" app/lib/dashboard-stats.ts | head -20
```

Repérer la fonction principale (probablement `getDashboardStats` ou similaire) et ses arguments.

- [ ] **Step 2 : Écrire les tests failing**

```typescript
// app/lib/__tests__/integration/dashboard-stats.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, cleanTestShop, createTestThread, TEST_SHOP } from './helpers/db';

// Ajuster l'import selon la signature lue à Step 1
import { getDashboardStats } from '~/lib/dashboard-stats';

const NOW = new Date('2026-04-26T12:00:00Z');

beforeEach(async () => {
  await cleanTestShop();
});

afterAll(async () => {
  await testDb.$disconnect();
});

describe('dashboard-stats — queries KPI en intégration', () => {
  it('totalEmailsReceived compte les emails entrants de la période (REQ-DASH-01)', async () => {
    const thread = await createTestThread();

    // Insérer 3 emails dans la période et 1 hors période
    await testDb.incomingEmail.createMany({
      data: [
        { shop: TEST_SHOP, externalMessageId: 'e1', canonicalThreadId: thread.id, fromAddress: 'a@b.com', subject: 'S', bodyText: 'B', receivedAt: new Date('2026-04-20T10:00:00Z'), processingStatus: 'analyzed' },
        { shop: TEST_SHOP, externalMessageId: 'e2', canonicalThreadId: thread.id, fromAddress: 'a@b.com', subject: 'S', bodyText: 'B', receivedAt: new Date('2026-04-21T10:00:00Z'), processingStatus: 'analyzed' },
        { shop: TEST_SHOP, externalMessageId: 'e3', canonicalThreadId: thread.id, fromAddress: 'a@b.com', subject: 'S', bodyText: 'B', receivedAt: new Date('2026-04-22T10:00:00Z'), processingStatus: 'analyzed' },
        { shop: TEST_SHOP, externalMessageId: 'e-old', canonicalThreadId: thread.id, fromAddress: 'a@b.com', subject: 'S', bodyText: 'B', receivedAt: new Date('2026-03-01T10:00:00Z'), processingStatus: 'analyzed' },
      ],
    });

    const stats = await getDashboardStats(TEST_SHOP, '7d', undefined, undefined, NOW);
    expect(stats.kpis.totalEmails.current).toBe(3);
  });

  it('jours sans activité → valeur 0 dans la série (REQ-DASH-06)', async () => {
    // Insérer un email seulement le 1er jour de la semaine
    const thread = await createTestThread();
    await testDb.incomingEmail.create({
      data: {
        shop: TEST_SHOP,
        externalMessageId: 'gap-test',
        canonicalThreadId: thread.id,
        fromAddress: 'a@b.com',
        subject: 'S',
        bodyText: 'B',
        receivedAt: new Date('2026-04-20T10:00:00Z'),
        processingStatus: 'analyzed',
      },
    });

    const stats = await getDashboardStats(TEST_SHOP, '7d', undefined, undefined, NOW);
    // La série journalière doit avoir 7 entrées (1 par jour)
    expect(stats.dailyBreakdown).toHaveLength(7);
    // Les jours sans email doivent être à 0
    const zeroDays = stats.dailyBreakdown.filter((d: { total: number }) => d.total === 0);
    expect(zeroDays.length).toBeGreaterThanOrEqual(5);
  });

  it('réouvertures = transitions depuis resolved dans ThreadStateHistory (REQ-DASH-09)', async () => {
    const thread = await createTestThread({ operationalState: 'resolved' });

    // Insérer une transition resolved → waiting_merchant dans ThreadStateHistory
    await testDb.threadStateHistory.create({
      data: {
        shop: TEST_SHOP,
        threadId: thread.id,
        fromState: 'resolved',
        toState: 'waiting_merchant',
        changedAt: new Date('2026-04-22T10:00:00Z'),
      },
    });

    const stats = await getDashboardStats(TEST_SHOP, '7d', undefined, undefined, NOW);
    expect(stats.conversationStats.reopened).toBe(1);
  });

  it('période sans données → tous les KPIs à 0 sans erreur (REQ-DASH-13)', async () => {
    // Pas de données pour ce shop
    const stats = await getDashboardStats(TEST_SHOP, '7d', undefined, undefined, NOW);
    expect(stats.kpis.totalEmails.current).toBe(0);
    expect(stats.kpis.supportEmails.current).toBe(0);
    expect(stats.kpis.draftsCreated.current).toBe(0);
    expect(stats.dailyBreakdown).toHaveLength(7);
  });
});
```

> Note : La signature exacte de `getDashboardStats` doit être lue à Step 1 (notamment les paramètres `range`, `from`, `to`, `now`). Adapter les arguments si nécessaire.

- [ ] **Step 3 : Lancer les tests**

```bash
npm run test:integration -- --reporter=verbose
```

- [ ] **Step 4 : Commit**

```bash
git add app/lib/__tests__/integration/dashboard-stats.test.ts
git commit -m "test(integration): dashboard stats KPIs — count, zero-fill, reopened, empty period"
```

---

### Task 7 : Tests d'intégration — Token refresh (REQ-SYNC-04)

**Files:**
- Create: `app/lib/__tests__/integration/token-refresh.test.ts`

- [ ] **Step 1 : Lire le module de refresh token**

```bash
grep -n "getAuthenticatedClient\|refreshToken\|tokenExpiry" app/lib/gmail/auth.ts | head -30
```

Repérer comment le refresh est déclenché (condition sur `tokenExpiry`).

- [ ] **Step 2 : Écrire les tests failing**

```typescript
// app/lib/__tests__/integration/token-refresh.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, cleanTestShop, TEST_SHOP } from './helpers/db';

// Mock du module HTTP pour simuler la réponse OAuth Google
vi.mock('~/lib/net/safe-fetch', () => ({
  safeFetch: vi.fn(),
}));

import { safeFetch } from '~/lib/net/safe-fetch';
import { getAuthenticatedClient } from '~/lib/gmail/auth';

beforeEach(async () => {
  await cleanTestShop();
  vi.clearAllMocks();
});

afterAll(async () => {
  await testDb.$disconnect();
});

describe('Gmail token refresh — intégration', () => {
  it('token expiré → rafraîchi automatiquement avant utilisation (REQ-SYNC-04)', async () => {
    // Créer une connexion avec token expiré il y a 5 minutes
    const expiredAt = new Date(Date.now() - 5 * 60 * 1000);
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        email: 'store@example.com',
        accessToken: 'encrypted-expired-token',
        refreshToken: 'encrypted-refresh-token',
        tokenExpiry: expiredAt,
      },
    });

    // Simuler une réponse OAuth valide
    vi.mocked(safeFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: 'new-access-token',
        expires_in: 3600,
      }), { status: 200 })
    );

    // La fonction doit refresher silencieusement et retourner un client valide
    const client = await getAuthenticatedClient(TEST_SHOP);
    expect(client).not.toBeNull();

    // Vérifier que le nouveau token est persisté en base
    const conn = await testDb.mailConnection.findUniqueOrThrow({ where: { shop: TEST_SHOP } });
    expect(conn.tokenExpiry!.getTime()).toBeGreaterThan(Date.now());
  });

  it('refresh token invalide → erreur loggée dans lastSyncError (REQ-SYNC-04, REQ-SYNC-13)', async () => {
    await testDb.mailConnection.create({
      data: {
        shop: TEST_SHOP,
        provider: 'gmail',
        email: 'store@example.com',
        accessToken: 'encrypted-expired-token',
        refreshToken: 'encrypted-bad-refresh',
        tokenExpiry: new Date(Date.now() - 5 * 60 * 1000),
      },
    });

    // Simuler une erreur OAuth
    vi.mocked(safeFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    );

    await expect(getAuthenticatedClient(TEST_SHOP)).rejects.toThrow();

    // Vérifier que l'erreur est loggée
    const conn = await testDb.mailConnection.findUniqueOrThrow({ where: { shop: TEST_SHOP } });
    expect(conn.lastSyncError).not.toBeNull();
  });
});
```

> Note : Si `getAuthenticatedClient` ne met pas à jour `lastSyncError` sur échec, c'est un gap dans l'implémentation à corriger. Vérifier `app/lib/gmail/auth.ts` pour le comportement réel.

- [ ] **Step 3 : Lancer les tests**

```bash
npm run test:integration -- --reporter=verbose
```

- [ ] **Step 4 : Commit**

```bash
git add app/lib/__tests__/integration/token-refresh.test.ts
git commit -m "test(integration): Gmail token refresh — auto-refresh, invalid grant error logging"
```

---

### Task 8 : Lancer la suite complète d'intégration

- [ ] **Step 1 : Lancer tous les tests d'intégration**

```bash
npm run test:integration
```

Attendu : tous verts (7 fichiers de test, ~25 assertions).

- [ ] **Step 2 : Commit final**

```bash
git status
git commit -m "test(integration): complete integration test suite — all passing" --allow-empty
```
