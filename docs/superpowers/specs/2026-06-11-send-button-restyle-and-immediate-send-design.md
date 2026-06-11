# Restylage du bouton « Envoyer » + envoi immédiat optionnel

> Date : 2026-06-11 — Branche : `feat/email-send-v1`
> Statut : design validé, en attente de relecture avant plan d'implémentation.

## Contexte

Le bouton « Envoyer » de l'inbox (Email Send v1) souffre de deux problèmes signalés par le marchand :

1. **Visuel « off »** — c'est le seul bouton de la barre d'action rendu via un `<button>` natif en noir plat `#1a1a1a` avec styles inline ([SendButton.tsx:150-167](../../../app/components/inbox/SendButton.tsx#L150-L167)), alors que ses voisins (« Marquer comme résolu », « Régénérer le brouillon ») sont des `<s-button>` Polaris. Noir plus « mort » que le charbon Polaris, coins plus carrés (6px vs ~8px), hauteur différente (padding 10px vs 8px), aucun état hover/focus/disabled cohérent.
2. **Délai de 10 s trop long et subi** — le clic démarre un compte à rebours bloquant de 10 s avant l'envoi réel. Le marchand veut pouvoir envoyer **directement**.

Vérifié en conditions réelles via Playwright sur la boutique AMBIENT HOME (gros plan de la barre d'action confirmant l'écart visuel).

## Objectifs

- Rendre « Envoyer » visuellement soigné et distinct, tout en restant cohérent avec le design system **interne** de l'app (tokens `app/components/ui/tokens.css`).
- Permettre l'envoi **un-clic instantané** pour les marchands qui le souhaitent, sans imposer ce comportement par défaut.

## Hors périmètre

- Aucun changement de la logique serveur d'envoi (idempotence CAS sur `ReplyDraft.sendingStartedAt`, insert sortant pré-emptif, cron de libération des brouillons bloqués, état `waiting_customer` post-envoi). Tout cela reste identique.
- Pas d'auto-send (toujours déclenché par l'utilisateur).
- Pas de réglage par boîte mail (le réglage est au niveau boutique).

## Décisions de design (validées)

### 1. Visuel — bouton vert custom peaufiné

Polaris ne propose **pas** de bouton vert (`<s-button>` n'accepte que `tone="critical" | "auto" | "neutral"` et `variant="auto" | "primary" | "secondary" | "tertiary"` — confirmé doc Shopify). Le marchand veut du vert (couleur sémantique « envoyer / action positive »). On garde donc un bouton **custom**, mais **bien intégré** :

- Vert issu des tokens existants : fond `--ui-emerald-600` (#059669), hover `--ui-emerald-700` (#047857), texte blanc.
- Dimensions alignées sur les `<s-button>` Polaris voisins : `border-radius: 8px`, hauteur compacte (padding ~8px 14px, `min-height` cohérente), `font-size: 13px`, `font-weight: 550`.
- Icône avion en papier (SVG inline) avant le label.
- États réels gérés via classes CSS (impossible en styles inline) : `:hover`, `:focus-visible` (anneau de focus accessible), `:disabled` (grisé), `:active`.
- Les classes vivent dans `app/components/ui/tokens.css` (ex. `.am-send-btn`, `.am-send-btn--reauth`, `.am-send-btn:disabled`). On supprime la fonction `btnStyle` et les styles inline correspondants.

États du bouton (composant `SendButton`) :
- `idle` → bouton vert « ✈ Envoyer ».
- `needs-reauth` → bouton neutre clair « 🔒 Activer l'envoi » (toujours un `<Link>` react-router pour rester dans l'iframe Shopify — contrainte existante conservée), dimensions alignées.
- `disabled` → bouton vert grisé, dimensions alignées.
- `pending` (mode délai) → encart « Envoi à {client} dans {n}s… » + « Annuler » (voir §2).
- `sending` (mode immédiat) → indicateur de chargement bref.
- `error` → texte rouge + bouton « Réessayer ».
- `sent` → texte/badge vert « ✓ Envoyé ».

### 2. Délai — réglage shop-level « Envoi immédiat »

Nouveau réglage **au niveau de la boutique**, stocké dans les réglages support existants (`supportSettings`).

- **Défaut = OFF** (`immediateSend = false`) : comportement « délai de sécurité ». Le clic démarre un compte à rebours, **raccourci de 10 s à 5 s** (`COUNTDOWN_MS` 10 000 → 5 000), avec « Annuler ». Le libellé reste honnête (« Envoi dans {n}s », l'envoi n'a pas encore eu lieu) — c'est assumé comme un filet de sécurité.
- **ON** (`immediateSend = true`) : le clic appelle directement `actuallySend()` — envoi immédiat, sans compte à rebours ni undo. Bref état de chargement puis « ✓ Envoyé ».

Le réglage se gère dans la page **Paramètres** existante ([app.settings.tsx](../../../app/routes/app.settings.tsx)), nouvelle section « Envoi », via un `<s-select>` (même pattern que `shareTrackingNumber`) avec deux options :
- « Délai de sécurité avant envoi (5 s) » → `false`
- « Envoi immédiat » → `true`

## Composants & flux de données

```
app/lib/support/settings.ts        # + champ immediateSend (type, défaut false, get/save)
prisma/schema.prisma               # + immediateSend Boolean @default(false) sur supportSettings
prisma/migrations/<new>            # migration additive
app/routes/app.settings.tsx        # + section « Envoi » (s-select), parse dans l'action
app/routes/app.inbox.tsx           # loader: getSettings(shop) → expose immediateSend ; prop passée à <SendButton>
app/components/inbox/SendButton.tsx# + prop immediateSend ; COUNTDOWN_MS 5000 ; branche immédiat vs délai ; restylage
app/components/ui/tokens.css       # + classes .am-send-btn (+ états hover/focus/disabled)
app/i18n/locales/{en,fr}.json      # + clés section Envoi (vouvoiement en fr)
```

Flux :
1. `app.inbox.tsx` loader appelle `getSettings(shop)` (déjà disponible) et ajoute `immediateSend` à `loaderData`.
2. Chaque `<SendButton>` reçoit `immediateSend` en prop.
3. Au clic :
   - `immediateSend === true` → `actuallySend()` direct (état `sending` → `sent`).
   - sinon → compte à rebours 5 s (état `pending` + « Annuler »), puis `actuallySend()` à échéance.

## Contrats de données

`SupportSettings` (settings.ts) gagne :
```ts
immediateSend: boolean; // défaut false ; true = envoi un-clic sans délai
```
- `DEFAULT_SETTINGS.immediateSend = false`.
- `getSettings` lit `row.immediateSend` (défaut false si absent).
- `SaveSettingsInput.immediateSend: boolean` ; `saveSettings` persiste la valeur ; l'action de `app.settings.tsx` lit `formData.get("immediateSend") === "true"`.

`SendButton` props gagne :
```ts
immediateSend: boolean;
```

## Gestion des erreurs

- Mode immédiat : si l'envoi échoue, on bascule sur l'état `error` existant (texte rouge + « Réessayer »). Aucune fenêtre d'undo (c'est le choix assumé du mode immédiat).
- Mode délai : inchangé — « Annuler » interrompt avant l'appel API ; un échec après échéance bascule en `error`.
- L'idempotence et la détection de double-envoi côté serveur restent la garde ultime dans les deux modes.

## Tests

- **Unit (SendButton)** : rendu de chaque état ; clic en mode immédiat → `actuallySend` appelé sans délai ; clic en mode délai → compte à rebours puis envoi ; « Annuler » empêche l'envoi ; échec → état erreur.
- **settings.ts** : `immediateSend` round-trip (get/save) ; défaut false quand la ligne n'existe pas ou champ absent.
- **Intégration** : le réglage sauvegardé est bien relu par le loader inbox et scoping par `shop` respecté.
- **i18n** : clés présentes en/fr, vouvoiement.

## Accessibilité & cohérence

- Le bouton custom expose un `:focus-visible` clair (anneau), contraste texte/fond conforme (blanc sur emerald-600 ≈ AA), et `cursor` adapté.
- Hauteur/coins alignés sur les `<s-button>` voisins pour éviter le décalage visuel dans la barre d'action.

## Risques / réserves assumées

- On réintroduit volontairement un bouton hors Polaris (vert), justifié par l'absence de bouton vert Polaris et le besoin sémantique. Mitigé en l'alignant strictement sur les tokens et dimensions de l'app.
- Migration Prisma additive sur `supportSettings` (champ booléen avec défaut) — sans impact sur les lignes existantes.
