# Automail — App Store listing content

Drafts to paste into Partner Dashboard when converting to Public Draft.
Keep all copy in English (App Store primary language) — translations are
handled at runtime by i18n.

## Tagline (max 30 chars)

AI drafts for support emails

## Short description (max 100 chars)

Save hours on customer support: Automail drafts careful AI replies grounded in real Shopify order data.

## Long description (max 3000 chars)

Automail is a support copilot for Shopify merchants. Connect your Gmail
or Zoho mailbox, and Automail will read incoming customer messages,
identify support intent, look up the matching order in your Shopify
admin, retrieve fulfillment and tracking details, and draft a careful,
factual reply that you can review and send.

### Why Automail

- **Grounded in your data, not guessed**: every draft references the actual order, fulfillment status, and tracking events. No hallucinated details, no invented refunds.
- **Aware of ambiguity**: when several orders match a customer's email, Automail surfaces the candidates instead of picking blindly.
- **Confidence-rated**: each draft comes with a confidence level (high / medium / low) so you know when to trust it and when to double-check.
- **You stay in control**: drafts are never sent automatically. You review, edit, and send.

### What Automail handles

- Where is my order tracking requests
- Late delivery and stuck shipments
- Marked-delivered-but-not-received cases
- Damaged or wrong product complaints
- Refund requests with policy reference
- Pre-purchase questions

### Pricing

- **14-day free trial** — full access, no quota
- **Starter — $9/month**: 50 drafts, 1 mailbox, basic dashboard (7 days)
- **Pro — $49/month**: 500 drafts, 3 mailboxes, full dashboard (90 days)

Upgrade anytime, no commitment.

### What we do NOT do

- We don't send emails for you
- We don't issue refunds for you
- We don't make changes to your orders
- We don't store your customers' payment data

## Categories

- Customer service
- Productivity
- Operations

## Tags

customer support, AI, drafts, email, gmail, zoho, outlook, helpdesk, automation

## Support contact

Email: support@automail.app (PLACEHOLDER — replace with real one before submit)

## Privacy policy URL

https://automail-vc6z.onrender.com/privacy

## Screenshots needed

To take from AMBIENT HOME (or a clean dev store) once we convert:

1. **Inbox view** — main page with the support tabs (À traiter, Attente client, Résolu) and a few real threads with intent badges
2. **Thread detail** — one thread expanded with order context + draft generated + tracking section
3. **Dashboard** — KPIs + heatmap + top intents (Pro plan view)
4. **Billing page** — the Starter / Pro card grid with one marked as current
5. **Settings** — the personalization page (signature, tone, language, refund policy)

Take both light-mode and (if possible) at multiple viewport sizes. 1280x800 minimum, ideally 2560x1600 retina.

## App icon

Required: 1200×1200 px, PNG, no transparency.

Status: TODO. Need to design or commission. Suggestion: a minimalist "A" or envelope-with-spark glyph in the brand color.

## Scope justifications (for Partner Dashboard scope justification fields)

### `read_orders`

Required to retrieve the order matching a customer's support email — order number, customer name, email, items, status — so the AI draft references actual order data instead of hallucinating.

### `read_all_orders`

Customer support emails frequently reference orders that are months old — warranty issues, delivery delays exceeding 60 days, returns, missing items from past purchases. Without this scope, Shopify silently filters orders older than 60 days from API responses, which would cause Automail to claim "no order found" for legitimate customer inquiries about older orders. We use this scope ONLY to look up orders referenced in customer support emails, not for bulk export or analytics.

### `read_customers`

Required to match an incoming customer email address to a Shopify customer record so the AI can address the customer correctly and verify their identity against the order.

### `read_fulfillments`

Required to retrieve fulfillment status, carrier, and tracking number — the most common questions customers ask. Without this, Automail couldn't answer "where is my order" requests with verified data.

## FAQ for review team

Anticipated questions reviewers may ask, with prepared answers.

### Why do you need read_all_orders scope?

To find the order matching a customer's support email even if it's older than 60 days. Many support tickets reference orders from 2-6 months ago (warranty, returns, missing items). Without this scope, those tickets can't be answered correctly. The scope is used solely for per-email order lookup, never for bulk export or analytics.

### How is customer email content protected?

- Email content is processed in-memory; only the structured analysis result (intent, identifiers, tracking) is persisted alongside email metadata.
- The full email body is stored encrypted at rest in Postgres (Neon).
- OAuth refresh tokens for mail providers are encrypted with AES-256-GCM (see `app/lib/gmail/crypto.ts`).
- Compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) are implemented in `app/routes/webhooks.customers.*.tsx` and `webhooks.shop.redact.tsx`.

### Why a 14-day trial?

Standard Shopify Billing trial duration. Sufficient for a merchant to observe a real support cycle (usually 1-2 weeks of email traffic) and decide.

### Is data shared with third parties?

LLM analysis is performed via the OpenAI API for intent classification, identifier extraction, and reply drafting. Tracking lookups go through 17track API. Both relationships are described in the privacy policy. No customer data is sold or used for advertising.

### What happens if a merchant uninstalls?

The `app/uninstalled` webhook handler (`app/routes/webhooks.app.uninstalled.tsx`) deletes all shop-scoped data: sync jobs, LLM call logs, incoming emails, threads, mail connection, support settings, user preferences, and session. The `shop/redact` webhook fires 48 hours after uninstall as a final safety net per Shopify's GDPR requirements.
