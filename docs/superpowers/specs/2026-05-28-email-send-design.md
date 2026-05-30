# Email Send v1 — Design

> Status : draft awaiting user approval
> Author : brainstormed 2026-05-28
> Scope decision : départ d'un produit où l'envoi est OUT OF SCOPE (CLAUDE.md) — on lève cette contrainte avec un Send user-triggered conservateur.

## Goal

Le merchant doit pouvoir cliquer « Envoyer » sur un draft généré, et le mail part vers le client via son propre provider OAuth (Gmail / Outlook / Zoho). Pas d'auto-send. Le merchant garde le contrôle total.

## Scope v1

### In scope

- Bouton `Envoyer` user-triggered sur chaque draft de l'inbox preview pane
- Délai 10s côté client après clic (toast « Annuler ↩ envoi dans 8s... »), pas de modal de confirmation
- Auto-transition `Thread.operationalState → waiting_customer` après succès
- Quote du message client dans le body (`> ` prefix, plain text)
- Re-consent OAuth juste-à-temps si scope insuffisant
- In-Reply-To / References threading via `IncomingEmail.rfcMessageId`
- Insert pré-emptif d'`IncomingEmail` outgoing au moment du send (réconciliation customer reply rapide)
- Idempotency atomique (markSending CAS) + cleanup cron 5min
- Safety env var `SEND_DISABLED_FOR_INTERNAL` pour tester sans envoyer pour de vrai

### Out of scope v1

- Auto-send (sur seuil de confiance LLM ou opt-in par thread)
- Modal de confirmation à chaque clic (le délai 10s remplace)
- Quote HTML / multipart MIME (plain text only)
- Attachments
- CC / BCC
- Scheduled send (envoi différé > 10s)
- Détection « nouveau message client arrivé pendant la rédaction » (le merchant verra et répondra séparément)
- Bounce handling automatique (le merchant verra le bounce dans sa boîte normale)
- Send & resolve checkbox (toujours waiting_customer après send)
- UI undo après les 10s

## Architecture

```
User clic « Envoyer »
  ↓
POST /app/inbox?intent=send { draftId }
  ↓
handleSendDraft(shop, draftId)
  ├─ check connection.canSend (scope grantedScopes)
  │   └─ if false → return { needsReauth: true, reauthUrl }
  │
  ├─ atomic markSending(draftId) [CAS]
  │   └─ if reserved.count === 0 → return { error: "already_sending" }
  │
  ├─ if lastError === "timeout"
  │   └─ check Sent folder for our rfcMessageId
  │       └─ if exists → reconcileAlreadySent(); return success
  │
  ├─ assembleRfc822(draft, thread, customer) → { headers, body }
  │
  ├─ MailClient.send(payload) → { rfcMessageId, externalMessageId }
  │   └─ on error → release sendingStartedAt + set sendError → return { error }
  │
  ├─ INSERT IncomingEmail outgoing (sourceMarker="sent_from_app")
  ├─ UPDATE ReplyDraft (sentAt, sentRfcMessageId, linkedOutgoingEmailId)
  ├─ UPDATE Thread (operationalState=waiting_customer, lastStateChangeAt)
  ├─ INSERT ThreadStateHistory (fromState→waiting_customer, reason=draft_sent)
  └─ return { sent: true, sentAt, rfcMessageId }
  ↓
UI shows « ✓ Envoyé il y a Xs » + thread sort de À traiter
```

## Data model changes

### `ReplyDraft` — nouvelles colonnes

```prisma
model ReplyDraft {
  // ... existing fields
  sendingStartedAt        DateTime?
  sentAt                  DateTime?
  sentRfcMessageId        String?
  sendError               String?    // dernier message d'erreur, null sur succès
  linkedOutgoingEmailId   String?    // IncomingEmail.id du row pré-emptif
  @@index([sendingStartedAt])        // pour le cron cleanup
  @@index([sentAt])
}
```

### `IncomingEmail` — nouvelle colonne

```prisma
model IncomingEmail {
  // ... existing fields
  sourceMarker String?    // null = sync normale, "sent_from_app" = créé par handleSendDraft
  @@index([sourceMarker])
}
```

### `MailConnection` — nouvelle colonne

```prisma
model MailConnection {
  // ... existing fields
  grantedScopes String?   // CSV des scopes OAuth grantés au callback (lecture seule, source of truth = le provider)
}
```

## OAuth scope migration

### Scopes ajoutés

| Provider | Avant | Après |
|---|---|---|
| Gmail | `gmail.readonly`, `userinfo.email` | + `gmail.send` |
| Outlook | `Mail.Read User.Read offline_access` | + `Mail.Send` |
| Zoho | `ZohoMail.messages.ALL` | (déjà OK — `messages.ALL` inclut write) |

### Nouvelles connexions

Le `SCOPES` constant dans chaque adapter est mis à jour. Tout nouveau OAuth grant les scopes étendus dès le premier consent.

### Connexions existantes (re-consent JIT)

Au clic Send, `handleSendDraft` check `connection.grantedScopes`. Si scope send manquant :

1. Action renvoie `{ needsReauth: true, reauthUrl: <provider OAuth URL avec full scopes>, returnTo: <thread URL> }`
2. UI affiche un écran 1-page : « Vous allez ré-autoriser <provider> pour activer l'envoi. Vous restez seul à déclencher chaque envoi. » + bouton « Continuer »
3. Click → redirect OAuth → callback → upsert MailConnection avec nouveau grantedScopes → redirect retour vers thread
4. UI affiche bouton Send normal

### Persistance du grantedScopes

Au callback OAuth, le code de chaque adapter (gmail/outlook/zoho) lit le scope grant retourné par le provider et l'écrit dans `MailConnection.grantedScopes` (CSV format pour grep facile).

### App Store impact

- Google : `gmail.send` est dans le tier « sensitive » (pas « restricted »). Pas de re-verification chrono-bound requise. La justification doit être mise à jour dans le Google Cloud Console OAuth consent screen.
- Microsoft : `Mail.Send` est un delegated permission standard. Pas de re-approval Microsoft requise.
- Zoho : pas de changement de scope, pas d'impact.
- Shopify : aucun scope Shopify ajouté.
- Privacy policy : ajouter mention « Nous envoyons des emails depuis votre boîte mail uniquement sur votre action explicite, jamais automatiquement. »

## Assemblage RFC822

### Headers

```
From: <MailConnection.email>
To: <customer email = IncomingEmail.fromAddress du dernier incoming>
Subject: Re: <subject original> [Re: ajouté si pas déjà présent]
In-Reply-To: <incoming.rfcMessageId>
References: <chaîne de rfcMessageId du thread, ordre chronologique>
Message-ID: <auto-générée par notre code : @<shop>.<random>>
Date: <now RFC2822>
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable
```

### Body

```
<contenu du ReplyDraft.body>

Le <date>, <customer name|email> a écrit :
> <ligne 1 du message original>
> <ligne 2 du message original>
> ...
```

Quote du dernier incoming message uniquement (pas le thread complet — évite explosion taille pour les threads longs).

### Encoding par provider

| Provider | Méthode |
|---|---|
| Gmail | RFC822 entier → base64url → POST `/gmail/v1/users/me/messages/send` |
| Outlook | Pattern « create draft + send » : POST `/me/messages` (retourne id) + POST `/me/messages/{id}/send`. 2 round-trips mais on récupère l'id pour l'insert pré-emptif (l'endpoint `/me/sendMail` retourne 202 no body, inutilisable pour le link). |
| Zoho | POST `/accounts/{accountId}/messages` avec objet JSON structuré (Zoho retourne le messageId) |

## Idempotency & cleanup

### Atomic markSending

```ts
const reserved = await prisma.replyDraft.updateMany({
  where: { id: draftId, sentAt: null, sendingStartedAt: null },
  data: { sendingStartedAt: new Date() },
});
if (reserved.count === 0) return { error: "already_sent_or_sending" };
```

### Cleanup cron

Dans la boucle auto-sync (tick toutes les 5min), une fonction `releaseStaleSendingDrafts` :

```ts
const cutoff = new Date(Date.now() - 5 * 60 * 1000);
await prisma.replyDraft.updateMany({
  where: { sendingStartedAt: { lt: cutoff }, sentAt: null },
  data: { sendingStartedAt: null, sendError: "send_timeout_released" },
});
```

5min = bound supérieur largement au-delà de tout cas légitime (envoi normal = 1-3s).

### Retry après timeout

Au retry (`sendError === "send_timeout_released"`), avant de re-call MailClient.send :

```ts
const existing = await mailClient.findSentByRfcMessageId(ourRfcMessageId);
if (existing) {
  // Le provider l'avait reçu sur le call précédent — pas de double-send
  return reconcileAlreadySent(draft, existing);
}
```

Coût : 1 API call de check avant retry. Acceptable car retry rare.

## Réconciliation outgoing ↔ sync

### Insert pré-emptif

Au succès de `MailClient.send`, on insère immédiatement un `IncomingEmail` row :

```ts
const outgoingEmail = await prisma.incomingEmail.create({
  data: {
    shop, mailConnectionId,
    externalMessageId: providerReturnedId,
    rfcMessageId: ourGeneratedRfcMessageId,
    inReplyTo: incomingEmail.rfcMessageId,
    fromAddress: mailConnection.email,
    toAddresses: [customerEmail],
    subject: assembledSubject,
    bodyText: assembledBody,
    receivedAt: new Date(),
    canonicalThreadId: thread.id,
    processingStatus: "outgoing",
    tier1Result: "outgoing",
    sourceMarker: "sent_from_app",
  },
});
```

Bénéfices :
1. Si le client répond entre T0 et T+5min (prochaine sync), son reply a `In-Reply-To = <ourRfcMessageId>` → le thread reconciler trouve notre row → match thread correct, pas d'orphelin.
2. Le draft est lié à un `IncomingEmail` concret (`ReplyDraft.linkedOutgoingEmailId`) → audit + UI traçabilité.
3. Le pane preview du thread affiche immédiatement le message envoyé sans attendre la sync.

### Dedup à la sync

Quand la sync fetch le dossier Sent du provider 5min plus tard et y trouve notre mail :
- Le match se fait via `@@unique([shop, externalMessageId])` → upsert détecte l'existing → no duplicate row
- Si le provider a rewrite le `rfcMessageId` (Gmail le fait parfois), on UPDATE notre row pour mettre la version provider-canonique :

```ts
await prisma.incomingEmail.update({
  where: { shop_externalMessageId: { shop, externalMessageId } },
  data: { rfcMessageId: syncedMessage.rfcMessageId },
});
```

Pourquoi safe : avant l'overwrite, les In-Reply-To clients pointent vers notre version ; on les a déjà résolus en thread. Après overwrite, les futurs reply pointent vers la version provider, qui est maintenant dans notre DB. Pas de cassure.

### Source marker

Le badge UI distingue :
- `sourceMarker = "sent_from_app"` + processingStatus=outgoing → « Sortant (envoyé depuis Automail) »
- `sourceMarker = null` + processingStatus=outgoing → « Sortant (envoyé directement depuis votre boîte mail) »

Permet de tracer ce qui passe par l'app vs ce qui passe en parallèle directement par le merchant.

## UI integration

### SendButton component

Placé dans le pane preview à côté de « Régénérer le brouillon » / « Marquer comme résolu ».

**États** :

| État | Affichage | Comportement |
|---|---|---|
| Idle | Bouton « Envoyer » (primary) | Disabled si pas de draft. Click → state Pending. |
| Pending | Toast `✓ Envoi à <customer> dans 8s · [Annuler]` (countdown) | Bouton disabled. Click Annuler → cancel setTimeout → state Idle. Sinon après 10s → POST `handleSendDraft`. |
| Sent | `✓ Envoyé il y a Xs · [Voir]` | Stable, link vers le thread updated. |
| Error | Toast rouge `⚠ Échec envoi : <message>. [Réessayer]` | Bouton re-enabled. Retry click → POST direct (sans nouveau délai 10s). |
| NeedsReauth | `🔒 Activer l'envoi pour cette boîte →` | Click → page explicative → OAuth redirect. |

### Détection canSend

Le loader du thread enrichit `connection` avec `canSend: boolean` (calculé depuis `grantedScopes`). Pas de round-trip OAuth à chaque load — pure lecture DB.

### Page d'explication re-consent

Route nouvelle `/app/mail-auth/reauth?mailConnectionId=<id>&returnTo=<url>` :

```
🔒 Activer l'envoi pour <email> (<Provider>)

Pour pouvoir envoyer des emails depuis Automail, nous avons besoin 
d'une permission supplémentaire de <Provider>.

✓ Aucun envoi automatique — vous gardez le contrôle total
✓ Chaque envoi nécessite votre clic explicite
✓ Nous n'accédons à aucun mail au-delà de ce que vous voyez déjà

[Continuer vers <Provider>]    [Annuler]
```

Click Continuer → redirect OAuth avec scopes étendus → callback → upsert `grantedScopes` → redirect `returnTo`.

## State machine integration

### Post-send transition

```ts
await prisma.$transaction([
  prisma.replyDraft.update({ ... sentAt, linkedOutgoingEmailId ... }),
  prisma.thread.update({
    where: { id: thread.id },
    data: { operationalState: "waiting_customer", lastStateChangeAt: new Date() },
  }),
  prisma.threadStateHistory.create({
    data: {
      threadId: thread.id,
      fromState: thread.operationalState,
      toState: "waiting_customer",
      reason: "draft_sent",
      triggeredBy: "user_send",
    },
  }),
]);
```

### Customer reply

Quand le customer répond, sync ingère → state machine recompute → `waiting_customer → open` → thread revient en « À traiter ». Comportement existant inchangé.

## Safety: SEND_DISABLED_FOR_INTERNAL

Env var booléenne. Si `true` :
- `MailClient.send` court-circuité : retourne `{ rfcMessageId: fakeId, externalMessageId: fakeId }` sans appel API réel
- Tout le reste du flow tourne (DB writes, transitions, insert outgoing, etc.)
- Banner permanent dans l'UI : « 🧪 Envois désactivés (boutique interne) — Cliquez quand même pour tester le flow »
- Check appliqué uniquement aux shops `ShopFlag.isInternal=true` (la prod publique ne short-circuit jamais)

Render prod : env var jamais set → tous les envois réels passent. Dev tunnel : env var set → tests safe.

## Tests

### Unit
- `assembleRfc822(draft, thread, customer)` — headers (In-Reply-To, References, Subject Re: prefix), body (quote formatting), UTF-8 encoding
- `markSending` / `markSent` / `releaseSending` — atomic CAS comportement
- `quoteOriginalMessage(body, fromName, receivedAt)` — formatting

### Integration (Postgres réel)
- handleSendDraft succès → ReplyDraft.sentAt set, IncomingEmail outgoing créé avec sourceMarker="sent_from_app", Thread waiting_customer, ThreadStateHistory entry, linkedOutgoingEmailId set
- handleSendDraft double-click → 1er succède, 2ème retourne `{ error: "already_sent_or_sending" }`
- handleSendDraft scope insuffisant → `{ needsReauth: true, reauthUrl }`, pas d'effet DB
- handleSendDraft provider throw → sendingStartedAt released, sendError set, pas d'IncomingEmail créé
- Cleanup cron → après 5min, sendingStartedAt release si pas sentAt, sendError="send_timeout_released"
- Dedup à la sync : sync ingère le sent → match par externalMessageId → no duplicate row, rfcMessageId rewrite OK
- Customer reply dans la fenêtre T0→T+sync → thread reconciler trouve l'outgoing pré-emptif → canonicalThreadId correct
- Send timeout → retry avec check Sent folder via `mailClient.findSentByRfcMessageId` → trouve existing → marque sent sans re-send
- SEND_DISABLED_FOR_INTERNAL=true → MailClient.send court-circuité, tout le reste du flow tourne, fakeId stocké

### E2E (Playwright)
Déféré. À déclencher à la demande explicite de l'utilisateur.

## Risks

### Hard

- **From alias** : Gmail/Outlook rejettent si From ne matche pas une adresse Send-mail-as configurée. À documenter dans l'onboarding.
- **App Store / OAuth consent screens** : nouvelle soumission Google Cloud Console (justification scope sensitive `gmail.send`) et Microsoft Entra (justification `Mail.Send`). Peut prendre 1-2 semaines de review Google.
- **Double-send après timeout** : mitigé par check Sent folder au retry, mais reste un risque mince si le provider est lent à indexer (1-2s) entre les 2 tentatives.

### Soft

- **DKIM/branding** : si le merchant n'a pas configuré son domaine custom comme alias dans Gmail/Outlook, le destinataire voit « via gmail.com » dans les headers. À documenter, pas bloquant v1.
- **Pas d'undo après 10s** : irréversible. Le délai 10s + toast Annuler est la seule protection. Acceptable v1.
- **Send pendant une sync simultanée** : si un nouveau message client arrive entre la génération du draft et le clic Send, le merchant l'ignorera. V1 simple, on accepte.

## Open questions

(Aucune au moment de la rédaction — tout a été tranché en brainstorming.)

## Implementation plan

À écrire dans `docs/superpowers/plans/2026-05-28-email-send.md` via la skill `writing-plans` après approbation user de ce design.
