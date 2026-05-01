# Unit Tests Gap Fill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Combler les gaps de couverture des tests unitaires identifiés dans le spec requirements, sans toucher à l'infrastructure (pas de DB nécessaire).

**Architecture:** Deux gaps principaux — (1) le module `thread-state.ts` n'a aucun test unitaire pour ses fonctions pures `mergeNature` et `deriveOperationalState` ; (2) le corpus de `intent-classifier` couvre 24 cas mais le spec en demande 30 avec des variants français supplémentaires et des cas edge. Tous les tests utilisent Vitest et sont déterministes ou golden-dataset.

**Tech Stack:** Vitest, TypeScript, modules existants `~/lib/support/thread-state` et `~/lib/support/intent-classifier`

---

### Task 1 : Créer `thread-state.test.ts` — tests `mergeNature`

Les transitions de la `supportNature` sticky sont une règle métier critique (REQ-STATE-13, REQ-STATE-14) : une nature ne peut jamais rétrograder. La fonction `mergeNature` est pure → tests déterministes.

**Files:**
- Create: `app/lib/support/__tests__/thread-state.test.ts`

- [ ] **Step 1 : Écrire les tests failing pour `mergeNature`**

```typescript
// app/lib/support/__tests__/thread-state.test.ts
import { describe, it, expect } from 'vitest';
import { mergeNature } from '~/lib/support/thread-state';

describe('mergeNature — règle sticky de classification', () => {
  // Progressions vers le haut (autorisées)
  it('unknown + probable_support → probable_support', () => {
    expect(mergeNature('unknown', 'probable_support')).toBe('probable_support');
  });

  it('unknown + non_support → non_support', () => {
    expect(mergeNature('unknown', 'non_support')).toBe('non_support');
  });

  it('probable_support + confirmed_support → confirmed_support', () => {
    expect(mergeNature('probable_support', 'confirmed_support')).toBe('confirmed_support');
  });

  it('non_support + probable_support → probable_support (escalation autorisée)', () => {
    expect(mergeNature('non_support', 'probable_support')).toBe('probable_support');
  });

  it('confirmed_support + mixed → mixed', () => {
    expect(mergeNature('confirmed_support', 'mixed')).toBe('mixed');
  });

  // Régressions (interdites — règle critique REQ-STATE-14)
  it('confirmed_support + unknown → confirmed_support (jamais de régression)', () => {
    expect(mergeNature('confirmed_support', 'unknown')).toBe('confirmed_support');
  });

  it('confirmed_support + non_support → confirmed_support (jamais de régression)', () => {
    expect(mergeNature('confirmed_support', 'non_support')).toBe('confirmed_support');
  });

  it('confirmed_support + needs_review → confirmed_support (needs_review ne régresse pas)', () => {
    expect(mergeNature('confirmed_support', 'needs_review')).toBe('confirmed_support');
  });

  it('probable_support + unknown → probable_support (stable sur unknown entrant)', () => {
    expect(mergeNature('probable_support', 'unknown')).toBe('probable_support');
  });

  // Idempotence
  it('confirmed_support + confirmed_support → confirmed_support', () => {
    expect(mergeNature('confirmed_support', 'confirmed_support')).toBe('confirmed_support');
  });

  it('unknown + unknown → unknown', () => {
    expect(mergeNature('unknown', 'unknown')).toBe('unknown');
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils passent**

```bash
npx vitest run app/lib/support/__tests__/thread-state.test.ts
```

Attendu : tous verts. `mergeNature` est déjà implémentée — ces tests valident le comportement existant.

Si un test échoue, la fonction a un bug → ne pas modifier le test, corriger `thread-state.ts`.

- [ ] **Step 3 : Commit**

```bash
git add app/lib/support/__tests__/thread-state.test.ts
git commit -m "test: add mergeNature sticky-nature unit tests (REQ-STATE-13, REQ-STATE-14)"
```

---

### Task 2 : Ajouter les tests `deriveOperationalState` dans `thread-state.test.ts`

`deriveOperationalState` est une fonction pure qui dérive l'état opérationnel depuis les données de messages. Elle couvre REQ-STATE-02 à REQ-STATE-05 et REQ-STATE-07.

**Files:**
- Modify: `app/lib/support/__tests__/thread-state.test.ts`

- [ ] **Step 1 : Lire la signature exacte de `deriveOperationalState`**

```bash
grep -n "deriveOperationalState" app/lib/support/thread-state.ts | head -20
```

Puis lire les lignes autour de la définition pour voir les arguments exacts :
```bash
sed -n '1,80p' app/lib/support/thread-state.ts
```

Note le type exact des arguments (ex: `{ incomingCount, outgoingCount, latestDirection, noReplyNeeded, ... }`).

- [ ] **Step 2 : Écrire les tests failing pour `deriveOperationalState`**

Remplacer `ARGS_TYPE` et les champs d'args par ceux lus à l'étape précédente. Exemple de structure probable (adapter selon la signature réelle) :

```typescript
import { mergeNature, deriveOperationalState } from '~/lib/support/thread-state';

// Ajouter dans le même fichier, après le describe mergeNature :

describe('deriveOperationalState — machine d\'états opérationnels', () => {
  // Construire les args minimaux depuis la signature lue à Step 1.
  // Pattern général : passer incomingCount, outgoingCount, latestDirection, noReplyNeeded
  // Les valeurs exactes sont dans thread-state.ts — adapter ci-dessous.

  it('thread sans messages → open (REQ-STATE-01)', () => {
    // Remplacer les champs par ceux de la vraie signature
    const result = deriveOperationalState({
      incomingCount: 0,
      outgoingCount: 0,
      latestDirection: null,
      noReplyNeeded: false,
    } as Parameters<typeof deriveOperationalState>[0]);
    expect(result).toBe('open');
  });

  it('premier message entrant → waiting_merchant (REQ-STATE-02)', () => {
    const result = deriveOperationalState({
      incomingCount: 1,
      outgoingCount: 0,
      latestDirection: 'incoming',
      noReplyNeeded: false,
    } as Parameters<typeof deriveOperationalState>[0]);
    expect(result).toBe('waiting_merchant');
  });

  it('message sortant après entrant → waiting_customer (REQ-STATE-03)', () => {
    const result = deriveOperationalState({
      incomingCount: 1,
      outgoingCount: 1,
      latestDirection: 'outgoing',
      noReplyNeeded: false,
    } as Parameters<typeof deriveOperationalState>[0]);
    expect(result).toBe('waiting_customer');
  });

  it('client répond après notre message → waiting_merchant (REQ-STATE-04)', () => {
    const result = deriveOperationalState({
      incomingCount: 2,
      outgoingCount: 1,
      latestDirection: 'incoming',
      noReplyNeeded: false,
    } as Parameters<typeof deriveOperationalState>[0]);
    expect(result).toBe('waiting_merchant');
  });

  it('LLM détecte fin de conversation → no_reply_needed (REQ-STATE-07)', () => {
    const result = deriveOperationalState({
      incomingCount: 2,
      outgoingCount: 1,
      latestDirection: 'incoming',
      noReplyNeeded: true,
    } as Parameters<typeof deriveOperationalState>[0]);
    expect(result).toBe('no_reply_needed');
  });
});
```

> Note : `Parameters<typeof deriveOperationalState>[0]` permet de typer les args sans dupliquer le type. Adapter les noms de champs exactement comme dans la signature lue à Step 1.

- [ ] **Step 3 : Lancer les tests**

```bash
npx vitest run app/lib/support/__tests__/thread-state.test.ts
```

Attendu : tous verts. Si un test échoue sur un état inattendu, vérifier la logique dans `thread-state.ts` et aligner le test sur le comportement attendu par le spec (pas l'inverse).

- [ ] **Step 4 : Commit**

```bash
git add app/lib/support/__tests__/thread-state.test.ts
git commit -m "test: add deriveOperationalState state-machine unit tests (REQ-STATE-01 to REQ-STATE-07)"
```

---

### Task 3 : Étendre le corpus de l'intent-classifier à 30+ exemples

Le corpus actuel a 24 tests (3 par intent × 6 intents + 2 unknown + 2 priority). Le spec demande 30 exemples annotés couvrant plus de variants français, des emails très courts, et un cas multi-intent.

**Files:**
- Modify: `app/lib/support/__tests__/intent-classifier.test.ts`

- [ ] **Step 1 : Écrire 6 cas supplémentaires**

Ajouter ces blocs dans le fichier existant, à la fin de chaque section `describe` appropriée :

```typescript
// Dans le describe('where_is_my_order') :
it('détecte une question de suivi avec formulation neutre', () => {
  const result = classify(
    'Bonjour',
    'Je voulais juste avoir des nouvelles de mon colis. Commande passée il y a 10 jours.'
  );
  expect(result.intent).toBe('where_is_my_order');
});

// Dans le describe('delivery_delay') :
it('détecte un délai avec formulation indirecte', () => {
  const result = classify(
    'Ma commande',
    'Cela fait maintenant 3 semaines que j\'attends, je ne sais pas ce qui se passe.'
  );
  expect(result.intent).toBe('delivery_delay');
});

// Dans le describe('refund_request') :
it('détecte une demande de remboursement très courte', () => {
  const result = classify('Remboursement', 'Je veux être remboursé svp');
  expect(result.intent).toBe('refund_request');
});

// Dans le describe('package_stuck') :
it('détecte un colis bloqué depuis plusieurs jours', () => {
  const result = classify(
    'Colis',
    'Mon tracking n\'a pas bougé depuis 5 jours. Il est toujours au même endroit.'
  );
  expect(result.intent).toBe('package_stuck');
});

// Dans le describe('unknown') :
it('retourne unknown pour une question générale sans intent support clair', () => {
  const result = classify(
    'Question',
    'Bonjour, j\'ai une question sur vos produits. Quels sont vos délais habituels ?'
  );
  expect(result.intent).toBe('unknown');
});

// Nouveau describe('multi-intent') — cas limite :
describe('multi-intent / edge cases', () => {
  it('email avec tracking + demande remboursement → intent dominant détecté (pas d\'erreur)', () => {
    const result = classify(
      'Problème commande #9999',
      'Mon colis est marqué livré mais je ne l\'ai jamais reçu. Je veux aussi un remboursement.'
    );
    // L'intent exact dépend de la priorité définie — vérifier que ce n'est pas 'unknown' et pas d'erreur
    expect(result.intent).not.toBe(undefined);
    expect(['marked_delivered_not_received', 'refund_request']).toContain(result.intent);
  });
});
```

- [ ] **Step 2 : Lancer les tests**

```bash
npx vitest run app/lib/support/__tests__/intent-classifier.test.ts
```

Attendu : tous verts. Si le cas multi-intent échoue, vérifier les règles de priorité dans `intent-classifier.ts` et ajuster la liste `toContain` selon la priorité réelle.

- [ ] **Step 3 : Commit**

```bash
git add app/lib/support/__tests__/intent-classifier.test.ts
git commit -m "test: expand intent-classifier corpus to 30 cases incl. French variants and multi-intent edge case"
```

---

### Task 4 : Lancer la suite complète et vérifier la couverture

- [ ] **Step 1 : Lancer tous les tests unitaires**

```bash
npx vitest run
```

Attendu : tous les tests passent (existants + nouveaux). Zéro régression.

- [ ] **Step 2 : Vérifier le compte total de tests**

```bash
npx vitest run --reporter=verbose 2>&1 | tail -5
```

Attendu : ≥ 130 tests passants (111 existants + ~20 nouveaux).

- [ ] **Step 3 : Commit final si modifications résiduelles**

```bash
git status
# Si des fichiers ont été touchés pendant le debug :
git add -p
git commit -m "test: unit test suite complete — all passing"
```
