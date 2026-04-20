# Coûts LLM — automail

Toutes les estimations en USD, tarifs OpenAI **2026-04** (référence : `app/lib/llm/client.ts` > `PRICING`).

## Tarifs utilisés

| Modèle       | Input ($/1M tok) | Output ($/1M tok) |
|--------------|------------------|-------------------|
| gpt-4o       | 2.50             | 10.00             |
| gpt-4o-mini  | 0.15             | 0.60              |
| gpt-4.1      | 2.00             | 8.00              |
| gpt-4.1-mini | 0.40             | 1.60              |
| gpt-4.1-nano | 0.10             | 0.40              |

## Sites d'appel

| Call site         | Modèle       | Fréquence                                         | Input typique | Output max |
|-------------------|--------------|---------------------------------------------------|---------------|------------|
| `classifier`      | gpt-4o-mini  | 1× par **thread** avec Tier 1 = passed            | ~400 tok      | 30 tok     |
| `llm-parser`      | gpt-4o-mini  | 1× par thread `support_client`                    | ~900 tok      | 300 tok    |
| `context-crawler` | gpt-4o-mini  | 0–3× par thread `support_client` (URLs trackées)  | ~3000 tok     | 300 tok    |
| `tracking-agent`  | gpt-4o-mini  | 0–1× par thread avec tracking non résolu          | ~1500 tok     | 200 tok    |
| `llm-draft`       | **gpt-4o**   | 1× par thread `support_client`                    | ~2500 tok     | 600 tok    |
| `refine-draft`    | **gpt-4o**   | N× on-demand (action utilisateur)                 | ~1500 tok     | 600 tok    |

## Coût estimé par issue

### Thread filtré (Tier 1 uniquement)
→ **$0.0000** (regex pur, aucune LLM)

### Thread classé `probable_non_client` / `incertain`
→ classifier only
`400 × 0.15/1M + 30 × 0.60/1M` ≈ **$0.00008** (~0.008 ¢)

### Thread `support_client` sans tracking (cas standard)
- classifier : $0.00008
- llm-parser : `900 × 0.15/1M + 300 × 0.60/1M` ≈ $0.00032
- llm-draft : `2500 × 2.50/1M + 600 × 10.00/1M` ≈ $0.01225
- **Total : ~$0.0127 / thread** (~1.3 ¢)

### Thread `support_client` avec tracking + 2 URLs crawlées
- classifier : $0.00008
- llm-parser : $0.00032
- tracking-agent : ~$0.00035
- context-crawler × 2 : `2 × (3000 × 0.15/1M + 300 × 0.60/1M)` ≈ $0.00126
- llm-draft : $0.01225
- **Total : ~$0.0143 / thread** (~1.4 ¢)

### Raffinement manuel
`refine-draft` ≈ `1500 × 2.50/1M + 600 × 10.00/1M` ≈ **$0.0098 / refine** (~1 ¢)

## Projections business

Hypothèses : mix réaliste 50% filtered, 30% non-client/incertain, 20% support. Tracking enrichi sur 70% des support.

| Threads / mois | Coût estimé / mois         |
|----------------|----------------------------|
| 100            | ~$0.30                     |
| 1 000          | ~$3.00                     |
| 10 000         | ~$30                       |
| 100 000        | ~$300                      |

À multiplier par ~1.2–1.5 si les utilisateurs raffinent activement les drafts.

## Mesure réelle

Deux sources de vérité en DB :

1. **`IncomingEmail.llmCostUsd` / `llmTokensTotal`** — agrégé par email.
2. **`LlmCallLog`** — une ligne par appel (granularité call-site/modèle/tokens/durée).

### Requêtes utiles

```sql
-- Coût total par shop sur 30 jours
SELECT shop, SUM("costUsd") AS usd, SUM("totalTokens") AS tokens, COUNT(*) AS calls
FROM "LlmCallLog"
WHERE "createdAt" > NOW() - INTERVAL '30 days'
GROUP BY shop;

-- Coût moyen par thread support analysé
SELECT AVG("llmCostUsd") FROM "IncomingEmail"
WHERE "processingStatus" = 'analyzed';

-- Répartition par call site
SELECT "callSite", COUNT(*), SUM("costUsd")
FROM "LlmCallLog"
GROUP BY "callSite"
ORDER BY 3 DESC;
```

## Leviers d'optimisation

1. **Réduire le contexte du draft** : passage de gpt-4o à gpt-4o-mini = −95% (tester la qualité).
2. **Cache des classifications** par hash subject+from (spams récurrents).
3. **Crawler opt-in** : si le tracking est résolu par les URLs Shopify, ne pas re-crawler.
4. **Batcher les classifiers** sur les anciens threads lors du resync initial.
5. **gpt-4.1-mini** (1.60 $/M out vs 10 pour gpt-4o) à évaluer pour le draft si la qualité tient.
