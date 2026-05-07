# Handoff — Dashboard SAV V1 : tests visuels Playwright

**Date**: 2026-05-07  
**Branche**: `feat/dashboard-sav-v1`  
**Statut**: Implémentation complète. Reste : validation visuelle Playwright.

---

## Ce qui a été fait

Toute l'implémentation du plan `2026-05-07-dashboard-sav-v1.md` est commitée :

- **Task 1** : Fix `classifyAndDraft` — respect des `manualOverrides.intents` (miroir de `reanalyzeEmail`)
- **Task 2** : Schema Prisma — `heuristicBucket` + `heuristicComputedAt` sur `ReplyDraft`
- **Task 3** : `app/lib/support/draft-usage-heuristic.ts` + 15 tests unitaires
- **Task 4** : Wiring `evaluateThread` dans le pipeline de sync Gmail
- **Task 5–6** : `app/lib/dashboard-stats.ts` — toutes les fonctions stats (response time, draft usage, heatmap, top intents, reopened, alerts)
- **Task 7** : Nouveaux composants UI (`AlertBanner`, `HeatMap`, `TopIntentsList`) dans `app/components/ui/index.tsx`
- **Task 9** : Réécriture complète de `app/routes/app.dashboard.tsx` (cockpit layout)
- **Task 10** : 18 nouvelles clés i18n dans `fr.json` + `en.json`
- **Task 11** : Suppression des anciennes fonctions v0 de `dashboard-stats.ts`
- **Task 12** : Tests d'intégration pour `getResponseTimeStats` + `getDraftUsageStats`

Modifications supplémentaires dans ce commit (non commitées avant) :

- `tests/e2e/dashboard.spec.ts` — sélecteurs mis à jour pour le nouveau dashboard (`.ui-metric` avec label "Emails support", boutons "7d"/"30d", `data-testid="chart-quality-service"`)
- `app/routes/app.tsx` — ajout de `isE2E` dans le loader pour désactiver `AppProvider embedded` en mode E2E (évite la redirection vers admin.shopify.com)
- `app/routes/app.dashboard.tsx` — ajout de `data-testid="chart-quality-service"` sur le wrapper du quality chart
- `vite.config.ts` — ajout de `resolve.dedupe: ["react", "react-dom"]` pour éviter les doubles instances React

---

## Ce qui reste à faire

### Problème bloquant : doubles instances React en dev

Le dev server en mode E2E (avec `E2E_AUTH_BYPASS=true`) produit deux instances React concurrentes dans le navigateur, causant :

```
TypeError: Cannot read properties of null (reading 'useContext')
  at useResponsiveContainerContext (recharts.js)
```

**Symptôme** : La page affiche "Application Error" à cause du conflit React entre les chunks Vite.

**Cause racine probable** : Le fichier `.env` a `SHOPIFY_APP_URL=https://bread-omaha-fee-handled.trycloudflare.com`. Quand le dev server démarre en local, le WebSocket HMR Vite tente de se connecter à ce tunnel (inexistant), échoue, et la re-optimisation des dépendances (qui se déclenche au premier chargement après `rm -rf node_modules/.vite`) laisse le navigateur avec un mélange de versions.

**Ce qui a déjà été essayé** :
- `resolve.dedupe: ["react", "react-dom"]` dans `vite.config.ts` → ne résout pas le problème de race condition
- `SHOPIFY_APP_URL=http://localhost:58496` au démarrage → à valider
- `AppProvider embedded={!isE2E}` pour éviter la redirection Shopify Admin → fonctionne

### Stratégie recommandée pour débloquer

1. Démarrer le dev server **avec** `SHOPIFY_APP_URL=http://localhost:58496` :
   ```bash
   E2E_AUTH_BYPASS=true ALLOW_E2E_AUTH_BYPASS=yes-i-know \
   NODE_ENV=development SHOPIFY_APP_URL=http://localhost:58496 \
   npx react-router dev --port 58496
   ```

2. Attendre que Vite termine la première optimisation des dépendances (le log dit `✨ new dependencies optimized` puis `✨ optimized dependencies changed. reloading`).

3. **Faire un premier GET sur `/app/dashboard`** pour déclencher l'optimisation.

4. **Attendre** la fin du rechargement Vite (le log dit `reloading`).

5. **Puis** lancer le test Playwright (le second chargement sera stable).

### Commande de test E2E à lancer

Les tests E2E nécessitent `E2E_DATABASE_URL` (base séparée de `DATABASE_URL`). Si disponible :

```bash
E2E_DATABASE_URL="<url-base-e2e>" npx playwright test tests/e2e/dashboard.spec.ts
```

### Test visuel manuel (sans E2E database)

Une fois le dev server stable (voir ci-dessus), aller sur :
```
http://localhost:58496/app/dashboard
```

Le dashboard doit afficher :
- **Hero** : "Pilotage SAV" + "Dashboard" + PeriodSelector (24h / 7d / 30d / 90d)
- **4 KPIs** : "Délai 1re réponse" / "Threads ré-ouverts" / "Drafts utilisés" / "Emails support"
- **Carte "Qualité du service"** : ComposedChart barres + ligne médiane
- **Carte "Productivité IA"** : StackedBarChart (as_is / edited / ignored)
- **2 colonnes** : HeatMap ("Pics d'activité") + TopIntentsList ("Top motifs")
- **2 colonnes** : État de la file + Threads ré-ouverts

---

## Tests à faire passer avant merge

1. `npm run typecheck` — doit passer sans erreur
2. `npm run test` — unit tests + integration tests
3. Test visuel Playwright sur le dashboard (voir ci-dessus)

---

## Fichier à supprimer après validation

Ce fichier (`docs/superpowers/plans/2026-05-07-dashboard-sav-v1-handoff.md`) est temporaire et doit être supprimé une fois la validation Playwright terminée.
