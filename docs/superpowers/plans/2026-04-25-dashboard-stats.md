# Dashboard Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter une page Dashboard `/app/dashboard` qui affiche des statistiques d'activité support (KPIs, graphique de tendance, états des conversations, top intentions) sur une période sélectionnable.

**Architecture:** Nouvelle route React Router server-rendered avec loader Prisma. Un nouveau modèle `ThreadStateHistory` historise les transitions d'état des threads. Une lib `dashboard-stats.ts` isole les requêtes agrégées. Recharts gère le bar chart côté client avec un guard `mounted` pour éviter les erreurs SSR.

**Tech Stack:** React Router v7, Prisma (PostgreSQL), Recharts, Vitest, TypeScript

---

## File Map

| Fichier | Action | Responsabilité |
|---|---|---|
| `prisma/schema.prisma` | Modifier | Ajouter `ThreadStateHistory` + relation inverse sur `Thread` |
| `app/lib/support/thread-state-history.ts` | Créer | Helper `recordStateTransition()` réutilisable |
| `app/lib/support/__tests__/thread-state-history.test.ts` | Créer | Tests unitaires (fonction pure `buildHistoryEntry`) |
| `app/lib/support/thread-state.ts` | Modifier | Appeler `recordStateTransition` dans `recomputeThreadState` |
| `app/routes/app.inbox.tsx` | Modifier | Appeler `recordStateTransition` dans l'action `moveThread` |
| `app/routes/webhooks.shop.redact.tsx` | Modifier | Supprimer `threadStateHistory` avant `thread` |
| `app/lib/dashboard-stats.ts` | Créer | Toutes les requêtes agrégées pour le dashboard |
| `app/lib/__tests__/dashboard-stats.test.ts` | Créer | Tests de `getPeriodBounds` (fonction pure) |
| `app/routes/app.dashboard.tsx` | Créer | Route dashboard (loader + composant) |
| `app/routes/app.tsx` | Modifier | Ajouter lien "Dashboard" dans la nav |

---

## Task 1: Schema Prisma — ThreadStateHistory

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Ajouter le modèle `ThreadStateHistory` dans `prisma/schema.prisma`**

Trouver le modèle `Thread` et ajouter la relation inverse. Puis ajouter le nouveau modèle à la fin du fichier.

Dans le modèle `Thread`, ajouter la ligne :
```prisma
stateHistory  ThreadStateHistory[]
```

Ajouter ce nouveau modèle :
```prisma
model ThreadStateHistory {
  id        String   @id @default(cuid())
  shop      String
  threadId  String
  fromState String?
  toState   String
  changedAt DateTime @default(now())

  thread Thread @relation(fields: [threadId], references: [id], onDelete: Cascade)

  @@index([shop, changedAt])
  @@index([threadId, changedAt])
}
```

- [ ] **Step 2: Générer et appliquer la migration**

```bash
npx prisma migrate dev --name add-thread-state-history
```

Résultat attendu : `Your database is now in sync with your schema.` + fichier migration créé dans `prisma/migrations/`.

- [ ] **Step 3: Vérifier le client Prisma généré**

```bash
npx prisma generate
```

Résultat attendu : `Generated Prisma Client`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add ThreadStateHistory model for operational state audit trail"
```

---

## Task 2: Helper `recordStateTransition`

**Files:**
- Create: `app/lib/support/thread-state-history.ts`
- Create: `app/lib/support/__tests__/thread-state-history.test.ts`

- [ ] **Step 1: Écrire le test de la fonction pure `buildHistoryEntry`**

```typescript
// app/lib/support/__tests__/thread-state-history.test.ts
import { describe, it, expect } from "vitest";
import { buildHistoryEntry } from "../thread-state-history";

describe("buildHistoryEntry", () => {
  it("retourne fromState null quand l'ancien état est identique au nouvel état", () => {
    const entry = buildHistoryEntry({
      shop: "test.myshopify.com",
      threadId: "thread_1",
      fromState: "open",
      toState: "open",
    });
    expect(entry).toBeNull();
  });

  it("retourne une entrée quand l'état change", () => {
    const entry = buildHistoryEntry({
      shop: "test.myshopify.com",
      threadId: "thread_1",
      fromState: "open",
      toState: "resolved",
    });
    expect(entry).not.toBeNull();
    expect(entry!.shop).toBe("test.myshopify.com");
    expect(entry!.threadId).toBe("thread_1");
    expect(entry!.fromState).toBe("open");
    expect(entry!.toState).toBe("resolved");
  });

  it("retourne une entrée quand fromState est null (création initiale)", () => {
    const entry = buildHistoryEntry({
      shop: "test.myshopify.com",
      threadId: "thread_1",
      fromState: null,
      toState: "open",
    });
    expect(entry).not.toBeNull();
    expect(entry!.fromState).toBeNull();
  });
});
```

- [ ] **Step 2: Lancer le test pour confirmer qu'il échoue**

```bash
npx vitest run app/lib/support/__tests__/thread-state-history.test.ts
```

Résultat attendu : FAIL avec `Cannot find module '../thread-state-history'`

- [ ] **Step 3: Implémenter `thread-state-history.ts`**

```typescript
// app/lib/support/thread-state-history.ts
import type { PrismaClient } from "@prisma/client";

type HistoryEntry = {
  shop: string;
  threadId: string;
  fromState: string | null;
  toState: string;
};

export function buildHistoryEntry(params: {
  shop: string;
  threadId: string;
  fromState: string | null;
  toState: string;
}): HistoryEntry | null {
  if (params.fromState === params.toState) return null;
  return {
    shop: params.shop,
    threadId: params.threadId,
    fromState: params.fromState,
    toState: params.toState,
  };
}

export async function recordStateTransition(
  prisma: PrismaClient,
  params: {
    shop: string;
    threadId: string;
    fromState: string | null;
    toState: string;
  }
): Promise<void> {
  const entry = buildHistoryEntry(params);
  if (!entry) return;
  await prisma.threadStateHistory.create({ data: entry });
}
```

- [ ] **Step 4: Lancer le test pour confirmer qu'il passe**

```bash
npx vitest run app/lib/support/__tests__/thread-state-history.test.ts
```

Résultat attendu : `3 tests passed`

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/thread-state-history.ts app/lib/support/__tests__/thread-state-history.test.ts
git commit -m "feat: add recordStateTransition helper for ThreadStateHistory"
```

---

## Task 3: Instrumenter `recomputeThreadState`

**Files:**
- Modify: `app/lib/support/thread-state.ts`

`recomputeThreadState` est la fonction qui recalcule automatiquement l'état d'un thread après ingestion d'un message. Elle se trouve dans `app/lib/support/thread-state.ts`, lignes ~313-323.

- [ ] **Step 1: Ajouter l'import de `recordStateTransition`**

En haut de `app/lib/support/thread-state.ts`, ajouter :
```typescript
import { recordStateTransition } from "./thread-state-history";
```

- [ ] **Step 2: Instrumenter le bloc de mise à jour de l'état (Location B, ~ligne 313)**

Trouver le bloc Prisma update qui contient `operationalState,` et `previousOperationalState: null`. Il ressemble à :
```typescript
await prisma.thread.update({
  where: { id: canonicalThreadId },
  data: {
    supportNature: finalNature,
    supportNatureUpdatedAt: ...,
    operationalState,
    previousOperationalState: null,
    operationalStateUpdatedAt: now,
    structuredState: ...,
  },
});
```

Remplacer ce bloc par :
```typescript
await prisma.thread.update({
  where: { id: canonicalThreadId },
  data: {
    supportNature: finalNature,
    supportNatureUpdatedAt: finalNature !== thread.supportNature ? now : undefined,
    operationalState,
    previousOperationalState: null,
    operationalStateUpdatedAt: now,
    structuredState: JSON.stringify(structured),
  },
});

await recordStateTransition(prisma, {
  shop: thread.shop,
  threadId: canonicalThreadId,
  fromState: thread.operationalState ?? null,
  toState: operationalState,
});
```

- [ ] **Step 3: Vérifier la compilation TypeScript**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Step 4: Commit**

```bash
git add app/lib/support/thread-state.ts
git commit -m "feat: record state transitions in recomputeThreadState"
```

---

## Task 4: Instrumenter l'action `moveThread` dans l'inbox

**Files:**
- Modify: `app/routes/app.inbox.tsx`

L'action `moveThread` se trouve vers la ligne 374. Elle fait un `prisma.thread.update` vers la ligne 399.

- [ ] **Step 1: Ajouter l'import de `recordStateTransition`**

En haut de `app/routes/app.inbox.tsx`, ajouter :
```typescript
import { recordStateTransition } from "~/lib/support/thread-state-history";
```

- [ ] **Step 2: Trouver le bloc `prisma.thread.update` dans l'action `moveThread`**

Chercher le pattern `case "moveThread":` puis le `await prisma.thread.update`. Il ressemble à :
```typescript
await prisma.thread.update({
  where: { id: canonicalThreadId },
  data: {
    operationalState: target,
    previousOperationalState,
    operationalStateUpdatedAt: new Date(),
    ...
  },
});
```

Ajouter immédiatement **après** ce `prisma.thread.update` :
```typescript
await recordStateTransition(prisma, {
  shop: session.shop,
  threadId: canonicalThreadId,
  fromState: thread.operationalState ?? null,
  toState: target,
});
```

`thread` est déjà lu plus haut dans l'action (il y a un `await prisma.thread.findUnique` au début de `moveThread`). `session` est disponible depuis le loader auth. `target` est la valeur cible passée par le formulaire.

- [ ] **Step 3: Vérifier la compilation TypeScript**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat: record state transitions in moveThread inbox action"
```

---

## Task 5: Mettre à jour le webhook `shop.redact`

**Files:**
- Modify: `app/routes/webhooks.shop.redact.tsx`

Le webhook supprime toutes les données d'un shop dans l'ordre. Grâce à `onDelete: Cascade` sur `ThreadStateHistory`, les entrées seront supprimées automatiquement quand `thread` est supprimé. Mais pour être explicite et s'assurer de l'ordre, on ajoute la suppression explicite **avant** celle de `thread`.

- [ ] **Step 1: Trouver la suppression de `thread` dans `webhooks.shop.redact.tsx`**

Chercher `prisma.thread.deleteMany` dans le fichier. Le bloc ressemble à :
```typescript
await prisma.thread.deleteMany({ where: { shop } });
```

Ajouter **juste avant** cette ligne :
```typescript
await prisma.threadStateHistory.deleteMany({ where: { shop } });
```

- [ ] **Step 2: Vérifier la compilation TypeScript**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add app/routes/webhooks.shop.redact.tsx
git commit -m "feat: delete ThreadStateHistory on shop redact webhook"
```

---

## Task 6: `dashboard-stats.ts` — Bornes de période (pure + testée)

**Files:**
- Create: `app/lib/dashboard-stats.ts`
- Create: `app/lib/__tests__/dashboard-stats.test.ts`

- [ ] **Step 1: Écrire les tests de `getPeriodBounds`**

```typescript
// app/lib/__tests__/dashboard-stats.test.ts
import { describe, it, expect } from "vitest";
import { getPeriodBounds } from "../dashboard-stats";

describe("getPeriodBounds", () => {
  it("retourne 30 jours par défaut", () => {
    const now = new Date("2026-04-25T12:00:00Z");
    const { start, end, prevStart, prevEnd } = getPeriodBounds("30d", undefined, undefined, now);
    expect(end.toISOString()).toBe(now.toISOString());
    expect(start.toISOString()).toBe(new Date("2026-03-26T12:00:00Z").toISOString());
    expect(prevStart.toISOString()).toBe(new Date("2026-02-24T12:00:00Z").toISOString());
    expect(prevEnd.toISOString()).toBe(new Date("2026-03-26T12:00:00Z").toISOString());
  });

  it("retourne 24 heures pour range=24h", () => {
    const now = new Date("2026-04-25T12:00:00Z");
    const { start, end } = getPeriodBounds("24h", undefined, undefined, now);
    const diff = end.getTime() - start.getTime();
    expect(diff).toBe(24 * 60 * 60 * 1000);
  });

  it("retourne 7 jours pour range=7d", () => {
    const now = new Date("2026-04-25T12:00:00Z");
    const { start, end } = getPeriodBounds("7d", undefined, undefined, now);
    const diff = end.getTime() - start.getTime();
    expect(diff).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("retourne 90 jours pour range=90d", () => {
    const now = new Date("2026-04-25T12:00:00Z");
    const { start, end } = getPeriodBounds("90d", undefined, undefined, now);
    const diff = end.getTime() - start.getTime();
    expect(diff).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("utilise les bornes personnalisées quand from/to sont fournis", () => {
    const now = new Date("2026-04-25T12:00:00Z");
    const { start, end } = getPeriodBounds("custom", "2026-04-01", "2026-04-15", now);
    expect(start.toISOString().startsWith("2026-04-01")).toBe(true);
    expect(end.toISOString().startsWith("2026-04-15")).toBe(true);
  });
});
```

- [ ] **Step 2: Lancer les tests pour confirmer l'échec**

```bash
npx vitest run app/lib/__tests__/dashboard-stats.test.ts
```

Résultat attendu : FAIL `Cannot find module '../dashboard-stats'`

- [ ] **Step 3: Créer `app/lib/dashboard-stats.ts` avec `getPeriodBounds`**

```typescript
// app/lib/dashboard-stats.ts
import { prisma } from "~/db.server";

export type PeriodBounds = {
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
};

const RANGE_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

export function getPeriodBounds(
  range: string,
  from: string | undefined,
  to: string | undefined,
  now: Date = new Date()
): PeriodBounds {
  let start: Date;
  let end: Date;

  if (range === "custom" && from && to) {
    start = new Date(from);
    end = new Date(to);
  } else {
    const ms = RANGE_MS[range] ?? RANGE_MS["30d"];
    end = now;
    start = new Date(now.getTime() - ms);
  }

  const duration = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime());
  const prevStart = new Date(start.getTime() - duration);

  return { start, end, prevStart, prevEnd };
}
```

- [ ] **Step 4: Lancer les tests pour confirmer le passage**

```bash
npx vitest run app/lib/__tests__/dashboard-stats.test.ts
```

Résultat attendu : `5 tests passed`

- [ ] **Step 5: Commit**

```bash
git add app/lib/dashboard-stats.ts app/lib/__tests__/dashboard-stats.test.ts
git commit -m "feat: add dashboard-stats module with getPeriodBounds"
```

---

## Task 7: `dashboard-stats.ts` — Requêtes agrégées

**Files:**
- Modify: `app/lib/dashboard-stats.ts`

Note: `prisma` est importé depuis `~/db.server`. Vérifier que ce chemin existe dans le projet (chercher `db.server.ts` ou `prisma.server.ts`). Si le fichier s'appelle différemment, ajuster l'import.

- [ ] **Step 1: Ajouter les types de retour**

Ajouter en haut de `app/lib/dashboard-stats.ts`, après les imports :

```typescript
export type KpiStats = {
  totalEmails: number;
  supportEmails: number;
  draftsCreated: number;
  sentEmails: number | null;
  prevTotalEmails: number;
  prevSupportEmails: number;
  prevDraftsCreated: number;
};

export type DailyPoint = {
  date: string; // "YYYY-MM-DD"
  total: number;
  support: number;
};

export type ThreadStateCounts = {
  open: number;
  waiting_customer: number;
  waiting_merchant: number;
  resolved: number;
  no_reply_needed: number;
};

export type ConversationStats = {
  newConversations: number;
  resolvedConversations: number;
  reopenedConversations: number;
};

export type IntentCount = {
  intent: string;
  count: number;
};
```

- [ ] **Step 2: Ajouter `getKpiStats`**

```typescript
export async function getKpiStats(
  shop: string,
  start: Date,
  end: Date,
  prevStart: Date,
  prevEnd: Date
): Promise<KpiStats> {
  const [
    totalEmails,
    supportEmails,
    draftsCreated,
    prevTotalEmails,
    prevSupportEmails,
    prevDraftsCreated,
  ] = await Promise.all([
    prisma.incomingEmail.count({
      where: { shop, receivedAt: { gte: start, lt: end } },
    }),
    prisma.incomingEmail.count({
      where: { shop, receivedAt: { gte: start, lt: end }, tier2Result: "support_client" },
    }),
    prisma.replyDraft.count({
      where: {
        shop,
        email: { receivedAt: { gte: start, lt: end } },
      },
    }),
    prisma.incomingEmail.count({
      where: { shop, receivedAt: { gte: prevStart, lt: prevEnd } },
    }),
    prisma.incomingEmail.count({
      where: { shop, receivedAt: { gte: prevStart, lt: prevEnd }, tier2Result: "support_client" },
    }),
    prisma.replyDraft.count({
      where: {
        shop,
        email: { receivedAt: { gte: prevStart, lt: prevEnd } },
      },
    }),
  ]);

  return {
    totalEmails,
    supportEmails,
    draftsCreated,
    sentEmails: null,
    prevTotalEmails,
    prevSupportEmails,
    prevDraftsCreated,
  };
}
```

- [ ] **Step 3: Ajouter `getDailyBreakdown`**

```typescript
export async function getDailyBreakdown(
  shop: string,
  start: Date,
  end: Date
): Promise<DailyPoint[]> {
  const emails = await prisma.incomingEmail.findMany({
    where: { shop, receivedAt: { gte: start, lt: end } },
    select: { receivedAt: true, tier2Result: true },
  });

  const byDay = new Map<string, { total: number; support: number }>();

  for (const email of emails) {
    const day = email.receivedAt.toISOString().slice(0, 10);
    const existing = byDay.get(day) ?? { total: 0, support: 0 };
    existing.total += 1;
    if (email.tier2Result === "support_client") existing.support += 1;
    byDay.set(day, existing);
  }

  // Remplir les jours sans emails pour avoir une série continue
  const points: DailyPoint[] = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const endDay = end.toISOString().slice(0, 10);

  while (cursor.toISOString().slice(0, 10) <= endDay) {
    const day = cursor.toISOString().slice(0, 10);
    const data = byDay.get(day) ?? { total: 0, support: 0 };
    points.push({ date: day, ...data });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return points;
}
```

- [ ] **Step 4: Ajouter `getCurrentThreadStates`**

```typescript
export async function getCurrentThreadStates(shop: string): Promise<ThreadStateCounts> {
  const rows = await prisma.thread.groupBy({
    by: ["operationalState"],
    where: { shop },
    _count: { _all: true },
  });

  const counts: ThreadStateCounts = {
    open: 0,
    waiting_customer: 0,
    waiting_merchant: 0,
    resolved: 0,
    no_reply_needed: 0,
  };

  for (const row of rows) {
    const state = row.operationalState as keyof ThreadStateCounts;
    if (state in counts) counts[state] = row._count._all;
  }

  return counts;
}
```

- [ ] **Step 5: Ajouter `getConversationStats`**

```typescript
export async function getConversationStats(
  shop: string,
  start: Date,
  end: Date
): Promise<ConversationStats> {
  const [newConversations, resolvedConversations, reopenedConversations] = await Promise.all([
    prisma.thread.count({
      where: { shop, firstMessageAt: { gte: start, lt: end } },
    }),
    prisma.threadStateHistory.count({
      where: { shop, toState: "resolved", changedAt: { gte: start, lt: end } },
    }),
    prisma.threadStateHistory.count({
      where: {
        shop,
        fromState: "resolved",
        NOT: { toState: "resolved" },
        changedAt: { gte: start, lt: end },
      },
    }),
  ]);

  return { newConversations, resolvedConversations, reopenedConversations };
}
```

- [ ] **Step 6: Ajouter `getIntentBreakdown`**

```typescript
export async function getIntentBreakdown(
  shop: string,
  start: Date,
  end: Date
): Promise<IntentCount[]> {
  const rows = await prisma.incomingEmail.groupBy({
    by: ["detectedIntent"],
    where: {
      shop,
      receivedAt: { gte: start, lt: end },
      detectedIntent: { not: null },
    },
    _count: { _all: true },
    orderBy: { _count: { detectedIntent: "desc" } },
    take: 5,
  });

  return rows.map((r) => ({
    intent: r.detectedIntent as string,
    count: r._count._all,
  }));
}
```

- [ ] **Step 7: Vérifier la compilation TypeScript**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur. Si Prisma se plaint de `email` dans `replyDraft.count`, vérifier le nom de la relation dans `schema.prisma` (peut s'appeler `incomingEmail` ou `email` selon le modèle) et ajuster le filtre.

- [ ] **Step 8: Commit**

```bash
git add app/lib/dashboard-stats.ts
git commit -m "feat: add aggregated query functions to dashboard-stats"
```

---

## Task 8: Route `app.dashboard.tsx`

**Files:**
- Create: `app/routes/app.dashboard.tsx`

- [ ] **Step 1: Installer Recharts**

```bash
npm install recharts
```

- [ ] **Step 2: Créer la route avec le loader**

```typescript
// app/routes/app.dashboard.tsx
import { json, type LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams, Form } from "react-router";
import { authenticate } from "~/shopify.server";
import {
  getPeriodBounds,
  getKpiStats,
  getDailyBreakdown,
  getCurrentThreadStates,
  getConversationStats,
  getIntentBreakdown,
  type KpiStats,
  type DailyPoint,
  type ThreadStateCounts,
  type ConversationStats,
  type IntentCount,
} from "~/lib/dashboard-stats";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "30d";
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;

  const bounds = getPeriodBounds(range, from, to);
  const { start, end, prevStart, prevEnd } = bounds;

  const [kpis, daily, threadStates, conversationStats, intents] = await Promise.all([
    getKpiStats(shop, start, end, prevStart, prevEnd),
    getDailyBreakdown(shop, start, end),
    getCurrentThreadStates(shop),
    getConversationStats(shop, start, end),
    getIntentBreakdown(shop, start, end),
  ]);

  return json({
    range,
    from: from ?? null,
    to: to ?? null,
    kpis,
    daily,
    threadStates,
    conversationStats,
    intents,
    today: new Date().toLocaleDateString("fr-FR"),
  });
}
```

- [ ] **Step 3: Ajouter les composants helper (variation KPI)**

Sous le loader, ajouter :

```typescript
function pct(current: number, prev: number): string | null {
  if (prev === 0) return null;
  const diff = ((current - prev) / prev) * 100;
  return (diff >= 0 ? "↑ +" : "↓ ") + Math.abs(diff).toFixed(0) + "%";
}

function KpiCard({
  label,
  value,
  prev,
  placeholder,
}: {
  label: string;
  value: number | null;
  prev?: number;
  placeholder?: string;
}) {
  const variation = value !== null && prev !== undefined ? pct(value, prev) : null;
  const isUp = variation?.startsWith("↑");
  return (
    <div style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 8, padding: 16 }}>
      <p style={{ margin: 0, fontSize: 12, color: "var(--p-color-text-subdued)", textTransform: "uppercase", letterSpacing: 1 }}>
        {label}
      </p>
      {value !== null ? (
        <>
          <p style={{ margin: "4px 0", fontSize: 28, fontWeight: 700 }}>{value.toLocaleString("fr-FR")}</p>
          {variation && (
            <p style={{ margin: 0, fontSize: 12, color: isUp ? "var(--p-color-text-success)" : "var(--p-color-text-critical)" }}>
              {variation}
            </p>
          )}
        </>
      ) : (
        <>
          <p style={{ margin: "4px 0", fontSize: 28, fontWeight: 700, color: "var(--p-color-text-disabled)" }}>—</p>
          {placeholder && <p style={{ margin: 0, fontSize: 12, color: "var(--p-color-text-disabled)" }}>{placeholder}</p>}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Ajouter le composant `BarChartClient` (guard SSR)**

```typescript
import { useEffect, useState } from "react";
import type { BarChart as BarChartType } from "recharts";

function BarChartClient({ data }: { data: DailyPoint[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div style={{ height: 200 }} />;

  const {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    Tooltip,
    ResponsiveContainer,
    Legend,
  } = require("recharts");

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
        <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
        <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
        <Tooltip
          formatter={(value: number, name: string) =>
            [value, name === "total" ? "Tous mails" : "Support"]
          }
          labelFormatter={(label: string) => label}
        />
        <Legend formatter={(v: string) => (v === "total" ? "Tous mails" : "Support client")} />
        <Bar dataKey="total" fill="#6c63ff" opacity={0.5} radius={[2, 2, 0, 0]} />
        <Bar dataKey="support" fill="#6c63ff" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 5: Ajouter le composant principal `Dashboard`**

```typescript
const STATE_LABELS: Record<string, string> = {
  open: "Ouvert",
  waiting_customer: "Attente client",
  waiting_merchant: "Attente nous",
  resolved: "Résolu",
  no_reply_needed: "Sans réponse requise",
};

const STATE_COLORS: Record<string, string> = {
  open: "#ef4444",
  waiting_customer: "#f59e0b",
  waiting_merchant: "#3b82f6",
  resolved: "#22c55e",
  no_reply_needed: "#9ca3af",
};

const INTENT_LABELS: Record<string, string> = {
  where_is_my_order: "Où est ma commande",
  delivery_delay: "Retard de livraison",
  marked_delivered_not_received: "Livré non reçu",
  package_stuck: "Colis bloqué",
  refund_request: "Remboursement",
  unknown: "Autre",
};

export default function Dashboard() {
  const { range, kpis, daily, threadStates, conversationStats, intents, today } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const presets = ["24h", "7d", "30d", "90d"] as const;

  function selectPreset(r: string) {
    setSearchParams({ range: r });
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Dashboard</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {presets.map((p) => (
            <button
              key={p}
              onClick={() => selectPreset(p)}
              style={{
                padding: "4px 12px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                background: range === p ? "var(--p-color-bg-fill-brand)" : "var(--p-color-bg-surface-secondary)",
                color: range === p ? "#fff" : "var(--p-color-text)",
                fontWeight: range === p ? 600 : 400,
                fontSize: 13,
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* 2-column layout */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 20, alignItems: "start" }}>

        {/* Left column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* KPI cards */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <KpiCard label="Mails reçus" value={kpis.totalEmails} prev={kpis.prevTotalEmails} />
            <KpiCard label="Support client" value={kpis.supportEmails} prev={kpis.prevSupportEmails} />
            <KpiCard label="Brouillons créés" value={kpis.draftsCreated} prev={kpis.prevDraftsCreated} />
            <KpiCard label="Mails envoyés" value={null} placeholder="Bientôt disponible" />
          </div>

          {/* Bar chart */}
          <div style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 8, padding: 16 }}>
            <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>Mails reçus par jour</p>
            <BarChartClient data={daily} />
          </div>
        </div>

        {/* Right column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Thread states — TODAY snapshot */}
          <div style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 8, padding: 16 }}>
            <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>
              État actuel{" "}
              <span style={{ fontWeight: 400, color: "var(--p-color-text-subdued)", fontSize: 12 }}>
                · {today}
              </span>
            </p>
            {(Object.keys(STATE_LABELS) as Array<keyof ThreadStateCounts>).map((state) => (
              <div key={state} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: STATE_COLORS[state], fontSize: 10 }}>●</span>
                  {STATE_LABELS[state]}
                </span>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{threadStates[state] ?? 0}</span>
              </div>
            ))}
          </div>

          {/* Conversation stats — period */}
          <div style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 8, padding: 16 }}>
            <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>Conversations (période)</p>
            {[
              { label: "Nouvelles", value: conversationStats.newConversations },
              { label: "Résolues", value: conversationStats.resolvedConversations },
              { label: "Rouvertes", value: conversationStats.reopenedConversations },
            ].map(({ label, value }) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "var(--p-color-text-subdued)" }}>{label}</span>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{value}</span>
              </div>
            ))}
          </div>

          {/* Top intents */}
          <div style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 8, padding: 16 }}>
            <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>Top intentions</p>
            {intents.length === 0 && (
              <p style={{ margin: 0, fontSize: 13, color: "var(--p-color-text-subdued)" }}>Aucune donnée sur la période.</p>
            )}
            {intents.map(({ intent, count }) => (
              <div key={intent} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "var(--p-color-text-subdued)" }}>
                  {INTENT_LABELS[intent] ?? intent}
                </span>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Vérifier la compilation TypeScript**

```bash
npx tsc --noEmit
```

Si TypeScript se plaint du `require("recharts")` dynamique dans `BarChartClient`, ajouter `// @ts-ignore` sur la ligne du require ou importer Recharts normalement en haut du fichier (Vite gère le SSR de manière flexible et l'import statique fonctionne généralement avec le guard `mounted`).

- [ ] **Step 7: Commit**

```bash
git add app/routes/app.dashboard.tsx
git commit -m "feat: add dashboard route with KPIs, bar chart, thread states, and intent breakdown"
```

---

## Task 9: Ajouter le lien Dashboard dans la nav

**Files:**
- Modify: `app/routes/app.tsx`

- [ ] **Step 1: Trouver les liens de navigation dans `app/routes/app.tsx`**

Chercher `NavMenu` ou les balises `<Link>` / `<a>` qui constituent la navigation. Ajouter un lien vers `/app/dashboard`.

Dans le composant qui rend la nav (chercher `<ui-nav-menu>`ou similaire), ajouter :
```tsx
<Link to="/app/dashboard" rel="dashboard">Dashboard</Link>
```

Si la nav utilise des balises `<a>` directes (style Shopify App Bridge) :
```tsx
<a href="/app/dashboard">Dashboard</a>
```

Placer le lien entre "Inbox" et "Settings" pour un ordre logique.

- [ ] **Step 2: Vérifier la compilation TypeScript**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Lancer l'app et vérifier le dashboard**

```bash
npm run dev
```

1. Ouvrir l'app dans le navigateur
2. Vérifier que "Dashboard" apparaît dans la nav
3. Cliquer → la page charge sans erreur (les chiffres peuvent être à 0 si le shop est vide)
4. Changer les presets 24h / 7j / 30j / 90j → les KPIs se rechargent
5. Vérifier que "État actuel · [date du jour]" est présent et ne change pas avec la période
6. Depuis l'inbox, changer l'état d'un thread → retourner au dashboard → vérifier que les stats conversations bougent

- [ ] **Step 4: Commit final**

```bash
git add app/routes/app.tsx
git commit -m "feat: add Dashboard link to app navigation"
```

---

## Self-Review

**Spec coverage check:**
- ✅ ThreadStateHistory model + onDelete: Cascade (Task 1)
- ✅ recordStateTransition helper (Task 2)
- ✅ recomputeThreadState instrumenté (Task 3)
- ✅ moveThread action instrumentée (Task 4)
- ✅ shop.redact webhook mis à jour (Task 5)
- ✅ getPeriodBounds avec presets + custom (Task 6)
- ✅ KPI cards avec comparaison période précédente (Task 7)
- ✅ getDailyBreakdown pour le bar chart (Task 7)
- ✅ getCurrentThreadStates — non filtré par période (Task 7)
- ✅ getConversationStats — nouvelles/résolues/rouvertes (Task 7)
- ✅ getIntentBreakdown top 5 (Task 7)
- ✅ Layout 2 colonnes (Task 8)
- ✅ "Mails envoyés" placeholder (Task 8)
- ✅ Label "État actuel · [date]" (Task 8)
- ✅ Nav Dashboard (Task 9)
- ✅ Recharts installé avec guard SSR (Task 8)
- ⚠️ customers.redact — ThreadStateHistory ne contient pas de PII (uniquement des états), donc pas de suppression nécessaire. Les threads sont scrubbed mais pas supprimés, et l'historique ne référence aucune donnée personnelle.
