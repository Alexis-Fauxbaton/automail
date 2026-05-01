# Requirements & Test Plan — Automail

**Date :** 2026-04-26  
**App :** Automail — Support copilot pour agents Shopify  
**Cible :** Distribution publique Shopify App Store, multi-tenant

---

## Catalogue des méthodes de test

Chaque test référence une méthode ci-dessous.

| Code | Description |
|---|---|
| `deterministic` | Input/output fixé, `expect(result).toEqual(expected)` — aucune ambiguïté possible |
| `golden-dataset` | Corpus annoté de N exemples, assertion sur chaque item du corpus |
| `structural` | Assert la forme et la présence (champs requis, types, non-vide), pas le contenu exact |
| `llm-as-judge` | Eval séparé hors CI : un LLM note la qualité sur rubrique (pertinence, ton, faits) |
| `behavioral-e2e` | Playwright : vérifier que l'UI a changé d'état comme attendu |
| `integration-db` | Assert l'état Prisma en base après une action (test DB dédiée) |

---

## PARTIE 1 — Requirements fonctionnels

---

### 1. Email Sync & Ingestion

#### 1.1 Connexion mail

- REQ-SYNC-01 : L'app doit permettre à un merchant de connecter une boîte Gmail via OAuth 2.0.
- REQ-SYNC-02 : L'app doit permettre de connecter une boîte Zoho Mail via OAuth 2.0.
- REQ-SYNC-03 : Les access tokens et refresh tokens doivent être chiffrés au repos (AES-256-GCM) dans `MailConnection`.
- REQ-SYNC-04 : Si le token est expiré, l'app doit le rafraîchir automatiquement avant toute opération.
- REQ-SYNC-05 : L'état OAuth doit être signé HMAC-SHA256 avec TTL 10 minutes pour prévenir le CSRF et le détournement cross-tenant.
- REQ-SYNC-06 : La déconnexion doit supprimer les tokens chiffrés et marquer la connexion comme inactive, sans supprimer les emails déjà ingérés.

#### 1.2 Sync incrémentale

- REQ-SYNC-07 : La sync incrémentale doit utiliser le `historyId` Gmail (ou date-based pour Zoho) pour ne récupérer que les nouveaux messages depuis la dernière sync.
- REQ-SYNC-08 : Chaque message doit être dédupliqué via `externalMessageId` — un message déjà en base ne doit jamais être réingéré.
- REQ-SYNC-09 : La sync doit ingérer les messages entrants ET sortants (direction détectée par headers RFC).
- REQ-SYNC-10 : Après chaque sync, `MailConnection.lastSyncAt` et `historyId` doivent être mis à jour.

#### 1.3 Jobs durables

- REQ-SYNC-11 : Toute opération de sync doit passer par un `SyncJob` persisté en base (pas de traitement en mémoire pure).
- REQ-SYNC-12 : Un job en état `running` depuis plus de 30 minutes doit être automatiquement repassé à `pending` (zombie recovery).
- REQ-SYNC-13 : En cas d'échec, un job doit être retenté avec backoff exponentiel (30s, 60s) jusqu'à 3 tentatives, puis marqué `error`.
- REQ-SYNC-14 : Deux jobs du même shop ne doivent jamais s'exécuter en parallèle (`FOR UPDATE SKIP LOCKED`).
- REQ-SYNC-15 : Un job annulé (`syncCancelledAt`) doit s'arrêter proprement à la prochaine itération du pipeline.

#### 1.4 Auto-sync

- REQ-SYNC-16 : L'auto-sync doit être configurable par shop (activé/désactivé, intervalle en minutes).
- REQ-SYNC-17 : Le scheduler doit tourner toutes les 60 secondes et ne déclencher une sync que si `now - lastSyncAt > autoSyncIntervalMinutes`.
- REQ-SYNC-18 : La concurrence globale doit être limitée (`AUTOSYNC_CONCURRENCY`, défaut 4 shops en parallèle).

#### 1.5 Backfill

- REQ-SYNC-19 : Au premier onboarding d'une connexion, un backfill de 60 jours doit être déclenché automatiquement une seule fois (`onboardingBackfillDoneAt`).
- REQ-SYNC-20 : Un backfill manuel doit être paramétrable par plage de dates depuis l'UI.
- REQ-SYNC-21 : Un resync complet doit vider les données existantes et refaire l'ingestion intégrale.

#### 1.6 Thread canonicalization

- REQ-SYNC-22 : Des messages Zoho fragmentés (changement de sujet = nouveau thread Zoho) doivent être regroupés sous un seul `Thread` canonique via RFC headers (`In-Reply-To`, `References`).
- REQ-SYNC-23 : Chaque `Thread` doit maintenir un `historyStatus` : `complete`, `partial` ou `unknown`.

---

### 2. Email Analysis Pipeline

#### 2.1 Tier 1 — Pré-filtre

- REQ-PIPE-01 : Chaque message doit être soumis au pré-filtre Tier 1 (regex, gratuit, sans LLM).
- REQ-PIPE-02 : Le Tier 1 doit détecter et filtrer : spam, emails système, promotionnels, newsletters.
- REQ-PIPE-03 : Le résultat `tier1Result` doit être l'un de : `passed`, `filtered:spam`, `filtered:system`, `filtered:promotional`.
- REQ-PIPE-04 : Les messages filtrés en Tier 1 ne doivent pas être soumis au Tier 2 ni au Tier 3.

#### 2.2 Tier 2 — Classification LLM

- REQ-PIPE-05 : La classification Tier 2 doit s'exécuter uniquement sur le message le plus récent de chaque thread (économie LLM).
- REQ-PIPE-06 : Le Tier 2 doit classer chaque thread comme `support_client`, `incertain`, ou `probable_non_client`.
- REQ-PIPE-07 : La `supportNature` du thread est sticky et ne peut que progresser vers une classification plus certaine (jamais rétrograder de `confirmed_support` à `unknown`).
- REQ-PIPE-08 : Le résultat `tier2Result` doit être persisté sur `IncomingEmail` et la `supportNature` mise à jour sur `Thread`.

#### 2.3 Tier 3 — Analyse complète

- REQ-PIPE-09 : L'analyse Tier 3 doit s'exécuter uniquement sur les threads classés support.
- REQ-PIPE-10 : L'analyse doit extraire : intent (6 types), numéro de commande, numéro de tracking, email client, nom client.
- REQ-PIPE-11 : Si aucune clé OpenAI n'est configurée, le système doit fallback sur l'extraction regex (aucune erreur fatale).
- REQ-PIPE-12 : La recherche Shopify doit suivre l'ordre de priorité : numéro de commande > email > nom > numéro de tracking.
- REQ-PIPE-13 : Si plusieurs commandes candidates existent, l'ambiguïté doit être explicitement signalée (pas de choix silencieux).
- REQ-PIPE-14 : La confiance doit être calculée : `high` (match exact + tracking clair), `medium` (match probable, tracking partiel), `low` (match ambigu ou données insuffisantes).
- REQ-PIPE-15 : Le pipeline ne doit jamais inventer de données Shopify ni de statut tracking.
- REQ-PIPE-16 : Si une étape échoue (Shopify API down, tracking timeout), le pipeline doit continuer avec les données disponibles et indiquer les données manquantes.
- REQ-PIPE-17 : Le coût LLM de chaque appel doit être loggé dans `LlmCallLog` (tokens, coût USD, durée, callSite).

#### 2.4 Intents supportés

Les intents reconnus : `where_is_my_order`, `delivery_delay`, `marked_delivered_not_received`, `damaged_product`, `order_error`, `refund_request`, `pre_purchase_question`, `unknown`.

Les colis bloqués ou sans mise à jour de suivi sont classés dans `delivery_delay`, pas dans une intention séparée.

- REQ-PIPE-18 : Tout email ne correspondant à aucun intent connu doit être classé `unknown` (jamais d'erreur).
- REQ-PIPE-19 : Un email multi-intent doit être classé `mixed` au niveau `supportNature` du thread.

---

### 3. Thread State Machine

#### 3.1 États opérationnels

Les 5 états : `open`, `waiting_merchant`, `waiting_customer`, `resolved`, `no_reply_needed`.

- REQ-STATE-01 : Tout nouveau thread démarre à l'état `open`.
- REQ-STATE-02 : À la réception du premier message entrant, le thread passe automatiquement à `waiting_merchant`.
- REQ-STATE-03 : Quand un agent envoie une réponse (message sortant détecté), le thread passe à `waiting_customer`.
- REQ-STATE-04 : Quand le client répond après un message sortant, le thread passe à `waiting_merchant`.
- REQ-STATE-05 : **Règle critique — Réouverture automatique :** si un thread est `resolved` et qu'un nouveau message entrant est reçu, le thread doit automatiquement passer à `waiting_merchant`. Cette transition doit être loggée dans `ThreadStateHistory` avec `fromState: resolved`.
- REQ-STATE-06 : Un thread sans réponse client depuis 7 jours en état `waiting_customer` doit passer automatiquement à `resolved`.
- REQ-STATE-07 : Si le LLM détecte que la conversation est close (`noReplyNeeded`), le thread passe à `no_reply_needed`.
- REQ-STATE-08 : Un agent peut forcer manuellement n'importe quel état opérationnel (override).
- REQ-STATE-09 : `previousOperationalState` doit être préservé pour permettre l'annulation d'une résolution manuelle.

#### 3.2 Audit trail

- REQ-STATE-10 : Chaque transition d'état doit générer une entrée `ThreadStateHistory` : `shop`, `threadId`, `fromState`, `toState`, `changedAt`.
- REQ-STATE-11 : L'audit trail ne doit jamais être supprimé lors d'une réouverture ou d'une modification d'état.
- REQ-STATE-12 : Le dashboard doit pouvoir calculer le nombre de threads réouverts sur une période à partir de `ThreadStateHistory` (transitions depuis `resolved`).

#### 3.3 Support nature (sticky)

- REQ-STATE-13 : La progression autorisée est : `unknown` → `probable_support` / `non_support` / `needs_review` → `confirmed_support` / `mixed`.
- REQ-STATE-14 : Une nature ne peut jamais rétrograder (ex. `confirmed_support` ne peut pas redevenir `unknown`).

---

### 4. Inbox UI

#### 4.1 Buckets et navigation

- REQ-INBOX-01 : L'inbox doit présenter 6 vues : `to_review`, `waiting_customer`, `waiting_merchant`, `resolved`, `other`, `all`.
- REQ-INBOX-02 : `to_review` doit regrouper les threads support en attente de traitement agent.
- REQ-INBOX-03 : Les filtres actifs doivent être : recherche textuelle (sujet, expéditeur, snippet, numéro commande), niveau de confiance, commande liée (oui/non), classification.

#### 4.2 Vue thread

- REQ-INBOX-04 : La vue expandée doit afficher les messages dans l'ordre chronologique avec direction (entrant/sortant).
- REQ-INBOX-05 : Les identifiers extraits (numéro commande, tracking, email, nom) doivent être éditables par l'agent (override merchant).
- REQ-INBOX-06 : L'analyse (intent, confiance, commande, fulfillment, tracking) doit être lisible sans ouvrir une autre page.

#### 4.3 Draft editor

- REQ-INBOX-07 : Le draft doit être éditable directement dans l'inbox avec sauvegarde automatique.
- REQ-INBOX-08 : Un slider doit permettre de naviguer dans l'historique des versions du draft (`bodyHistory`).
- REQ-INBOX-09 : Un champ "refine with AI" doit permettre d'envoyer une instruction au LLM pour modifier le draft (ex. "rends-le plus court").
- REQ-INBOX-10 : Les champs To, Subject, CC, BCC et le mode de réponse (thread / nouveau thread) doivent être modifiables.
- REQ-INBOX-11 : Les pièces jointes doivent supporter upload (max 10 MB), prévisualisation du nom, et suppression. Expiry automatique à 7 jours.

#### 4.4 Prior contact indicators

- REQ-INBOX-12 : Si l'expéditeur a déjà contacté le shop dans un autre thread, un indicateur "même adresse" doit être affiché.
- REQ-INBOX-13 : Si la commande liée a déjà été traitée dans un autre thread, un indicateur "même commande" doit être affiché.
- REQ-INBOX-14 : Si une réponse sortante a été émise vers ce contact après le dernier message de ce thread (dans un autre thread), l'indicateur "répondu ailleurs récemment" doit s'afficher.

#### 4.5 Actions et sync

- REQ-INBOX-15 : L'action "Sync now" doit déclencher un job immédiat et afficher le statut en temps réel.
- REQ-INBOX-16 : Les actions "Backfill 60 jours", "Re-sync all", "Re-classify" doivent être disponibles dans un panneau avancé (non exposées par défaut).
- REQ-INBOX-17 : Un diagnostic de connexion doit permettre de tester l'authentification et lister les dossiers (Zoho).

---

### 5. Dashboard & Metrics

#### 5.1 KPIs

- REQ-DASH-01 : Le dashboard doit afficher 4 KPIs avec comparaison période précédente (% de variation) : emails reçus, emails support, drafts créés, emails envoyés.
- REQ-DASH-02 : Le % de variation doit être calculé sur une période précédente de même durée (ex. 7j affiche la variation vs les 7j précédents).
- REQ-DASH-03 : Si `emailsSent` n'est pas encore disponible, la KPI doit afficher `null` sans masquer les autres.

#### 5.2 Snapshot d'état des threads

- REQ-DASH-04 : Le dashboard doit afficher le nombre courant de threads par état opérationnel (live, non basé sur une période).

#### 5.3 Breakdown journalier

- REQ-DASH-05 : Le breakdown journalier doit afficher un bar chart (total emails) et un line chart (emails support uniquement) sur la période sélectionnée.
- REQ-DASH-06 : Les jours sans activité doivent être représentés avec la valeur 0 (pas de trou dans la série).
- REQ-DASH-07 : Le bucketing journalier doit respecter le fuseau horaire `Europe/Paris`.

#### 5.4 Conversation stats

- REQ-DASH-08 : Le dashboard doit afficher sur la période : nouvelles conversations, conversations résolues, conversations réouvertes.
- REQ-DASH-09 : Les réouvertures doivent être calculées à partir de `ThreadStateHistory` (transitions depuis `resolved`).

#### 5.5 Top intents

- REQ-DASH-10 : La distribution des intents doit être affichée (top 6 + `unknown`) pour la période sélectionnée.

#### 5.6 Sélection de période

- REQ-DASH-11 : Les presets doivent couvrir : 24h, 7j, 30j, 90j.
- REQ-DASH-12 : Une plage custom (date de début / fin) doit être supportée via paramètres URL.
- REQ-DASH-13 : Si aucune donnée n'existe pour la période, tous les KPIs doivent afficher 0 sans erreur.

---

### 6. Settings per-shop

- REQ-SET-01 : Chaque shop doit pouvoir configurer : nom de signature, nom de marque, ton (friendly/formal/neutral), langue (auto/fr/en), phrase de clôture, partage du numéro de tracking, style de salutation, politique de remboursement, auto-draft.
- REQ-SET-02 : Les settings doivent être persistés dans `SupportSettings` avec isolation per-shop.
- REQ-SET-03 : Les settings doivent être chargés à chaque appel du pipeline d'analyse (pas de cache cross-shop).
- REQ-SET-04 : La modification des settings doit être reflétée immédiatement sur le prochain draft généré (pas de cache).

---

### 7. Tracking Integration

#### 7.1 Résolution 3 niveaux

- REQ-TRACK-01 : La résolution de tracking doit suivre l'ordre : 17track API → données fulfillment Shopify → pattern guess.
- REQ-TRACK-02 : Les données issues d'un pattern guess doivent être labellisées `inferred: true` dans le résultat.
- REQ-TRACK-03 : En cas de timeout ou d'échec 17track, le fallback doit s'activer silencieusement (pas d'erreur fatale).
- REQ-TRACK-04 : Les carriers supportés pour la détection par pattern sont : Cainiao, Yanwen, 4PX, UPS, FedEx, DHL, La Poste, DPD, GLS, Chronopost, Mondial Relay.

#### 7.2 Tracking agent LLM

- REQ-TRACK-05 : Si des données 17track existent avec `inferred: false`, le tracking agent doit optionnellement fetcher la page de tracking et en extraire le statut via LLM (gpt-4o-mini).
- REQ-TRACK-06 : Le fetch externe doit passer par `safeFetch` (bloque RFC1918, endpoints de métadonnées cloud).
- REQ-TRACK-07 : Le coût du tracking agent doit être loggé avec `callSite: "tracking-agent"`.

#### 7.3 Règles de draft

- REQ-TRACK-08 : Le draft ne doit jamais affirmer qu'un colis est livré à moins que le tracking ne le confirme explicitement.
- REQ-TRACK-09 : Le draft ne doit jamais affirmer qu'un colis est perdu sans source confirmée.
- REQ-TRACK-10 : Si le tracking est `inferred`, le draft doit utiliser une formulation prudente.

---

### 8. GDPR & Conformité App Store

#### 8.1 Webhooks obligatoires

- REQ-GDPR-01 : Le webhook `customers/data_request` doit être enregistré, authentifié par signature Shopify, et loggé (PII hashé, jamais en clair).
- REQ-GDPR-02 : Le webhook `customers/redact` doit supprimer tous les `IncomingEmail` où `fromAddress` correspond au client, et effacer les champs `resolvedEmail` / `resolvedCustomerName` des threads associés.
- REQ-GDPR-03 : Le webhook `shop/redact` doit supprimer en cascade toutes les données du shop (toutes les tables) dans les 48h après désinstallation.
- REQ-GDPR-04 : Les trois webhooks doivent retourner HTTP 200 dans tous les cas (Shopify réessaie sur erreur).

#### 8.2 Privacy

- REQ-GDPR-05 : La route `/privacy` doit être publique (sans authentification Shopify) et à jour avec les données réellement stockées.
- REQ-GDPR-06 : Les logs applicatifs ne doivent jamais contenir d'email, nom ou adresse client en clair (`piiHash()` obligatoire).

#### 8.3 Protected customer data

- REQ-GDPR-07 : L'utilisation de données protégées (email, nom, adresse) doit être déclarée dans le Partner Dashboard et justifiée par l'usage support.
- REQ-GDPR-08 : Aucune donnée client ne doit être stockée au-delà de ce qui est nécessaire pour générer un draft.

#### 8.4 App Store requirements

- REQ-GDPR-09 : Un canal de support réel (email) doit être configuré et visible dans le listing et la politique de confidentialité.
- REQ-GDPR-10 : Les scopes OAuth doivent rester read-only (`read_orders`, `read_all_orders`, `read_customers`, `read_fulfillments`) — aucun scope write sauf demande explicite.
- REQ-GDPR-11 : L'app listing doit inclure description, screenshots, et démo fonctionnelle avant soumission.

---

### 9. Multi-tenant Isolation

- REQ-MT-01 : Toutes les queries Prisma doivent inclure un filtre `shop` — aucune query globale cross-shop.
- REQ-MT-02 : Le job queue doit garantir qu'un seul job s'exécute par shop à la fois.
- REQ-MT-03 : Aucun singleton en mémoire ne doit porter du state scopé à un shop (ex. cache de settings, token en mémoire).
- REQ-MT-04 : Une erreur dans le pipeline d'un shop ne doit pas interrompre le traitement des autres shops.
- REQ-MT-05 : Les logs et métriques doivent être taguées par `shop`.

---

## PARTIE 2 — Plan de tests

---

### Référence rapide : méthodes

| Code | Quand l'utiliser |
|---|---|
| `deterministic` | Logique pure sans LLM, output entièrement prévisible |
| `golden-dataset` | LLM ou heuristique avec output structuré, validé sur corpus annoté |
| `structural` | Output texte libre LLM : asserter forme/présence, pas contenu exact |
| `llm-as-judge` | Qualité sémantique d'un draft — exécuté hors CI en mode eval |
| `behavioral-e2e` | Flux utilisateur Playwright : état UI après action |
| `integration-db` | Actions serveur : vérifier état Prisma après mutation |

---

### 1. Tests unitaires (Vitest)

#### 1.1 `message-parser`

| Test | Méthode | Couverture REQ |
|---|---|---|
| Détecter un email entrant vs sortant via headers From/To | `deterministic` — output binaire prévisible | REQ-SYNC-09 |
| Normaliser le sujet (strip Re:/Fwd:, trim, lowercase) | `deterministic` — transformation pure | REQ-PIPE-10 |
| Extraire le corps texte depuis un email HTML | `structural` — vérifier que le texte n'est pas vide et ne contient pas de balises HTML | REQ-PIPE-10 |
| Gérer un email sans corps (corps vide) | `deterministic` — retourner string vide sans exception | REQ-PIPE-16 |

#### 1.2 `identifier-extractor`

| Test | Méthode | Couverture REQ |
|---|---|---|
| Extraire un numéro de commande `#1234` depuis le sujet | `deterministic` — regex déterministe | REQ-PIPE-10 |
| Extraire un numéro de commande depuis le corps | `deterministic` | REQ-PIPE-10 |
| Extraire un email client depuis le corps | `deterministic` | REQ-PIPE-10 |
| Extraire un numéro de tracking UPS/FedEx/La Poste | `deterministic` — un cas par carrier | REQ-PIPE-10 |
| Ne rien extraire d'un corps sans identifiant | `deterministic` — retourner objet vide | REQ-PIPE-10 |
| Extraire le premier numéro de commande si plusieurs présents | `deterministic` | REQ-PIPE-13 |

#### 1.3 `intent-classifier`

| Test | Méthode | Couverture REQ |
|---|---|---|
| Corpus de 30 emails annotés (6 intents + unknown) | `golden-dataset` — corpus annoté manuellement, assert `result.intent === expected`. Utilisé aussi en régression si le prompt change | REQ-PIPE-10, REQ-PIPE-18 |
| Email multi-intent → `unknown` ou `mixed` | `golden-dataset` — cas spécifiques ajoutés au corpus | REQ-PIPE-19 |
| Fallback regex si pas de clé OpenAI : retourner intent sans erreur | `deterministic` — mock env sans clé | REQ-PIPE-11 |

#### 1.4 `confidence-scoring`

| Test | Méthode | Couverture REQ |
|---|---|---|
| Match exact sur numéro de commande → `high` | `deterministic` — règle de scoring pure | REQ-PIPE-14 |
| Match sur email client seulement → `medium` | `deterministic` | REQ-PIPE-14 |
| Aucun identifiant extrait → `low` | `deterministic` | REQ-PIPE-14 |
| Tracking `inferred` + match commande → `medium` (pas `high`) | `deterministic` | REQ-PIPE-14 |

#### 1.5 `thread-state`

| Test | Méthode | Couverture REQ |
|---|---|---|
| `open` + message entrant → `waiting_merchant` | `deterministic` — machine d'états pure | REQ-STATE-02 |
| `waiting_merchant` + message sortant → `waiting_customer` | `deterministic` | REQ-STATE-03 |
| `waiting_customer` + message entrant → `waiting_merchant` | `deterministic` | REQ-STATE-04 |
| **`resolved` + message entrant → `waiting_merchant`** | `deterministic` — cas critique REQ-STATE-05 | REQ-STATE-05 |
| `waiting_customer` sans réponse depuis > 7j → `resolved` | `integration-db` — insérer thread avec `lastAgentMessageAt` > 7j, déclencher le job d'auto-résolution, vérifier état | REQ-STATE-06 |
| Override manuel vers n'importe quel état | `deterministic` | REQ-STATE-08 |
| `previousOperationalState` préservé lors d'une résolution | `deterministic` | REQ-STATE-09 |
| `supportNature` ne régresse jamais | `deterministic` — tester toutes les transitions interdites | REQ-STATE-14 |

#### 1.6 `thread-state-history`

| Test | Méthode | Couverture REQ |
|---|---|---|
| Chaque transition génère une entrée `ThreadStateHistory` | `integration-db` — observer la table après transition | REQ-STATE-10 |
| L'audit trail n'est pas supprimé lors d'une réouverture | `integration-db` — vérifier que les entrées passées subsistent | REQ-STATE-11 |

#### 1.7 `provider-resolver` (tracking)

| Test | Méthode | Couverture REQ |
|---|---|---|
| Identifier La Poste depuis format tracking FR | `deterministic` — regex carrier | REQ-TRACK-04 |
| Identifier UPS depuis format tracking 1Z | `deterministic` | REQ-TRACK-04 |
| Identifier DHL depuis format tracking | `deterministic` | REQ-TRACK-04 |
| Numéro inconnu → `inferred: true` + carrier null | `deterministic` | REQ-TRACK-02 |
| Numéro correspondant à plusieurs carriers → retourner le plus probable | `deterministic` | REQ-TRACK-01 |

#### 1.8 `dashboard-stats`

| Test | Méthode | Couverture REQ |
|---|---|---|
| KPI emails reçus sur 7j = count correct en base | `integration-db` — insérer des fixtures, vérifier les totaux | REQ-DASH-01 |
| % variation calculé correctement (période précédente) | `deterministic` — calcul pur sur données mockées | REQ-DASH-02 |
| Jours sans activité → valeur 0 dans la série | `deterministic` — vérifier le remplissage des trous | REQ-DASH-06 |
| Réouvertures = transitions depuis `resolved` dans `ThreadStateHistory` | `integration-db` — insérer transitions, vérifier le count | REQ-DASH-09 |
| Période sans données → tous les KPIs à 0 sans erreur | `deterministic` | REQ-DASH-13 |

#### 1.9 `draft-subject`

| Test | Méthode | Couverture REQ |
|---|---|---|
| Sujet sans "Re:" → ajouter "Re: " | `deterministic` | REQ-INBOX-10 |
| Sujet déjà préfixé "Re:" → ne pas doubler | `deterministic` | REQ-INBOX-10 |

---

### 2. Tests d'intégration (Vitest + Prisma test DB)

#### 2.1 Pipeline complet (mock externes)

| Test | Méthode | Couverture REQ |
|---|---|---|
| Email entrant support → draft généré et persisté en `ReplyDraft` | `integration-db` — mock Shopify API + mock OpenAI + mock 17track. Vérifier création du draft | REQ-PIPE-09 à REQ-PIPE-14 |
| Email entrant non-support → pas de draft, `tier2Result` = `probable_non_client` | `integration-db` | REQ-PIPE-04 |
| Pipeline sans clé OpenAI → fallback regex, pas d'erreur, intent extrait | `integration-db` — env sans `OPENAI_API_KEY` | REQ-PIPE-11 |
| Shopify API renvoie 0 commande → confiance `low`, draft avec formulation prudente | `integration-db` — mock Shopify vide | REQ-PIPE-15, REQ-PIPE-16 |
| Thread `resolved` reçoit un nouveau message → état passe à `waiting_merchant` | `integration-db` — insérer thread resolved, simuler ingestion d'un nouveau message | REQ-STATE-05 |

#### 2.2 `api.reply-draft`

| Test | Méthode | Couverture REQ |
|---|---|---|
| POST upsert body → `ReplyDraft` créé ou mis à jour | `integration-db` | REQ-INBOX-07 |
| POST met à jour subject/cc/bcc/replyMode → persistés | `integration-db` | REQ-INBOX-10 |
| `bodyHistory` s'incrémente à chaque mise à jour | `integration-db` — vérifier que le tableau grandit | REQ-INBOX-08 |

#### 2.3 `api.draft-attachment`

| Test | Méthode | Couverture REQ |
|---|---|---|
| Upload fichier ≤ 10 MB → `DraftAttachment` créé | `integration-db` | REQ-INBOX-11 |
| Upload fichier > 10 MB → erreur 400 | `deterministic` — vérifier le rejet | REQ-INBOX-11 |
| DELETE attachment → ligne supprimée + fichier storage supprimé | `integration-db` | REQ-INBOX-11 |
| Cleanup job → attachments > 7j supprimés | `integration-db` — insérer des entrées avec `createdAt` passé | REQ-INBOX-11 |

#### 2.4 Webhooks GDPR

| Test | Méthode | Couverture REQ |
|---|---|---|
| `customers/redact` avec signature valide → emails du client supprimés | `integration-db` — insérer emails, envoyer webhook, vérifier suppression | REQ-GDPR-02 |
| `customers/redact` avec signature invalide → HTTP 401 | `deterministic` | REQ-GDPR-02 |
| `shop/redact` → toutes les tables vidées pour ce shop | `integration-db` — vérifier cascade complète | REQ-GDPR-03 |
| `customers/data_request` → HTTP 200 sans erreur | `deterministic` | REQ-GDPR-01 |

#### 2.5 Refresh token

| Test | Méthode | Couverture REQ |
|---|---|---|
| Token expiré au moment du sync → rafraîchi automatiquement, sync continue | `integration-db` — mock token expiré, vérifier que le nouveau token est persisté et le job termine sans erreur | REQ-SYNC-04 |
| Refresh token invalide → job marqué `error`, message d'erreur dans `MailConnection.lastSyncError` | `integration-db` | REQ-SYNC-04, REQ-SYNC-13 |

#### 2.6 Job queue

| Test | Méthode | Couverture REQ |
|---|---|---|
| Job en `running` depuis > 30 min → repassé à `pending` | `integration-db` — insérer job bloqué, déclencher zombie recovery | REQ-SYNC-12 |
| Deux jobs pour le même shop → le second attend sans conflit DB | `integration-db` — insérer deux jobs concurrents | REQ-SYNC-14 |
| Job échoue 3 fois → marqué `error` avec `lastError` | `integration-db` | REQ-SYNC-13 |

---

### 3. Tests E2E (Playwright)

Chaque test E2E utilise la méthode `behavioral-e2e` sauf mention contraire.  
Les assertions portent sur l'état observable de l'UI et éventuellement l'état DB, jamais sur le contenu exact d'un draft.

#### 3.1 Connexion mail

| Test | Assertion | Couverture REQ |
|---|---|---|
| Connexion Gmail via OAuth → badge "Connecté" affiché dans inbox | UI affiche adresse connectée + dernier sync | REQ-SYNC-01 |
| Déconnexion → tokens supprimés, badge "Non connecté" | UI mise à jour + `integration-db` pour vérifier tokens effacés | REQ-SYNC-06 |

#### 3.2 Sync et ingestion

| Test | Assertion | Couverture REQ |
|---|---|---|
| Clic "Sync now" → email de test apparaît dans bucket `to_review` | Thread card visible dans inbox | REQ-SYNC-07, REQ-INBOX-01 |
| Sync lancée deux fois → l'email n'apparaît qu'une fois | Pas de doublon visible dans l'inbox | REQ-SYNC-08 |

#### 3.3 Analyse et draft

| Test | Assertion | Couverture REQ |
|---|---|---|
| Clic "Generate draft" → un draft non-vide apparaît dans l'éditeur | Textarea non-vide | REQ-PIPE-09 |
| Clic "Refine with AI" avec instruction → nouvelle version du draft générée | Slider de version incrémenté | REQ-INBOX-09 |
| Édition manuelle du draft → sauvegarde automatique | Pas de perte de contenu après reload | REQ-INBOX-07 |

#### 3.4 State machine UI

| Test | Assertion | Couverture REQ |
|---|---|---|
| Clic "Mark resolved" → thread passe dans bucket `resolved` | Thread disparaît de `to_review`, visible dans `resolved` | REQ-STATE-08 |
| Nouveau message entrant sur thread résolu → thread réapparaît dans `waiting_merchant` | Badge état mis à jour + `integration-db` pour vérifier `ThreadStateHistory` | REQ-STATE-05 |
| Override manuel d'état → badge mis à jour immédiatement | UI reflète le nouvel état sans reload | REQ-STATE-08 |

#### 3.5 Dashboard

| Test | Assertion | Couverture REQ |
|---|---|---|
| Changement de preset période (7j → 30j) → KPIs recalculés | Valeurs numériques changent | REQ-DASH-11 |
| Période sans données → KPIs affichent 0 sans erreur | Pas de crash, 0 affiché | REQ-DASH-13 |
| Bar chart affiche 7 barres pour preset 7j | Nombre de points dans le graphique | REQ-DASH-05 |

#### 3.6 Settings

| Test | Assertion | Couverture REQ |
|---|---|---|
| Modifier le ton → sauvegarde → générer un draft → ton reflété | `structural` sur le draft + `integration-db` pour vérifier `SupportSettings` | REQ-SET-04 |

#### 3.7 Pièces jointes

| Test | Assertion | Couverture REQ |
|---|---|---|
| Upload fichier 5 MB → nom affiché dans la liste des attachments | Nom de fichier visible dans UI | REQ-INBOX-11 |
| Upload fichier 15 MB → message d'erreur affiché | Erreur visible, pas d'upload | REQ-INBOX-11 |
| Suppression d'un attachment → disparaît de la liste | Nom retiré de l'UI | REQ-INBOX-11 |

---

### 4. Checklist App Store pré-soumission

À exécuter manuellement avant toute soumission à la Shopify App Store.

| Item | Méthode | Couverture REQ |
|---|---|---|
| Les 3 webhooks GDPR sont enregistrés dans `shopify.app.toml` | Lire le fichier de config | REQ-GDPR-01 à REQ-GDPR-03 |
| La route `/privacy` répond 200 sans être connecté | Ouvrir en navigation privée | REQ-GDPR-05 |
| Le contenu de `/privacy` mentionne les données réellement stockées | Lecture humaine | REQ-GDPR-05 |
| Protected customer data déclaré dans le Partner Dashboard | Vérifier dans Shopify Partners | REQ-GDPR-07 |
| Le canal de support (email) est visible dans le listing et `/privacy` | Lecture humaine | REQ-GDPR-09 |
| Les scopes sont exactement `read_orders, read_all_orders, read_customers, read_fulfillments` | Lire `shopify.app.toml` | REQ-GDPR-10 |
| Aucune donnée cross-shop accessible depuis une session d'un shop donné | Test d'isolation manuelle avec deux shops de test | REQ-MT-01 |
| L'app listing contient description, screenshots et démo | Vérifier dans Shopify Partners | REQ-GDPR-11 |
| Les variables d'environnement sensibles ne sont pas commitées en dur | `git grep SHOPIFY_API_SECRET` + `git grep OPENAI_API_KEY` | — |

---

## Gaps identifiés

Les points suivants sont hors scope du présent document mais devront être adressés avant la distribution publique :

- **Billing Shopify** : aucun plan d'abonnement configuré — obligatoire App Store (traité séparément).
- **Timezone configurable** : le bucketing journalier est hardcodé `Europe/Paris` — à rendre per-shop.
- **LLM-as-judge eval harness** : les tests de qualité des drafts (`llm-as-judge`) nécessitent un script d'eval dédié hors CI — à construire avant une montée en charge utilisateurs.
- **Rate limiting** : pas de protection contre les abus de l'endpoint d'analyse (ex. génération massive de drafts).
- **Monitoring / alerting** : pas de métriques applicatives exposées (uptime, latence pipeline, taux d'erreur LLM).
