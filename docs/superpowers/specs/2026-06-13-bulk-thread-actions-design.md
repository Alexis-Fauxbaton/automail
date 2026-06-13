# Sélection multiple & actions groupées dans l'inbox — Design

> Date : 2026-06-13
> Statut : design approuvé, en attente du plan d'implémentation
> Branche cible : à créer depuis `main`

## Problème

Aujourd'hui chaque conversation de l'inbox se gère une par une. Pour traiter du
volume (marquer plusieurs conversations résolues, en sortir plusieurs du flux
support, etc.) le marchand doit répéter le même geste N fois. On veut une
**sélection multiple** avec des **actions groupées**.

## Périmètre (v1)

Actions groupées retenues :

- **Marquer résolu / Rouvrir** — bascule `operationalState` vers `resolved` (et
  l'inverse pour rouvrir).
- **Déplacer vers un autre état** — `waiting_customer` / `waiting_merchant`.
- **Marquer non-support** — bascule `supportNature` vers `non_support`.

Hors périmètre v1 : génération de brouillons en masse (coût LLM + quota, à
cadrer séparément), suppression/archivage, sélection cross-page.

## Décisions de design

### Sélection (front)

- Une **case à cocher** par conversation listée. Le `onClick` d'ouverture de la
  ligne fait `stopPropagation` sur la case.
- Une case **« tout sélectionner »** en tête de liste qui coche les
  conversations **du filtre courant** (≤ 500 chargées — l'inbox charge
  `take: 500` et filtre côté client, pas de pagination serveur).
- L'état de sélection est un `Set<threadId>` côté composant inbox.
- **La sélection se vide au changement de filtre / recherche**, pour ne jamais
  agir sur des conversations devenues invisibles.
- Une **barre d'actions groupées** (`BulkActionBar`) apparaît dès que `size > 0`
  et affiche le compteur + les boutons d'action + « Désélectionner ».

### Confirmation + feedback

- Chaque action ouvre une `<dialog>` de confirmation :
  « Marquer 42 conversations comme résolues ? » → Confirmer / Annuler.
- Pas d'undo.
- Succès → toast « 42 conversations mises à jour » (+ « N ignorées » si
  `skipped > 0`).

### Avertissement quota (déplacer vers attente)

Déplacer une conversation vers `waiting_customer` / `waiting_merchant` affirme
« c'est du support » → flip `supportNature → confirmed_support` → et si la
conversation n'a **jamais été analysée** (`analyzedAt` nul), enfile un job
`analyze_thread` qui **consomme 1 unité de quota** (`markThreadAnalyzedIfFirst`).
C'est le comportement existant du chemin single ([handleMoveThread](../../../app/lib/support/inbox-actions.ts)).

On **conserve ce déclenchement en bulk** (cohérence stricte avec le single : un
lot doit faire exactement ce que ferait chaque action individuelle), mais le
popup **prévient explicitement** quand des analyses facturées vont partir :

> **Marquer 47 conversations comme « en attente de moi » ?**
> ⚠ 12 d'entre elles n'ont jamais été analysées et le seront maintenant — les
> passer en attente les confirme comme support. Cela consomme **12 analyses**
> de votre quota.

Le compte des conversations à analyser est **estimé côté client**, sans requête
preview. Il doit reproduire **exactement** la condition du site #2 (voir
ci-dessous), pas le bucket `to_analyze` (qui surévaluerait : il inclut les
`confirmed_support` jamais analysées, qui ne flippent pas et n'enfilent rien) :

> conversations sélectionnées **ET** action ∈ `{waiting_customer, waiting_merchant}`
> **ET** `supportNature ≠ confirmed_support` **ET** `analyzedAt = null`

Le loader envoie déjà `supportNature` + `analyzedAt` par conversation, donc le
compte est exact côté client.

Cet avertissement ne concerne **que** les deux actions « déplacer vers attente ».
« Résolu », « Rouvrir » et « Non-support » ne déclenchent aucune analyse.

#### Les 3 sites d'enqueue `analyze_thread` (pour l'implémenteur)

Le job `analyze_thread` est enfilé à **trois** endroits en prod — ne pas croire
que le bulk est le seul :

1. [auto-sync.ts](../../../app/lib/mail/auto-sync.ts) cron « stale-classify » —
   automatique, threads `unknown` à rattraper.
2. [inbox-actions.ts](../../../app/lib/support/inbox-actions.ts) `handleMoveThread`
   — déplacement vers attente : `supportNature ≠ confirmed_support` ET
   `analyzedAt = null`.
3. [inbox-actions.ts](../../../app/lib/support/inbox-actions.ts)
   `handleUpdateClassification` — reclassification manuelle vers une stance
   support, `analyzedAt = null`.

Le bulk **réimplémente la condition du site #2** (il ne réutilise pas
`handleMoveThread`, il fait ses écritures batchées). Il ne passe **jamais** par
le site #3 : « Non-support » fait un `updateMany` direct, pas
`handleUpdateClassification`. La condition d'enqueue côté serveur DOIT donc être
identique au site #2, et l'estimation popup côté client identique à celle-ci.

### Effets de bord déférés (reopen)

Le chemin single, sur reopen, relance un Tier 3 **inline**
(`refreshThreadAnalysis` : Shopify + 17track + crawl éventuel) pour rafraîchir le
tracking. Sur un bulk de plusieurs centaines de reopens, faire ça inline =
requête de plusieurs minutes + pic de coût + risque d'ouvrir le circuit breaker
17track partagé.

**Choix v1 :** le bulk fait les changements d'état immédiatement, mais **ne
relance pas le Tier 3 inline** sur reopen. Le tick `refresh-stale-analyses`
(toutes les minutes) rafraîchit le tracking des conversations rouvertes avec un
léger décalage. Compromis assumé : tracking à jour ~1 min plus tard, en échange
d'une requête bornée et d'aucun pic de coût.

## Architecture

### Handler serveur — `handleBulkThreadAction`

Nouveau handler dans [app/lib/support/inbox-actions.ts](../../../app/lib/support/inbox-actions.ts),
exposé via un nouvel intent `bulkThreadAction` dans l'action de
[app/routes/app.inbox.tsx](../../../app/routes/app.inbox.tsx).

Signature : `handleBulkThreadAction({ shop, threadIds, action, admin })`

Champs du formulaire :
- `_action = "bulkThreadAction"`
- `bulkAction ∈ { resolved, reopen, waiting_customer, waiting_merchant, non_support }`
- `threadIds` = tableau JSON d'IDs de threads canoniques.

Étapes :

1. **Garde-fous** : `action` dans l'ensemble autorisé ; `threadIds` non vide ;
   **cap à 500**. Sinon retour `{ updated: 0, skipped: 0 }`.
2. **Lecture scopée shop** (isolation multi-tenant + anti-falsification d'IDs) :
   ```
   prisma.thread.findMany({
     where: { id: { in: threadIds }, shop },
     select: { id, operationalState, supportNature, analyzedAt, mailConnectionId },
   })
   ```
   Tout ID n'appartenant pas au shop est silencieusement écarté.
3. **Écritures batchées** selon l'action :
   - `resolved` : raw `UPDATE "Thread" SET "previousOperationalState" =
     "operationalState", "operationalState" = 'resolved',
     "operationalStateUpdatedAt" = now() WHERE "shop" = $shop AND "id" IN (...)
     AND "operationalState" <> 'resolved'`. Idempotent : les déjà-résolus sont
     ignorés (comptés dans `skipped`).
   - `reopen` : raw `UPDATE "Thread" SET "operationalState" =
     COALESCE("previousOperationalState", 'waiting_merchant'),
     "previousOperationalState" = NULL, "operationalStateUpdatedAt" = now()
     WHERE "shop" = $shop AND "id" IN (...) AND "operationalState" = 'resolved'`.
     Les non-résolus sont ignorés.
   - `waiting_customer` / `waiting_merchant` : `updateMany` de l'état cible +
     `updateMany` du flip `supportNature → confirmed_support` (sur ceux dont
     `supportNature <> 'confirmed_support'`), `supportNatureUpdatedAt = now()`.
   - `non_support` : `updateMany` `supportNature = 'non_support'`,
     `supportNatureUpdatedAt = now()`. Action manuelle → on autorise le
     downgrade depuis `confirmed_support` (la règle sticky ne s'applique qu'aux
     transitions automatiques).
4. **Historique d'état** : `createMany` de `ThreadStateHistory` (from → to,
   `reason = "bulk_action"`) pour les conversations dont l'`operationalState` a
   réellement changé (calculé depuis les états lus à l'étape 2). `non_support`
   ne change pas l'`operationalState` → aucune entrée d'historique.
5. **Flip support → analyse** : pour les conversations passées en attente dont
   le `supportNature` a basculé vers `confirmed_support` et dont `analyzedAt`
   est nul, **enqueue `analyze_thread`** (même mécanique que le single). Cheap
   à l'enfilage ; la facturation reste 1×/conversation à l'analyse effective.
6. **Retour** : `{ updated: N, skipped: M }`.

Toutes les requêtes incluent `shop` dans le `WHERE`.

### Composant front — `BulkActionBar`

Nouveau composant [app/components/inbox/BulkActionBar.tsx](../../../app/components/inbox/BulkActionBar.tsx)
(on n'ajoute pas davantage de surface à `app.inbox.tsx`, déjà trop gros — cf.
CLAUDE.md). Props : compteur sélectionné, compteur « à analyser » estimé,
callbacks d'action, callback désélection. Rend la barre sticky + la `<dialog>`
de confirmation avec le texte adapté à l'action (et l'avertissement quota pour
les déplacements vers attente).

L'inbox tient le `Set<threadId>`, branche les cases, calcule le sous-ensemble
`to_analyze` sélectionné (pour le warning), et soumet le `fetcher` à la
confirmation.

## Découpage en unités

- `handleBulkThreadAction` (serveur) — pure logique métier, testable en
  isolation avec une vraie DB. Une entrée (shop, ids, action), une sortie
  (`{ updated, skipped }`), un effet (DB + enqueue).
- `BulkActionBar` (UI) — présentation pure, pilotée par props, aucune logique
  métier.
- État de sélection — local au composant inbox, vidé sur changement de filtre.

## Tests (intégration, vraie DB)

- Bulk `resolved` sur N conversations → `operationalState` + `ThreadStateHistory`
  corrects ; `previousOperationalState` capturé.
- **Shop-scoping** : des IDs appartenant à un autre shop sont ignorés (assert
  qu'ils ne bougent pas).
- Idempotence : conversation déjà résolue → comptée dans `skipped`, pas de
  doublon d'historique.
- `reopen` restaure `previousOperationalState` (et tombe sur `waiting_merchant`
  si nul).
- `non_support` met `supportNature` sans toucher `operationalState` ni écrire
  d'historique.
- `waiting_*` sur une conversation à stance non-`confirmed_support` jamais
  analysée → flip support + job `analyze_thread` enfilé.
- Cap à 500 respecté.

## Fichiers touchés

- `app/lib/support/inbox-actions.ts` — `handleBulkThreadAction`.
- `app/routes/app.inbox.tsx` — intent `bulkThreadAction` + état de sélection +
  cases à cocher + intégration `BulkActionBar`.
- `app/components/inbox/BulkActionBar.tsx` — **nouveau**.
- `app/i18n/locales/en.json` + `fr.json` — clés boutons / confirmation / toast /
  avertissement quota (vouvoiement côté fr).
- Tests d'intégration sous `app/lib/__tests__/integration/`.

## Hors périmètre / suites possibles

- Génération de brouillons en masse.
- Suppression / archivage groupé.
- Undo après action groupée.
- Sélection au-delà des 500 conversations chargées (cross-page).
