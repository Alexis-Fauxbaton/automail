# Plans payants Automail — design

**Date :** 2026-05-08
**Statut :** Design validé, prêt pour planification
**Auteur :** Alexis Fauxbaton + Claude

## Contexte

Automail est aujourd'hui utilisable single-store sans facturation. L'objectif est de mettre en place un modèle de plans payants pour préparer la distribution publique sur le Shopify App Store. Cette spec couvre :

- Le modèle commercial (plans, prix, quotas, trial)
- Le comportement produit autour du quota (catch-up, sync suspendue, communication)
- L'architecture technique (Shopify Billing API, compteurs, entitlements)
- Les cas limites et la stratégie de tests
- Le rollout pour les shops déjà installés

Le design a été itéré en plusieurs passes pour résoudre les tensions entre maîtrise du coût LLM, expérience marchand, simplicité d'implémentation, et lisibilité du modèle commercial.

## Modèle commercial

### Structure des plans

| | Trial | Starter | Pro |
|---|---|---|---|
| Prix | Gratuit | $9 / mois | $49 / mois |
| Durée | 14 jours | Récurrent | Récurrent |
| Drafts générés / mois | Illimité | 50 | 500 |
| Boîtes mail connectées | 1 | 1 | 3 |
| Dashboard | Complet, 90j | Simplifié, 7j | Complet, 90j |
| Heatmap, alertes, reopened, comparaisons | ✅ | ❌ | ✅ |

### Choix justifiés

- **Trial puis paliers payants** plutôt que freemium : monétise plus tôt, évite le free-rider.
- **2 paliers** plutôt que 3 : simplicité de communication et de maintenance pour le lancement. Un palier intermédiaire "Growth" pourra être ajouté après observation des distributions d'usage réelles.
- **Trial 14 jours** : standard Shopify Billing, durée suffisante pour qu'un marchand observe un cycle SAV réel.
- **Hard cap au quota** : marges prévisibles, pas de surcoût caché côté LLM. Risque atténué par les mécanismes de communication multicouche et l'upgrade mid-cycle.
- **Prix $9 / $49** : ratio 5.4× pour un quota 10×, incite à l'upgrade dès que volume dépasse Starter. Marge brute attendue ~70-90% selon le coût LLM réel.

### Définition d'unité de quota

**1 unité = 1 draft généré par le LLM.** Strictement. Aucune autre action n'incrémente.

| Action | Coût LLM | Compteur |
|---|---|---|
| Premier draft sur un nouveau message client | 1 génération | +1 |
| Refine avec instructions | 1 génération | +1 |
| Regenerate complet | 1 génération | +1 |
| Edit manuel par le marchand | 0 | 0 |
| Re-analyse (refresh stale > 24h) sans draft | 0 (analyse seule) | 0 |
| Classification d'intent à l'arrivée d'un mail | 0 | 0 |
| Tracking refresh sur thread actif | 0 | 0 |

L'analyse seule (intent + identifiers + tracking) ne consomme jamais d'unité. Cela représente un coût LLM "overhead" pour Automail, jugé acceptable car borné en volume (threads actifs uniquement).

### Comportement de fin de trial

À l'expiration du trial sans choix de plan : l'app passe en **lecture seule**. Plus d'analyses ni de drafts. L'historique reste consultable. Modal bloquant `Trial terminé. Choisis un plan pour continuer.`

### Comportement de fin de plan payant

À l'annulation effective d'un plan payant : même comportement que trial expiré, lecture seule.

### Quota dépassé en cours de période

L'app passe en **mode quota dépassé** :

- Sync mail **suspendue** (pas de pull Gmail/Outlook/Zoho)
- Inbox principale figée à l'état pré-blocage, navigation/lecture possibles
- Boutons `Generate draft`, `Refine`, `Regenerate` désactivés avec tooltip
- Top bar counter en rouge, bannière non-dismissible, modal sur action de génération

Les emails restent côté serveur mail (Gmail/Outlook), aucune perte de donnée. À l'upgrade ou au reset mensuel, sync reprend selon la stratégie de catch-up décrite plus bas.

### Reset mensuel

Le compteur d'usage repart à 0 le **1er du mois UTC**. Choix d'UTC pour éviter les bugs de bord avec les timezones de shops différentes.

### Upgrade mid-cycle

- Géré nativement par Shopify Billing API via `appSubscriptionCreate` avec `replacementBehavior: STANDARD`
- Crédit prorata appliqué automatiquement par Shopify
- **Le compteur d'usage du mois en cours n'est pas réinitialisé** : si Starter à 50/50 et upgrade vers Pro, le marchand a 450/500 restants. Standard SaaS, évite double-paiement et double-quota.

### Downgrade

Asymétrie volontaire vis-à-vis de l'upgrade :

- Le downgrade est **planifié pour la fin de la période payée en cours**
- Le marchand garde ses features Pro jusqu'à la date d'expiration
- Stocké dans une table `BillingScheduledChange { shop, fromPlan, toPlan, effectiveAt }`
- À l'effectiveAt, un job exécute `appSubscriptionCreate` vers le nouveau plan
- UI : `Plan Pro actif jusqu'au [date]. Passage à Starter prévu le [date]. [Annuler le changement]`

## Comportement produit autour du quota

### Folder dédié "À analyser"

Un folder de premier niveau dans la navigation latérale, séparé de l'inbox principale.

**Contenu** : tout thread ayant **au moins un message inbound non encore analysé**. Localisation dérivée de l'état du thread, pas une copie.

**Inbox principale = uniquement les threads avec tous les messages analysés.** Pas de "trous" visuels, cohérence forte.

| Situation | Folder |
|---|---|
| Nouveau thread jamais analysé | À analyser |
| Thread avec tous messages analysés | Inbox principale |
| Thread analysé qui reçoit un nouveau message client | Bascule en À analyser |
| Thread résolu qui reçoit un nouveau message (reopened) | À analyser |
| Thread en À analyser dont le marchand répond manuellement côté Gmail | Sort de À analyser, classifié intent (gratuit), marqué résolu |

**Boutons par localisation** :
- Folder À analyser : bouton `Analyser` (full pipeline : intent + identifiers + tracking + draft) → **+1 unité**
- Inbox principale (thread avec analyse complète, sans draft) : bouton `Generate draft` (analyse déjà faite, génère juste le draft) → **+1 unité**
- Bouton secondaire `Marquer comme géré` dans À analyser : sort le thread du folder sans consommer (utile si le marchand a répondu manuellement ailleurs)

**Badge dans la nav** : count de threads en attente dans À analyser, mis à jour en temps réel.

### Stratégie de catch-up post-upgrade

Au moment de l'upgrade (ou au reset mensuel après quota dépassé), la sync reprend avec un **régime à deux zones** selon l'âge des messages.

#### Zone active : 48 dernières heures

- Tout thread avec **au moins un message** dans les 48h glissantes :
  - **Importé en entier** (toute l'historique du thread, même messages plus anciens) pour contexte complet
  - **Analysé automatiquement** (intent + identifiers + tracking)
  - **0 unité consommée** (pas de draft auto-généré)
- Atterrit dans l'**inbox principale** avec contexte complet, prêt pour clic `Generate draft` si pertinent

#### Zone hors-fenêtre : > 48h

- Importés en DB pour cohérence avec le serveur mail (Gmail/Outlook)
- **Pas analysés**
- Atterrissent dans le folder **À analyser** en état brut
- Marchand clique 1 par 1 si pertinent → +1 unité par clic
- Bouton `Marquer comme géré` disponible pour sortir sans consommer

#### Coût pour Automail

L'analyse de la zone active 48h tourne gratuitement pour le marchand. Coût LLM borné par construction (~5-30 threads typiquement, ~$0.10-1.00 par catch-up). Considéré comme overhead opérationnel acceptable.

#### Pourquoi cette stratégie

- **Cohérence avec le serveur mail** : aucune zone aveugle. Le marchand peut chercher un email du jeudi dernier et le retrouver dans Automail.
- **Inbox immédiatement utilisable** : à l'upgrade, les threads récents sont prêts avec full contexte (la valeur Pro/Starter est immédiate).
- **Maîtrise du coût** : seuls les 48h récents sont auto-analysés. Le reste est sur clic.
- **Pas de "tout analyser"** illusoire : chaque clic dans À analyser est intentionnel, le marchand triage naturellement.

### Suppression du setting `autoDraft`

Le champ `autoDraft` existait en DB mais n'était pas câblé. **Supprimé pour v1.**

Justification : sans auto-send (out of scope MVP), la valeur d'auto-générer les drafts est marginale (économise ~3-5s d'attente par email). Le coût en revanche est réel : burn de quota sur des emails que le marchand n'aurait pas voulu traiter (spam résiduel, "merci !", etc.).

**Conséquence** : aucun draft n'est jamais généré sans clic explicite du marchand. Modèle simple, prévisible, aligné avec le principe "human in the loop" du copilot.

Cleanup à effectuer : migration Prisma drop le champ, suppression de tout code/UI lié.

## Communication du quota

### Top bar counter (permanent)

Composant dans le layout root [app.tsx](app/routes/app.tsx), visible sur toutes les pages app :

- Format compact : `47 / 50 drafts`
- Pastille couleur : vert <80%, jaune 80-95%, orange 95-100%, rouge ≥100%
- Cliquable → popover avec détails (période, jours avant reset, bouton upgrade si pertinent)
- Pendant trial : `Trial — 9 days left` à la place
- Une fois en blocage : `50 / 50 — quota atteint` avec icône cadenas

### Bannières contextuelles

| Niveau | Affichage | Dismiss |
|---|---|---|
| Warning (80%) | Bannière jaune top de page | Oui (par période) |
| Critical (95%) | Bannière orange top de page | Oui (par période) |
| Exceeded (100%) | Bannière rouge top de page | Non |
| Trial actif | Bannière info top de page | Oui (1×) |
| Trial expiré | Modal bloquant | Non |
| Plan annulé en grace period | Bannière info | Non |
| Downgrade planifié | Bannière info | Oui |

Persistance des dismisses : `localStorage` keyed par `(shop, periodStart, level)`. Pas de table dédiée, suffisant pour la v1.

### Modal sur action bloquée

Quand le marchand clique `Generate draft` / `Refine` / `Regenerate` alors que quota atteint :

```
Quota atteint pour ce mois (50/50 drafts).
Upgrade vers Pro pour continuer immédiatement, ou attends le 1er [mois prochain].

[Voir les plans] [Plus tard]
```

Si la requête fait basculer pile à 50/50 (le draft sort, mais c'est le dernier) :

```
Tu viens d'utiliser ton 50e draft du mois.
Plus de génération possible jusqu'au 1er [mois prochain].

[Upgrade vers Pro]
```

### Toast au reset

Au premier login d'un nouveau mois après reset :

```
Quota réinitialisé : 50 drafts disponibles ce mois.
```

### Distinction des états visuels

Trois états doivent rester non-confondables :

- Trial actif / expiré → bandeau bleu / modal bleu
- Plan payant + quota OK → top bar vert
- Plan payant + quota dépassé → top bar rouge + bannière rouge
- Plan annulé en grace → bannière jaune
- Plan annulé expiré → modal bloquant rouge

### Wording

EN par défaut, FR via le système i18n existant ([user-preferences.ts](app/lib/user-preferences.ts), [app/i18n/locales/](app/i18n/locales/)).

## Architecture technique

### Choix : source de vérité = Shopify Billing API

Plan actif lu depuis `currentAppInstallation.activeSubscriptions` à chaque requête, avec cache mémoire 5 minutes par shop.

**Justification** : pas de désynchronisation possible avec Shopify, conforme aux exigences App Store, pas de logique de mirror local à maintenir. L'overhead du round-trip est mitigé par le cache.

Alternative écartée (mirror local complet via webhooks) : risque de désynchro silencieuse en cas de webhook manqué, plus de surface de bugs pour un gain de performance marginal sur le chemin chaud.

### Modules à créer

Sous `app/lib/billing/` :

- **`plans.ts`** — définitions statiques du catalogue. Source de vérité côté code des prix, quotas, features par plan. Permet de référencer `PLANS.starter.draftsPerMonth` partout.
- **`subscription.ts`** — lecture du plan actif depuis Shopify Billing API + cache mémoire 5 min par shop. Expose `getActivePlan(shop): Promise<PlanState>` où `PlanState = { plan: "trial" | "starter" | "pro" | "none", expiresAt, ... }`.
- **`entitlements.ts`** — couche métier qui combine plan actif + usage compteur → décisions booléennes. **Seul module appelé par le reste du code**. Expose :
  - `canGenerateDraft(shop): Promise<boolean>`
  - `canConnectMailbox(shop): Promise<boolean>`
  - `canViewAdvancedDashboard(shop): Promise<boolean>`
  - `getQuotaStatus(shop): Promise<{ used, limit, pct, level }>`
  - `getMailboxStatus(shop): Promise<{ used, limit }>`
- **`usage.ts`** — manipulation atomique du compteur drafts. Expose :
  - `tryReserveDraft(shop): Promise<{ ok: true } | { ok: false, reason: "quota_exceeded" }>` — incrémente avec vérification atomique du quota
  - `releaseDraft(shop, periodStart)` — décrémente best-effort si LLM échoue après reservation
- **`trial.ts`** — calcul de l'état trial (jours restants, expiré). Dérivé de la date d'install + 14j si pas encore d'abonnement payant.
- **`scheduled-changes.ts`** — gestion des downgrades planifiés. CRUD sur `BillingScheduledChange`, job qui applique les changements à effectiveAt.

### Modèles Prisma à ajouter

```prisma
model BillingUsage {
  id           String   @id @default(cuid())
  shop         String
  periodStart  DateTime  // 1er du mois UTC
  draftsCount  Int       @default(0)
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  @@unique([shop, periodStart])
  @@index([shop])
}

model BillingScheduledChange {
  id           String   @id @default(cuid())
  shop         String
  fromPlan     String
  toPlan       String
  effectiveAt  DateTime
  createdAt    DateTime  @default(now())
  appliedAt    DateTime?
  @@index([shop])
  @@index([effectiveAt, appliedAt])
}

model BillingShopFlag {
  shop         String   @id
  isInternal   Boolean  @default(false)  // bypass entitlement checks (dev/test)
  installDate  DateTime  @default(now())
}
```

Migration Prisma :
- Création des 3 tables ci-dessus
- Suppression du champ `autoDraft` de la table existante (cleanup)

### Routes nouvelles

- **`app/routes/app.billing.tsx`** — page de sélection de plan. Affiche plan actif, comparaison Starter vs Pro, état du compteur, boutons upgrade/downgrade/cancel.
- **`app/routes/api.billing.subscribe.tsx`** — action qui appelle `appSubscriptionCreate` mutation Shopify, retourne `confirmationUrl`, redirige le marchand vers la confirmation Shopify.
- **`app/routes/api.billing.cancel.tsx`** — action `appSubscriptionCancel` (pour usage immédiat) ou ajout dans `BillingScheduledChange` (pour downgrade scheduled).
- **`app/routes/webhooks.app_subscriptions.update.tsx`** — webhook informatif. Invalide le cache `subscription.ts` pour le shop concerné. Log pour audit.

### Webhooks à ajouter dans `shopify.app.toml`

```toml
[[webhooks.subscriptions]]
uri = "/webhooks/app_subscriptions/update"
topics = [ "app_subscriptions/update" ]
```

### Flux d'écriture (génération de draft)

1. UI clique `Generate / Refine / Regenerate` dans `app.support.tsx` ou `app.inbox.tsx`
2. Action serveur appelle `usage.tryReserveDraft(shop)` (transaction atomique : lit compteur, vérifie `count < limit`, incrémente si OK)
   - Si refusé → retourne `{ error: "quota_exceeded", upgradeUrl }`, UI affiche modal + écran lecture seule
   - Si accepté → continue
3. Pipeline existante (`reply-draft.ts`) génère le draft via LLM
4. **Si LLM échoue** : `usage.releaseDraft(shop, periodStart)` best-effort. Si DB indispo lors du release, log l'erreur, le compteur reste sur-incrémenté de 1 (le marchand "perd" 1 unité). Acceptable car LLM failure rare.
5. **Si LLM réussit** : draft retourné, compteur déjà à jour. Réponse inclut le nouveau quota status pour refresh sans round-trip.

### Flux de lecture (chaque page)

1. Loader appelle `subscription.getActivePlan(shop)` (cache 5min)
2. Loader appelle `entitlements.getQuotaStatus(shop)` (lit `BillingUsage` du mois courant)
3. Si feature gatée demandée → `entitlements.canViewAdvancedDashboard(shop)` etc., omet les sections gatées et passe un flag `isPro: false` au composant
4. Composant React affiche les sections autorisées et un placeholder `Available on Pro` (avec CTA upgrade) pour les autres

### Call sites à modifier

| Fichier | Modification |
|---|---|
| [app/routes/api.reply-draft.tsx](app/routes/api.reply-draft.tsx) | Reserve avant LLM, release si échec |
| [app/routes/app.support.tsx](app/routes/app.support.tsx) | Idem si génération directe |
| [app/lib/gmail/refine-draft.ts](app/lib/gmail/refine-draft.ts) | Wrappé dans le même check + reserve/release |
| [app/lib/mail/auto-sync.ts](app/lib/mail/auto-sync.ts) | Si quota dépassé → suspendre la sync. Si reset/upgrade → reprendre avec stratégie 48h-zone-active |
| [app/routes/mail-auth.tsx](app/routes/mail-auth.tsx) | Avant connexion d'une nouvelle boîte : `entitlements.canConnectMailbox(shop)`, refus si limite atteinte |
| [app/routes/app.dashboard.tsx](app/routes/app.dashboard.tsx) | Loader filtre données avancées si `!isPro`, range max 7j |
| [app/routes/app.tsx](app/routes/app.tsx) | Layout root : injecte plan + quotaStatus + trialStatus dans le contexte, monte `<TopBarCounter>` et bannières |
| [app/lib/gmail/pipeline.ts](app/lib/gmail/pipeline.ts) | Suppression refs `autoDraft`, confirmation que le pipeline reste skipDraft pendant analyse auto |

## Cas limites et erreurs

### Billing

| Cas | Comportement |
|---|---|
| Marchand annule en cours de période | Plan reste actif jusqu'à fin période payée. À l'expiration → lecture seule. |
| Webhook `app_subscriptions/update` raté | Cache 5min se rafraîchit naturellement, désynchro max 5min. Pas critique. |
| DB indispo lors de `tryReserveDraft` | Retour 503 au marchand. Pas d'appel LLM, pas de comptage. État cohérent. |
| Pro downgrade vers Starter mid-période | Planifié pour fin de période. Pro maintenu jusque-là. |
| Race condition à 49/50 (deux drafts simultanés) | Transaction atomique sur le compteur (CAS sur unique constraint). Un seul passe, l'autre reçoit `quota_exceeded`. |
| Période passe pendant génération | `incrementDrafts` upsert sur le `periodStart` calculé au moment de l'increment. Léger biais borné à quelques secondes. |
| Désinstall puis réinstall même shop | Nouveau cycle Shopify Billing. Compteur d'usage existant reset (nouvelle install effective). |
| Trial expiré, marchand reconnecté | App lecture seule, modal bloquant. Navigation historique possible. |
| Erreur Shopify Billing (timeout, MERCHANT_NOT_ACCEPTED) | Retry une fois, sinon redirect vers `/app/billing` avec message d'erreur. |

### Catch-up et folder À analyser

| Cas | Comportement |
|---|---|
| Mail dans À analyser répondu manuellement côté Gmail | Sync détecte reply outbound → marque thread résolu → classification intent gratuite (LLM léger) → tracking pas refresh → 0 unité. |
| Mail supprimé côté serveur mail pendant qu'il est dans À analyser | Sync supprime aussi côté Automail (comportement existant). |
| Click "Analyser" mais quota épuisé entre-temps | Erreur `quota_exceeded` retournée, modal bloquant. Cas rare car en blocage la sync est suspendue. |
| Nouveau message client sur thread déjà partiellement analysé | Thread bascule en À analyser (a un message non analysé). Quand marchand clique → re-analyse + nouveau draft → 1 unité, retour en inbox principale. |
| Catch-up massif au 1er du mois après long blocage | Zone 48h reste bornée. Hors-fenêtre va dans À analyser sans coût. Pas d'explosion. |

### Mailbox quota

| Cas | Comportement |
|---|---|
| Starter à 1 boîte tente d'en connecter une 2e | Refus à l'étape OAuth, message `Plan Starter limité à 1 boîte mail. Upgrade vers Pro pour en connecter jusqu'à 3.` |
| Pro à 3 boîtes downgrade vers Starter (planifié) | À l'effectiveAt, les 2 boîtes les plus récemment ajoutées sont déconnectées automatiquement, sync arrêtée pour elles. Bannière préventive 7j avant pour permettre au marchand de choisir lesquelles garder. |

## Tests

Priorisation pragmatique selon CLAUDE.md.

### Unit tests

- `plans.ts` : sanity check des constantes (limites, prix non zéro)
- `entitlements.ts` : matrix de permissions par plan × état (trial, Starter, Pro, expired) × usage (sous/à/dépassé)
- `usage.ts` : reserve atomique, idempotence, rotation de période, race conditions
- `trial.ts` : calcul jours restants, edge cases (install date manquante, dépassement, fuseau)
- `scheduled-changes.ts` : création, application au bon moment, annulation
- Sanity : 1 draft généré = +1, refine = +1, edit manuel = 0, re-analyse = 0

### Integration tests

- Flux complet "génère draft" avec quota OK → unité incrémentée, draft retourné
- Flux "génère draft" avec quota épuisé → 409 + message + UI lecture seule
- Flux upgrade Starter → Pro : compteur conservé, limite mise à jour
- Flux downgrade Pro → Starter planifié : application à effectiveAt, déconnexion mailboxes excédentaires
- Flux expiration trial sans plan : passage en lecture seule
- Flux sync suspendue pendant blocage → reprise au reset/upgrade avec catch-up 48h
- Flux catch-up : 5 mails dans la zone active analysés gratuitement, 5 hors-fenêtre dans À analyser
- Flux folder À analyser : analyse 1 par 1, vérifier compteur, vérifier bascule en inbox principale

### E2E (optionnel pour v1)

- Parcours complet trial → choix plan → première génération → atteinte quota → upgrade → continue
- Parcours downgrade : Pro → Starter planifié → annulé → confirmé → application à date

### Coverage cible

80% sur le module `app/lib/billing/` (cœur métier). Pragmatique ailleurs.

## Rollout

### Migration des shops existants

L'app tourne déjà chez quelques marchands en mode single-store sans facturation. Stratégie :

- **Shops déjà installés au moment du lancement billing** : automatiquement basculés en **trial 14 jours** à la date de release. Bannière "Bienvenue dans la version commerciale d'Automail. Tu as 14 jours pour choisir ton plan."
- **Nouveaux shops post-release** : trial 14j standard.
- **Shop interne (dev/test)** : flag `BillingShopFlag.isInternal = true` → bypass de tous les entitlement checks.

### Cleanup code

- Migration Prisma : drop colonne `autoDraft`
- Suppression UI/setting lié dans `app.settings.tsx`
- Pas de breaking change utilisateur (champ non câblé en pratique)

### App Store

- Page billing publique : tableau Starter vs Pro, prix, features, trial 14j
- Privacy policy ([app/routes/privacy.tsx](app/routes/privacy.tsx)) : ajouter mention du stockage du compteur d'usage
- App listing Shopify : screenshots de la page billing, mise à jour features list

### Métriques à instrumenter

Dès le lancement, pour piloter les ajustements futurs :

- LLM cost per shop per month (validation des marges réelles)
- Distribution d'usage : shops à <20%, 20-80%, 80-100%, dépassement
- Taux de conversion trial → plan payant
- Taux d'upgrade Starter → Pro et downgrade Pro → Starter
- Volume moyen du folder À analyser (proxy d'engagement)
- Latence Shopify Billing API (si dégradée → bumper le cache TTL)

Ces métriques nourriront les décisions futures (Growth tier intermédiaire, ajustement quotas, ajustement prix, soupapes type pack one-time).

## Évolutions explicitement out of scope v1

À considérer **après** observation des données réelles :

- **Palier Growth intermédiaire** ($24 / 200 drafts / 2 mailboxes) si la zone 50-500 montre une masse de marchands coincés
- **Pack drafts one-time** ($15 = +100 drafts) comme soupape de pic ponctuel
- **Plan annuel** avec remise 10-15% (engagement)
- **Auto-send sur cas safe** (intent simple + confiance haute + politique claire) plutôt qu'auto-draft
- **Email notifications** pour les seuils de quota (v1 : in-app banner suffit)
- **Soft cap / overage** facturation à l'usage au-delà du quota

## Récapitulatif des décisions clés

1. Modèle : Trial 14j → Starter $9 / Pro $49, hard cap, 2 paliers seulement.
2. Unité : 1 draft généré = +1 unité, strictement.
3. Quota dépassé : sync suspendue, inbox figée.
4. Catch-up post-upgrade : zone 48h auto-analysée gratuitement, hors-fenêtre dans folder À analyser.
5. Folder À analyser : permanent, abrite tous les threads avec message non analysé.
6. autoDraft : supprimé, génération uniquement sur clic explicite.
7. Source de vérité : Shopify Billing API + cache 5min, compteur usage en DB.
8. Upgrade immédiat avec prorata, downgrade planifié pour fin de période.
9. Communication multicouche : top bar counter permanent + bannières + modals.
10. Rollout : shops existants basculés en trial 14j, shop interne flag bypass.
