# Dashboard SAV — Design Spec (V1 utile)

**Date :** 2026-05-05
**Statut :** Approuvé (en attente de revue spec)
**Remplace :** étend [2026-04-25-dashboard-stats-design.md](./2026-04-25-dashboard-stats-design.md)

## Contexte et objectif

Le dashboard actuel (`app/routes/app.dashboard.tsx`) est une v0 essentiellement descriptive : volumes d'emails, états de threads, comptage de drafts. Il répond à « combien ? » mais pas à « comment je vais ? » ni « où je devrais investir mon temps ? ».

Cette V1 transforme le dashboard en **outil de pilotage**. Le triage opérationnel quotidien continue de se faire dans l'inbox ; le dashboard répond aux questions méta : qualité du service, productivité de l'IA, patterns de l'activité, signaux faibles à corriger.

## Audience

Marchand solo (et plus tard équipe) qui ouvre le dashboard 1 à 2 fois par semaine pour piloter son SAV. Daily triage = inbox. Dashboard = pilotage.

## Hors scope V1

- Notifications externes (email/Slack) sur les alertes — visible dashboard uniquement
- Breakdown par agent (multi-utilisateurs, à venir)
- Métrique « temps gagné grâce à l'IA » / ROI — pas en V1
- Coût IA exposé sur le dashboard — `LlmCallLog` existe mais reste interne
- Export PDF / CSV
- Comparaison de 2 périodes côte à côte
- Drill-down en panneau latéral / modal (les drill-downs renvoient vers l'inbox)

Tous ces points sont listés en *Future evolutions* à la fin du document.

## Questions auxquelles le dashboard répond

Priorités validées avec le marchand :

1. **Mon délai de 1<sup>re</sup> réponse** — médian, P90, par jour
2. **Threads ré-ouverts** — signal d'une mauvaise première réponse
3. **Taux d'utilisation des drafts IA** — envoyé tel quel / réécrit / ignoré
4. **Heures et jours de pic de volume** — pour planifier la journée
5. **Top intents sur lesquels je passe du temps** — pour identifier des macros possibles

S'ajoutent en V1 :

6. **Bandeau d'alertes** — signaux statistiques notables (volume, intent, délai, ré-ouvertures)
7. **Snapshot de la queue** — état des threads maintenant (open / waiting / resolved)
8. **Drill-down threads ré-ouverts récents**

## Layout cible

Single-page scrollable, hiérarchie descendante (« cockpit narratif »). Flux de lecture :

```
┌──────────────────────────────────────────────────┐
│ Hero : titre · sous-titre · sélecteur période    │
├──────────────────────────────────────────────────┤
│ Bandeau d'alertes (visible si ≥1 anomalie)        │
├──────────────────────────────────────────────────┤
│ 4 KPIs : Médian rép · Ré-ouverts · Drafts envoyés │
│           %  ·  Volume support                     │
├──────────────────────────────────────────────────┤
│ Section Qualité du service                        │
│   Chart : volume (barres) + médian/P90 (lignes)   │
├──────────────────────────────────────────────────┤
│ Section Productivité IA                           │
│   Chart : stacked bars / jour                     │
│           tel quel · réécrit · ignoré              │
├──────────────────────────────────────────────────┤
│ Patterns (2 colonnes) :                           │
│   • Heatmap jours × heures                        │
│   • Top intents avec performance                   │
├──────────────────────────────────────────────────┤
│ Drill-downs (2 colonnes) :                        │
│   • État du queue (snapshot maintenant)            │
│   • Threads ré-ouverts récents                     │
└──────────────────────────────────────────────────┘
```

Tous les blocs réutilisent les composants UI existants (`Card`, `MetricCard`, `Pill`, `StatRow`, `SegmentedTabs` dans `app/components/ui/`). Les graphes utilisent Recharts (déjà en dépendance).

## Sélecteur de période et baselines

### Préréglages

`24h` · `7d` · `30d` (défaut) · `90d` · `Custom` (from / to). Identique au v0. La période est portée par les URL search params (`?range=30d` ou `?range=custom&from=…&to=…`) pour des URLs partageables.

### Baselines (utilisées par le bandeau d'alertes)

Les baselines doivent respecter la saisonnalité hebdomadaire et rester robustes au bruit.

| Période courante | Baseline |
|---|---|
| **24h** (today) | Moyenne des **4 derniers même-DOW** (jour de semaine identique). Si lundi → moyenne des 4 derniers lundis. |
| **7d** | Moyenne des **4 dernières fenêtres glissantes de 7j** précédant la période courante. Les DOW s'équilibrent dans la fenêtre. |
| **30d** | Moyenne des **3 dernières fenêtres glissantes de 30j** (= 90j antérieurs / 3). |
| **90d** | **Pas d'alertes calculées sur cette période.** Seulement 4 fenêtres antérieures dans une année — données instables, faux positifs probables. Le bandeau est masqué sur cette période. |
| **Custom** | Pas d'alertes (la longueur peut être quelconque, pas de baseline universelle). |

## Bandeau d'alertes

### Affichage

- 0 alerte → **bandeau caché** (le dashboard est plus calme)
- 1 à 3 alertes → toutes affichées
- 4 ou + → top 3 par « ampleur de l'écart vs baseline » + ligne « +N autres »
- Période 90d ou Custom → bandeau toujours caché (pas de baseline)

### Règles de détection

Une alerte se déclenche si **(a)** la métrique dépasse 2× sa baseline, **et (b)** le volume absolu atteint un seuil minimal (anti-bruit). Les seuils sont des défauts ; ils peuvent être affinés après usage réel.

| Type | Métrique | Condition | Volume min |
|---|---|---|---|
| **Surge d'intent** | `count(threads where firstMessageAt ∈ période, intent = X)` | ≥ 2× baseline | ≥ 5 threads |
| **Volume global** | `count(threads support ∈ période)` | ≥ 2× baseline | ≥ 20 threads |
| **Délai dégradé** | `median(first response time, today)` | ≥ 2× rolling 14j | ≥ 3 réponses |
| **Ré-ouvertures** | `count(reopens ∈ période)` | ≥ 2× baseline | ≥ 3 reopens |

### Format d'une alerte

Texte court, factuel, action implicite : « damaged_product ×2.8 vs habituel (12 cette semaine vs 4 attendus) ». Lien `Voir l'inbox →` qui pré-filtre l'inbox sur l'intent ou la période concernée.

## KPIs (4 cartes)

### 1. Médian 1<sup>re</sup> réponse

**Définition** : pour chaque thread support dont `Thread.firstMessageAt ∈ période` ET dont le premier message est entrant (client), délai entre `firstMessageAt` et le premier `IncomingEmail` sortant (`processingStatus = 'outgoing'`) du même thread. Médian sur tous les threads qualifiés.

**Threads exclus** :
- Threads où le premier message est sortant (le marchand a initié) → pas de question client à laquelle répondre
- Threads où aucun message sortant n'existe encore → réponse en attente, pas de valeur calculable
- Threads non-support (`supportNature = 'non_support'`)

**Variation** : vs même métrique sur la période précédente, formule `(current − prev) / prev × 100`. Affiche `—` si `prev = 0`.

**Sens du delta** : une baisse est positive (vert ↓), une hausse est négative (rouge ↑).

### 2. Threads ré-ouverts

**Définition** : `count(ThreadStateHistory)` avec `fromState = 'resolved' AND toState != 'resolved' AND changedAt ∈ période`.

**Variation** : vs période précédente.

**Sens du delta** : une hausse est négative (signal de qualité dégradée).

### 3. Drafts envoyés (%)

**Définition** : sur les `ReplyDraft` dont `createdAt ∈ période` ET classifiés (bucket non-`pending`) :
```
(count as_is + count edited) / (count as_is + count edited + count ignored)
```

**Sous-titre** : breakdown des trois buckets en pourcentages.

**Calcul du bucket** : voir section *Heuristique d'utilisation des drafts* ci-dessous.

**Variation** : vs période précédente sur le même calcul.

### 4. Volume support

**Définition** : `count(IncomingEmail)` entrants (`processingStatus != 'outgoing'`) filtrés support :
```sql
tier2Result = 'support_client'
OR thread.supportNature IN ('confirmed_support', 'probable_support')
```
Filtre par `receivedAt ∈ période`. Identique à la définition v0 du KPI `supportEmails`.

**Variation** : vs période précédente.

## Heuristique d'utilisation des drafts

Section critique : à documenter et tester soigneusement parce que c'est le cœur du KPI 3 et qu'elle évoluera avec l'envoi natif.

### Pourquoi heuristique

L'app n'envoie pas elle-même les emails — le marchand envoie depuis Gmail / Zoho / Outlook. On ne peut donc pas savoir directement si un draft généré a été envoyé tel quel, modifié, ou ignoré. On le déduit **a posteriori** en comparant le draft au message sortant ré-ingéré par le sync mail.

### Algorithme

Pour chaque `ReplyDraft` :

1. **Trouver le message sortant correspondant** : `IncomingEmail` avec `canonicalThreadId = draft.email.canonicalThreadId`, `processingStatus = 'outgoing'`, et `receivedAt > draft.createdAt`. Prendre le **plus ancien** (premier sortant après création du draft).

2. **Si aucun sortant** → bucket `pending`. Exclu du calcul du KPI.

3. **Si un sortant existe** → comparer `draft.body` (ou la version au moment de l'envoi, voir Edge cases) au `outgoing.bodyText`.

4. **Normalisation avant comparaison** :
   - Strip HTML (drafts peuvent être HTML, sortants peuvent l'être aussi)
   - Strip texte cité (« Le 12/05/2026, X a écrit : ... »)
   - Strip signature (matchée depuis `SupportSettings.signatureName` + heuristique « -- » ou ligne courte au début/fin)
   - Lowercase, normalize whitespace, strip accents

5. **Calcul de similarité** : Levenshtein normalisé sur strings normalisées. Alternative : trigrammes Postgres `pg_trgm` (extension à activer si pas déjà fait) pour pouvoir le faire SQL-side.

6. **Buckets** :
   - `sim ≥ 0.85` → **`as_is`** (envoyé tel quel, marge pour signature/whitespace)
   - `0.30 ≤ sim < 0.85` → **`edited`** (réécrit partiellement)
   - `sim < 0.30` → **`ignored`** (le marchand a écrit autre chose, le draft n'a pas servi)

7. **Cas où il y a un sortant mais pas de draft du tout** → bucket `ignored` direct (le marchand a répondu sans passer par l'IA).

### Stockage et trigger

Nouveaux champs sur `ReplyDraft` :

```prisma
model ReplyDraft {
  // ... champs existants

  /// Heuristic draft-usage classification, computed retrospectively when an
  /// outgoing reply is ingested in the same thread.
  /// Values: "as_is" | "edited" | "ignored" | null (= pending, not yet computed).
  /// Null means: no outgoing exists yet, or the heuristic hasn't run.
  heuristicBucket      String?

  /// Timestamp of last computation. Re-computed when a new outgoing arrives
  /// in the thread (in case a later sortant changes the answer).
  heuristicComputedAt  DateTime?

  @@index([shop, heuristicBucket, createdAt])
}
```

**Trigger** : à la fin du sync mail, pour chaque thread où un nouveau message sortant a été ingéré, ré-évaluer les `ReplyDraft` du thread qui ont `heuristicBucket = NULL` ou dont la dernière computation est antérieure au sortant.

Lieu d'insertion : dans le pipeline de sync, après `recomputeThreadState`. Module dédié `app/lib/support/draft-usage-heuristic.ts`.

### Edge cases

- **Le marchand édite un draft après avoir envoyé** (`draft.updatedAt > outgoing.receivedAt`) : on compare contre la **version du draft à l'instant du sortant**. `bodyHistory` (JSON array sur `ReplyDraft`) contient déjà l'historique des éditions. Si l'historique manque les timestamps, on prend la première version du draft (`bodyHistory[0]`) faute de mieux. Documenter et tester.
- **Plusieurs sortants après le draft** : on prend le premier. Les sortants ultérieurs ne sont pas re-comparés.
- **Sortant existe avant le draft** : ignoré pour le calcul du draft (le marchand avait déjà répondu).
- **Email sortant en HTML enrichi (images, formattage)** : la normalisation strip le HTML. Si le strip échoue (HTML mal formé), bucket `ignored` par défaut + log d'erreur.
- **Threads sans `canonicalThreadId`** (legacy) : exclus du calcul.

### Migration future vers l'envoi natif

L'envoi natif est planifié à court terme. Quand il arrivera :

1. Nouveaux champs sur `ReplyDraft` : `sentAt: DateTime?`, `bodyAtSend: String?`, `usedBucket: String?` (`"as_is" | "edited" | null`).
2. Le bouton « Envoyer » dans l'app écrit `sentAt`, `bodyAtSend`, et calcule `usedBucket` exactement (comparaison avec le `body` au moment du clic).
3. Nouveau bouton « Composer sans utiliser le draft » → `usedBucket = "ignored"` direct, pas de comparaison.
4. **Le KPI Drafts envoyés % lit en priorité `usedBucket` si non-null, fallback sur `heuristicBucket` sinon.** Une seule métrique unifiée, sans double-affichage.
5. Pour les threads pré-envoi-natif : l'heuristique reste la source.

L'heuristique ne sera donc pas supprimée — elle reste comme fallback historique. Mais sa pertinence se réduira au fil du temps.

## Section *Qualité du service* (graphe)

**Composant** : graphe combiné (volume + lignes de délai) par jour.

**Données** :
- Barres : volume support par jour (proche du chart existant `getDailyBreakdown`)
- Ligne médiane : médian du délai de 1<sup>re</sup> réponse pour les threads dont `firstMessageAt = ce jour`
- Ligne P90 : P90 du même délai

**Lecture attendue** : voir d'un coup d'œil les jours où le délai s'est dégradé, et corréler avec le volume.

**Empty state** : si moins de 3 threads qualifiés sur la journée, lignes interpolées ou trous (à décider en implémentation, par défaut trous).

## Section *Productivité IA* (graphe)

**Composant** : stacked bars par jour, 3 segments.

**Données** : pour chaque jour, count des `ReplyDraft.heuristicBucket` (ou `usedBucket` quand l'envoi natif sera là), groupés en `as_is` / `edited` / `ignored`. Les `pending` sont exclus.

**Lecture attendue** : si une journée est dominée par du gris (`ignored`), l'IA n'a pas servi ce jour-là. Si c'est très bleu foncé (`as_is`), l'IA a fait le boulot.

**Note d'affichage** : sous-titre du card mentionne « Calculé heuristiquement (similarité draft / message envoyé) jusqu'à l'envoi natif » pour transparence.

## Section *Patterns* (2 colonnes)

### Heatmap jours × heures

Grille 7 jours (Lun → Dim) × 24 heures. Chaque cellule = count des `IncomingEmail` entrants support reçus à cette plage horaire / DOW sur la période.

Source : `IncomingEmail.receivedAt` filtré support (même filtre que KPI Volume support), agrégé en jours de semaine + heures locales (timezone `Europe/Paris`, déjà utilisée dans `dashboard-stats.ts`).

Couleur : intensité linéaire par rapport au max sur la grille. Tooltip : `Lundi 10h · 14 emails`.

**Performance** : un GROUP BY sur EXTRACT(dow, hour) en SQL raw, indexé sur `(shop, receivedAt)` (index existant). < 100ms même à 100k emails.

### Top intents avec performance

Remplace le bloc `topIntents` du v0 (qui ne montrait que les counts).

**Pour chaque thread** dont `firstMessageAt ∈ période` :
- L'intent attribué = **dernier verdict effectif** (LLM ou manuel, voir section *Intent et overrides manuels*)
- 1 thread = 1 vote (pas de double-comptage par message)

**Affichage** : top 5 intents triés par count décroissant, avec :
- Count de threads
- Médian du délai de 1<sup>re</sup> réponse pour cet intent (sur les threads qualifiés)
- Pill de couleur selon urgence (rouge pour `damaged`/`refund`, jaune pour `delivery_delay`, neutre sinon)
- Click → ouvre l'inbox pré-filtrée sur cet intent + cette période

**Threads non classés** (`detectedIntent` null sur le dernier message ET pas de `manualOverrides.intents`) : exclus du top 5, comptés à part dans une ligne « Non classé : N ».

## Section *Drill-downs* (2 colonnes)

### État du queue (snapshot)

Identique au v0 (`getCurrentThreadStates`) : count par `Thread.operationalState`. **Pas filtré par période** — c'est la photo actuelle de la file.

5 lignes : `open` (rouge) · `waiting_customer` (orange) · `waiting_merchant` (bleu) · `resolved` (vert) · `no_reply_needed` (gris).

### Threads ré-ouverts récents

Liste des `ThreadStateHistory` rows avec `fromState = 'resolved' AND toState != 'resolved' AND changedAt ∈ période`, groupés par `threadId` :

- Ordre : nombre de ré-ouvertures décroissant, puis date de dernière ré-ouv décroissante
- Limite : top 10
- Affichage par ligne : `#numéro · pill intent · sujet (tronqué) · "il y a Xj"  ·  Nx`
- Click → ouvre le thread dans l'inbox

## Intent et overrides manuels

### Comportement actuel constaté (à corriger — voir *Prerequisite*)

L'intent est classé au niveau du thread mais stocké sur le « anchor » = dernier `IncomingEmail` entrant. Quand un nouveau message client arrive :

- **Path `reanalyzeEmail`** ([app/lib/gmail/pipeline.ts:1300-1346](../../app/lib/gmail/pipeline.ts#L1300-L1346)) : lit `previous.manualOverrides?.intents` et passe `reuseIntents` à l'orchestrateur → respecte l'override manuel ✅
- **Path `classifyAndDraft`** ([app/lib/gmail/pipeline.ts:1011-1046](../../app/lib/gmail/pipeline.ts#L1011-L1046)) : appelle `analyzeSupportEmail()` **sans** lire `manualOverrides` du précédent anchor → le LLM re-classifie sur le nouveau message → `detectedIntent` du nouveau anchor reflète le verdict LLM, **pas** l'override manuel utilisateur

Conséquence : l'override manuel est silencieusement écrasé sur les messages suivants. Le `manualOverrides.intents` marker reste posé sur l'ancien anchor mais le « current intent » du thread (lu via le dernier `detectedIntent` non-null) bascule sur le verdict LLM.

### Prerequisite : fix dans `classifyAndDraft`

**Avant que le dashboard puisse refléter fidèlement les choix utilisateur**, ce path doit aligner son comportement sur `reanalyzeEmail` :

1. Avant l'appel à `analyzeSupportEmail()` à la ligne 1011 : charger l'anchor précédent du thread (`IncomingEmail` le plus récent du même `canonicalThreadId` avec `analysisResult` non null).
2. Si l'anchor précédent a `manualOverrides.intents` dans son `analysisResult` JSON, construire `reuseIntents` (intent + intents + identifiers) à partir de cet `analysisResult`.
3. Passer `reuseIntents` à `analyzeSupportEmail()`.
4. Préserver `manualOverrides` dans le nouvel `analysisResult` après l'appel (« porter en avant » comme le fait `reanalyzeEmail` ligne 1344-1346).
5. Bénéfice collatéral : les drafts générés respecteront aussi le choix manuel.

**Risque** : ce fix peut affecter d'autres parties du pipeline si `manualOverrides.intents` est consulté ailleurs. Mitigation : tests unitaires + un test d'intégration qui simule la séquence (msg1 → manual override → msg2).

### Conséquence pour le dashboard

Une fois le fix posé, la règle simple **« intent du thread = `detectedIntent` du dernier `IncomingEmail` avec `detectedIntent != null` du thread »** est correcte dans tous les cas (LLM ou manuel).

**Sans le fix**, le dashboard mentirait sur les threads avec override + nouveau message → bug coûteux pour la confiance utilisateur. D'où le statut de prerequisite obligatoire.

### Future v2 : qualité de classification du LLM

Métrique « % de threads où l'utilisateur a corrigé le LLM » lue sur `analysisResult.manualOverrides.intents`. Hors V1.

## Architecture technique

### Route et loader

`app/routes/app.dashboard.tsx` réécrit. Loader unique qui :

1. Authentifie + récupère `shop`
2. Lit `range` / `from` / `to` depuis les search params
3. Calcule `bounds` (start, end, prevStart, prevEnd, baselines pour alertes)
4. Lance toutes les requêtes en parallèle via `Promise.all` :
   - `getKpiStats` (4 nouveaux KPIs)
   - `getQualityChart` (volume + médian + P90 par jour)
   - `getProductivityChart` (stacked buckets par jour)
   - `getHeatmap` (DOW × hour)
   - `getTopIntentsWithPerf` (top 5 + médians)
   - `getCurrentThreadStates` (snapshot, identique v0)
   - `getReopenedThreads` (drill-down)
   - `getAlerts` (calcul des anomalies)
5. Retourne le tout dans le loader response

Estimation : ~10 requêtes en parallèle. Indexées correctement, < 500ms à 10k threads sur Postgres standard.

### Module agrégation : `app/lib/dashboard-stats.ts`

Étendu, pas dupliqué. On garde les fonctions existantes utiles (`getPeriodBounds`, `getCurrentThreadStates`, `getDailyBreakdown` si réutilisable). On ajoute :

- `getKpiStatsV2(shop, bounds)` — les 4 nouveaux KPIs
- `getResponseTimeStats(shop, start, end)` — médian + P90 sur la période, et la même chose par jour pour le chart
- `getDraftUsageStats(shop, start, end)` — répartition des buckets, total, %
- `getDraftUsageDailyBreakdown(shop, start, end)` — pour le chart productivité
- `getHeatmap(shop, start, end)` — DOW × hour
- `getTopIntentsWithPerf(shop, start, end)` — count par intent + médian rép
- `getReopenedThreads(shop, start, end, limit)` — drill-down
- `getAlerts(shop, bounds, baselines)` — calcul des 4 types d'alertes

Les anciennes fonctions inutilisées par le nouveau dashboard (`getDailyActivityBreakdown`, `getConversationStats`, `getIntentBreakdown`) sont supprimées si plus aucun appelant ne les utilise.

### Module heuristique drafts : `app/lib/support/draft-usage-heuristic.ts`

Nouveau module. Exports :

- `classifyDraft(draft, outgoing)` — pure, prend un draft et un sortant, retourne `'as_is' | 'edited' | 'ignored'`. Tests unitaires faciles.
- `normalizeBody(html | text)` — pure, retourne string normalisée. Testable.
- `computeSimilarity(a, b)` — pure (Levenshtein normalisé ou wrapper pg_trgm).
- `evaluateThread(canonicalThreadId, shop)` — async, retrouve les drafts du thread, leurs sortants associés, met à jour `ReplyDraft.heuristicBucket` + `heuristicComputedAt`.

Branchement : appelé après `recomputeThreadState` dans le pipeline de sync, pour chaque thread où un nouveau sortant a été ingéré.

### Composants UI

Nouveaux composants dans `app/components/ui/` (ou inline dans `app.dashboard.tsx` selon réutilisation) :

- `<AlertBanner alerts={…} />` — bandeau d'alertes avec collapse si 0 alerte
- `<HeatMap data={…} />` — wrap de cellules SVG ou Grid CSS, sans nouvelle dépendance
- `<StackedDailyBars data={…} />` — wrap Recharts pour le chart productivité
- `<QualityCombinedChart data={…} />` — wrap Recharts pour le chart qualité (Bar + Line)
- `<TopIntentsList items={…} />` — extension de `StatRow` avec pill + métadonnées

`MetricCard`, `Card`, `Pill`, `SegmentedTabs` réutilisés tels quels.

## Modèle de données

### Changements

**`ReplyDraft`** — ajouter 2 colonnes :

```prisma
model ReplyDraft {
  // ... existant

  heuristicBucket      String?
  heuristicComputedAt  DateTime?

  @@index([shop, heuristicBucket, createdAt])
}
```

Migration Prisma standard. Backfill d'une seule passe (script ponctuel) pour les drafts existants : pour chaque draft, run `evaluateThread`. Tolérant aux échecs (un draft non classé reste `null` = `pending`).

**Aucun autre changement de schéma en V1.** Tout le reste se calcule depuis les tables existantes (`Thread`, `IncomingEmail`, `ThreadStateHistory`).

### Indexation

Les indexes existants couvrent les requêtes prévues :

- `IncomingEmail @@index([shop, receivedAt])` → daily breakdown + heatmap
- `IncomingEmail @@index([shop, detectedIntent])` → top intents
- `Thread @@index([shop, lastMessageAt])` → snapshots
- `ThreadStateHistory @@index([shop, changedAt])` → ré-ouvertures + reopened drill-down
- Nouvel index `ReplyDraft @@index([shop, heuristicBucket, createdAt])` → KPI 3 + chart productivité

Pas d'index supplémentaire prévu en V1. À surveiller si la heatmap devient lente (envisager un index fonctionnel sur `EXTRACT(dow, receivedAt)` mais peu probable nécessaire).

## Performance et caching

V1 : **calcul on-the-fly à chaque page load**. Estimation < 500ms à 10k threads / 50k emails. Acceptable pour un dashboard 1 à 2 fois par semaine.

Pas de cache applicatif en V1. Si la latence dépasse 1s à mesure que les volumes croissent :

- Étape 1 : cache mémoire par shop avec TTL 5 min (Map en RAM côté serveur, invalidé sur sync mail)
- Étape 2 : table `DashboardCache` matérialisée nightly
- Étape 3 : pré-calcul incremental côté pipeline

Ces étapes restent à la portée d'évolution V1.x sans changer le contrat du loader.

## Internationalisation

Toutes les chaînes via `useTranslation()` / `t('dashboard.…')` comme le v0. Les nouveaux libellés sont ajoutés dans `app/i18n/locales/{fr,en}/translation.json`. Liste exhaustive à produire pendant l'implémentation, à minima :

- Hero / sous-titre
- Sélecteur période
- Bandeau d'alertes (4 templates de message + lien CTA)
- Libellés KPIs (4 + leurs sous-titres)
- Titres / sous-titres des sections
- Légendes des charts
- Libellés des intents (déjà i18n via `analysis.intent_…`)
- États de queue (déjà i18n)

## Gestion des erreurs et edge cases

- **Période sans donnée** : tous les KPIs affichent leur valeur (0, `—`, ou similaire). Charts vides → empty states courts (« Pas de données sur cette période »). Pas d'erreur.
- **Boutique nouvellement installée** (< 14 jours d'historique) : pas de baseline calculable → bandeau d'alertes caché (information, pas erreur).
- **Très grande période (90d / Custom long)** : queries plus lourdes. Si dépassement timeout, fallback sur message « Période trop large, choisis 30j ou moins » (à éviter par optimisation).
- **Thread sans `canonicalThreadId`** : exclu de toutes les agrégations qui utilisent le thread (réponse, intent, ré-ouv).
- **Email sortant sans body** (sync raté) : draft associé reste `pending`. Pas d'erreur.
- **Override manuel sur un thread sans premier message entrant** (cas théorique) : exclu du top intents (même règle que sans override).
- **Fuseau horaire** : tous les buckets jour utilisent `Europe/Paris` (cohérent v0). À reconsidérer en V2 si multi-tenant nécessite per-shop timezone.

## Tests

Stratégie pyramidale :

### Tests unitaires (priorité haute)

- `app/lib/support/draft-usage-heuristic.ts`
  - `normalizeBody` sur HTML, plain text, signature, citation
  - `computeSimilarity` sur strings identiques, légèrement différentes, totalement différentes
  - `classifyDraft` sur les 4 buckets (as_is, edited, ignored, pending)
- `app/lib/dashboard-stats.ts`
  - `getResponseTimeStats` avec threads inversés (sortant en premier), threads sans sortant, threads multi-rounds
  - `getAlerts` avec data en-dessous / au-dessus du seuil, période 90d (silencieuse), volume insuffisant
  - Baselines DOW-aware sur 24h, rolling sur 7d/30d
- Helpers de période / baseline (cas limite : changement d'heure été/hiver, week-ends, jours fériés)

### Tests d'intégration

- Pipeline de sync ingère un sortant → l'heuristique se déclenche → `ReplyDraft.heuristicBucket` se met à jour
- Manual override + nouveau message client → `detectedIntent` du nouveau message reste cohérent avec l'override (test du *prerequisite*)
- Loader du dashboard sur shop avec data réaliste → réponse cohérente, pas de crash

### Tests E2E

- Page dashboard charge sans erreur sur un shop vierge
- Page dashboard avec data charge avec tous les blocs visibles
- Sélecteur de période re-charge les données
- Click sur drill-down (top intents, ré-ouverts) → navigation vers inbox filtrée

## Risques et limites assumées

| Risque | Mitigation |
|---|---|
| Heuristique drafts imparfaite (faux as_is / faux edited) | Documentée transparente dans l'UI ; remplaçable par envoi natif sans changer le KPI |
| Top intents rate les évolutions intra-thread | Limite assumée, V2 considérera tracking historique des changements d'intent |
| Bandeau d'alertes peut être trop sensible / pas assez | Seuils 2× et volumes min ajustables après usage réel ; pas de logique de désactivation utilisateur en V1 |
| Subject normalization (V1 dégage cette piste) | Remplacée par `detectedIntent` plus fiable |
| Performance sur très grosses boutiques | < 500ms à 10k threads attendu ; cache prévu en V1.x si besoin |
| Bug `classifyAndDraft` non corrigé dégrade le dashboard | **Prerequisite obligatoire** — fix requis avant de merger le dashboard |

## Future evolutions

Hors scope V1, à cadrer ensuite :

- **V1.1 — Envoi natif depuis l'app** : `ReplyDraft.sentAt` + `bodyAtSend` + `usedBucket` exact, fallback heuristique conservé pour rétro-compat. Le KPI 3 unifié.
- **V1.2 — Délais subséquents** : métrique « time to nth response » pour les rounds 2, 3, ... d'un thread.
- **V1.3 — Threads sans réponse depuis > 24h** : alerte dédiée au pilotage (« 6 threads ouverts depuis plus de 24h »).
- **V2 — Notifications externes** : bandeau d'alerte envoyé aussi par email / Slack si configuré.
- **V2 — ROI / temps gagné** : estimation basée sur taux d'envoi, longueur moyenne des réponses, etc.
- **V2 — Coût IA par draft** : exposition de `LlmCallLog` sur le dashboard (currently interne).
- **V2 — Breakdown par agent** (multi-utilisateurs) : performance individuelle, draft usage, etc.
- **V2 — Clustering questions par embeddings** : remplace le top intents simple par sous-thèmes plus fins (« wismo / pas reçu » vs « wismo / quand vais-je le recevoir »).
- **V2 — Alertes côté tracking** : « Carrier X = 30 % de retard cette semaine » — exploite le tracking-service.
- **V2 — Drill-downs en panneau latéral** : alternative à la nav vers inbox.
- **V2 — Export PDF / CSV mensuel** : retrospective formattée.
- **V2 — Comparaison de 2 périodes côte à côte** : « ce mois vs mois dernier » avec deltas explicites.
- **V2 — Qualité de classification LLM** : « % de threads où le marchand a corrigé le LLM ».

## Ouvrages dépendants

Ordre d'implémentation recommandé (à confirmer par le plan) :

1. **Prerequisite** — fix `classifyAndDraft` pour respecter `manualOverrides.intents` + tests
2. Modèle data : ajout des 2 champs `ReplyDraft` + migration + backfill script
3. Module `draft-usage-heuristic.ts` + tests unitaires
4. Branchement de l'heuristique dans le pipeline sync
5. Extension de `dashboard-stats.ts` (nouvelles fonctions + tests)
6. Composants UI (alert banner, heatmap, charts)
7. Réécriture de `app.dashboard.tsx`
8. i18n : nouvelles clés
9. Tests d'intégration + E2E
10. Suppression des helpers v0 obsolètes

Le plan d'implémentation détaillé sera produit séparément.

---

**Validation requise** : revue de cette spec avant de produire le plan d'implémentation.
