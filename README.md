# Automail

Shopify app that helps a human support agent answer customer emails faster.

The agent pastes an email subject and body. Automail parses it, searches the Shopify store for matching orders, retrieves fulfillment and tracking facts, and generates a cautious draft reply based on verified data only.

This is a support copilot, not a bot. Nothing is sent automatically.

---

## What it does

- Detects support intent, including multiple intents in the same thread when needed (for example delivered-not-received + refund request)
- Extracts identifiers from the message (order number, customer email, tracking number)
- Searches the Shopify Admin API for matching orders
- Retrieves order, fulfillment, and tracking facts
- Scores confidence (high / medium / low) based on data completeness
- Generates a professional draft reply ready for copy-paste
- Shows ambiguities and missing data explicitly — never invents facts

## Supported flows (MVP)

Canonical support intents are defined by `SUPPORT_INTENTS` in `app/lib/support/types.ts`:

| Intent | French label | Description |
|--------|--------------|-------------|
| `where_is_my_order` | Ou est ma commande | Order and fulfillment lookup |
| `delivery_delay` | Retard de livraison | Estimated delivery context, including stuck tracking or no movement updates |
| `marked_delivered_not_received` | Livre non recu | Last-mile investigation when tracking says delivered but the customer says they did not receive the parcel |
| `damaged_product` | Produit abime | Product or item received damaged, broken, or unusable |
| `order_error` | Erreur de commande | Wrong item, wrong size/color, missing item, or preparation mistake |
| `refund_request` | Remboursement | Refund, reimbursement, or money-back request |
| `pre_purchase_question` | Question avant achat | Question before buying or placing an order |
| `unknown` | Autre | Manual review when no supported intent clearly applies |

Analyses keep a primary `intent` for prioritization, SQL filtering, and draft generation, and can also include an ordered `intents` array for every detected intent. Older analyses without `intents` are treated as single-intent using their primary `intent`.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | React Router 7 + Shopify App React Router |
| UI | Shopify Polaris web components |
| Database | PostgreSQL via Prisma |
| Mail providers | Gmail, Zoho Mail |
| LLM | OpenAI (classification + draft generation) |
| Hosting | Render (single instance) |

---

## Development setup

### Prerequisites

- Node >= 20.19 or >= 22.12
- PostgreSQL database (local or hosted — Neon, Supabase, etc.)
- Shopify Partner account + dev store
- Shopify CLI

### Environment variables

```
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_APP_URL=
DATABASE_URL=          # PostgreSQL connection string
OPENAI_API_KEY=
GOOGLE_CLIENT_ID=      # Gmail OAuth
GOOGLE_CLIENT_SECRET=
ZOHO_CLIENT_ID=        # Zoho OAuth (optional)
ZOHO_CLIENT_SECRET=
```

### Install and run

```shell
npm install
npx prisma migrate deploy
npm run dev
```

Press `p` in the CLI to open the embedded app in your dev store.

---

## Architecture

```
app/
  lib/
    gmail/          pipeline, classifier, prefilter, mail client
    zoho/           Zoho mail client
    mail/           auto-sync loop, job queue, backfill, thread resolver
    support/        orchestrator, LLM parser, draft generator,
                    tracking service, Shopify order search, confidence scoring
    llm/            shared LLM client with cost tracking
  routes/
    app.inbox.tsx   main inbox UI + action handlers
    app.privacy.tsx public privacy policy
    webhooks/       app/uninstalled, scopes_update
prisma/
  schema.prisma     data model
  migrations/
```

### Key models

| Model | Purpose |
|-------|---------|
| `Thread` | Canonical conversation identity (may group multiple provider thread IDs) |
| `IncomingEmail` | Individual message with per-message classification and analysis |
| `MailConnection` | OAuth credentials + sync config per shop |
| `SyncJob` | Durable background job queue (sync, backfill, resync) |
| `LlmCallLog` | Per-call cost and token tracking |

### Mail sync and tracking refresh

Mailbox sync also keeps visible Shopify/tracking facts fresh. After each manual
or automatic mail sync, active support analyses are refreshed when their
`IncomingEmail.lastAnalyzedAt` value is missing or older than 24 hours.

The refresh re-runs the support analysis for the latest analyzed incoming email
per thread, which refetches Shopify order/fulfillment data and tracking facts.
It does not run for threads explicitly classified as `non_support`, or for
threads in `resolved` / `no_reply_needed` states.

The inbox displays the analysis freshness next to the Tracking section title
(`Updated ...` / `Not yet updated`). Draft regeneration and refinement also
trigger a stricter 1-hour freshness check before generating text.

### Shopify scopes

Read-only: `read_orders`, `read_all_orders`, `read_customers`, `read_fulfillments`.

No write scopes are requested. The app reads Shopify data but never mutates it.

---

## Testing

The test suite has three independent levels, each requiring more infrastructure than the previous.

### Unit tests

No database or server required.

```shell
npm test
```

### Integration tests

Requires a PostgreSQL database. The tests use an isolated shop domain (`integration-test.myshopify.com`) so they can run against the same database as development without polluting real data.

Additional environment variables:

```
DATABASE_URL_TEST=   # PostgreSQL connection string for the test DB (can be the same as DATABASE_URL)
DIRECT_URL=          # Optional — direct connection bypassing PgBouncer (recommended if using a pooler)
GOOGLE_CLIENT_ID=    # Can be a dummy value — used by the token-refresh test
GOOGLE_CLIENT_SECRET=
```

```shell
DATABASE_URL_TEST=postgresql://... npm run test:integration
```

### E2E tests (Playwright)

Requires the development server running and Chromium installed.

```shell
# One-time browser install
npx playwright install chromium

# Terminal 1 — start the dev server
npm run dev

# Terminal 2 — run E2E tests
npm run test:e2e
```

By default the tests connect to `http://localhost:58496`. Override with:

```shell
E2E_BASE_URL=http://localhost:PORT npm run test:e2e
```

Additional options:

```shell
npm run test:e2e:headed   # watch the browser
npm run test:e2e:ui       # interactive Playwright UI
```

### Run all levels

```shell
npm test && npm run test:integration && npm run test:e2e
```

---

## Deployment

The app runs as a single Node process on Render. The auto-sync background loop
starts at boot (`entry.server.tsx`) and polls for new emails on a per-shop interval.
Each auto-sync cycle also refreshes active support tracking/Shopify analyses
older than 24 hours.

```shell
npm run setup   # prisma generate + migrate deploy
npm start       # react-router-serve
```

Set `NODE_ENV=production` in your hosting environment.
