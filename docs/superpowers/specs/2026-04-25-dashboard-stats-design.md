# Dashboard Stats — Design Spec

**Date:** 2026-04-25
**Status:** Approved

## Context

L'app aide les agents support à traiter des emails clients plus vite. Aujourd'hui il n'existe aucune visibilité globale sur l'activité : combien de mails reçus, combien sont du support réel, combien de brouillons générés, comment évoluent les conversations. Ce dashboard donne au marchand et à l'agent une vue consolidée de l'activité support sur une période choisie.

## Audience

Deux types d'utilisateurs sur la même page :
- **Marchand** — veut piloter l'activité support de son équipe (volumes, tendances, taux de résolution)
- **Agent support** — veut se situer dans sa file de travail (états actuels, nouvelles conversations)

Pas de données de coût LLM exposées (usage interne créateur d'app uniquement).

## Approche technique retenue

**Server-rendered + Recharts.** Route React Router standard avec loader Prisma, graphiques via Recharts (barchart interactif avec tooltips). La période est portée par les URL search params pour des URLs partageables. Pas d'API route dédiée — le loader suffit pour ce niveau de volumétrie.

## Nouveau modèle de données

### `ThreadStateHistory`

Historisation de chaque transition d'état opérationnel d'un thread. Inséré à chaque fois que `Thread.operationalState` change.

```prisma
model ThreadStateHistory {
  id        String   @id @default(cuid())
  shop      String
  threadId  String
  fromState String?  // null = état initial à la création
  toState   String
  changedAt DateTime @default(now())

  thread Thread @relation(fields: [threadId], references: [id], onDelete: Cascade)

  @@index([shop, changedAt])
  @@index([threadId, changedAt])
}
```

**Où insérer :** partout dans `app/routes/app.inbox.tsx` où `Thread.operationalState` est mis à jour (actions `moveThread`, `resolve`, `reopen`, etc.). Une seule zone de code à modifier.

**Suppression et conformité RGPD :**
- `onDelete: Cascade` sur la relation — si un Thread est supprimé, ses entrées d'historique partent avec.
- Les webhooks `webhooks.shop.redact.tsx` et `webhooks.customers.redact.tsx` devront inclure la suppression des `ThreadStateHistory` concernés (par shop ou par threadIds du client).
- Un resync normal ne touche pas `operationalState` → l'historique n'est pas affecté.

La relation inverse sur `Thread` :
```prisma
stateHistory ThreadStateHistory[]
```

## Sélecteur de période

Porté par les URL search params :
- **Presets** : `?range=24h`, `?range=7d`, `?range=30d`, `?range=90d` (défaut : `30d`)
- **Personnalisé** : `?from=2026-03-01&to=2026-03-31`

La période précédente pour la comparaison est calculée automatiquement (même durée, décalée en arrière).

## Métriques

### KPI Cards (4 cartes, ligne du haut)

| Carte | Source | Période |
|---|---|---|
| Mails reçus | `COUNT(IncomingEmail WHERE receivedAt IN period)` | ✅ filtrée |
| Support client | `COUNT(IncomingEmail WHERE tier2Result = 'support_client' AND receivedAt IN period)` | ✅ filtrée |
| Brouillons créés | `COUNT(ReplyDraft JOIN IncomingEmail WHERE receivedAt IN period)` | ✅ filtrée |
| Mails envoyés | `—` placeholder | N/A (future feature envoi) |

Chaque carte affiche la valeur absolue + variation `↑/↓ +X%` vs période précédente de même durée.

### Graphique (colonne gauche, sous les KPIs)

Bar chart Recharts — **volume de mails reçus par jour** sur la période. Deux séries superposées :
- Barre principale : tous mails reçus
- Barre secondaire (couleur différente) : mails support uniquement

Tooltip au survol affiche les deux valeurs.

### Panneau — États actuels (colonne droite, haut)

**Non filtré par période** — snapshot de l'état de la file à aujourd'hui. Label explicite : "État actuel · Aujourd'hui".

Source : `COUNT(Thread) GROUP BY operationalState WHERE shop = ?`

États affichés :
- Ouvert (rouge)
- Attente client (jaune)
- Attente nous (bleu)
- Résolu (vert)

### Panneau — Stats conversations (colonne droite, milieu)

**Filtré par période** — activité dans la fenêtre sélectionnée.

| Stat | Source |
|---|---|
| Nouvelles conversations | `COUNT(Thread WHERE firstMessageAt IN period)` |
| Conversations résolues | `COUNT(ThreadStateHistory WHERE toState = 'resolved' AND changedAt IN period)` |
| Conversations rouvertes | `COUNT(ThreadStateHistory WHERE fromState = 'resolved' AND toState != 'resolved' AND changedAt IN period)` |

### Panneau — Top intentions (colonne droite, bas)

**Filtré par période.**

Source : `COUNT(IncomingEmail) GROUP BY detectedIntent WHERE receivedAt IN period AND detectedIntent IS NOT NULL`

Affiche les 5 intentions les plus fréquentes avec leur count.

## Layout (2 colonnes)

```
┌─────────────────────────────────────────────────────────┐
│ Dashboard                [24h][7j][30j][90j][Perso ▾]   │
├───────────────────────────────┬─────────────────────────┤
│ [Reçus] [Support]             │ État actuel · Aujourd'hui│
│ [Brouillons] [Envoyés —]      │ ● Ouvert         47     │
│                               │ ● Attente client  23    │
│ ████ Bar chart                │ ● Attente nous    12    │
│ mails reçus / jour            │ ● Résolu         258    │
│ (tous + support superposés)   ├─────────────────────────┤
│                               │ Conversations (période) │
│                               │ Nouvelles          34   │
│                               │ Résolues           28   │
│                               │ Rouvertes           4   │
│                               ├─────────────────────────┤
│                               │ Top intentions          │
│                               │ Où est ma commande 148  │
│                               │ Remboursement       72  │
│                               │ Colis bloqué        54  │
└───────────────────────────────┴─────────────────────────┘
```

## Fichiers à créer ou modifier

| Fichier | Action |
|---|---|
| `prisma/schema.prisma` | Ajouter `ThreadStateHistory` + relation sur `Thread` |
| `prisma/migrations/` | Migration générée par `prisma migrate dev` |
| `app/routes/app.dashboard.tsx` | Nouvelle route (loader + composant) |
| `app/lib/dashboard-stats.ts` | Fonctions de requêtes agrégées |
| `app/routes/app.tsx` | Ajouter "Dashboard" dans la nav |
| `app/routes/app.inbox.tsx` | Insérer dans `ThreadStateHistory` à chaque transition d'état |

## `app/lib/dashboard-stats.ts` — API interne

```ts
getPeriodBounds(range: string, from?: string, to?: string): { start: Date; end: Date; prevStart: Date; prevEnd: Date }

getKpiStats(shop: string, start: Date, end: Date, prevStart: Date, prevEnd: Date): Promise<KpiStats>

getDailyBreakdown(shop: string, start: Date, end: Date): Promise<DailyPoint[]>

getCurrentThreadStates(shop: string): Promise<ThreadStateCounts>

getConversationStats(shop: string, start: Date, end: Date): Promise<ConversationStats>

getIntentBreakdown(shop: string, start: Date, end: Date): Promise<IntentCount[]>
```

## Dépendance ajoutée

**Recharts** — lib de charts React la plus répandue dans l'écosystème, compatible SSR via import dynamique ou `"use client"`. Utilisée uniquement pour le `BarChart` du dashboard.

```
npm install recharts
```

## Vérification / test end-to-end

1. Lancer l'app (`npm run dev`), se connecter avec un shop de test
2. Vérifier que "Dashboard" apparaît dans la nav
3. La page charge sans erreur avec des données réelles (même toutes à zéro si shop vide)
4. Changer les presets de période — les KPI et le graphique se mettent à jour
5. Tester la période personnalisée
6. Depuis l'inbox, changer l'état d'un thread → vérifier une ligne dans `ThreadStateHistory`
7. Revenir au dashboard — les stats conversations reflètent le changement
8. Vérifier que "État actuel" ne change pas quand on change la période
