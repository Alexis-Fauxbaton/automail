# CLAUDE.md

## Project
Shopify custom app for internal customer support assistance.

This app is built for a single Shopify store first.
It is not a public multi-merchant SaaS yet.

## Product goal
The app helps a human support agent answer customer emails faster.

At this stage:
- the user manually pastes the email subject
- the user manually pastes the email body
- the app analyzes the message
- the app retrieves relevant facts from Shopify
- if needed, the app uses tracking information to enrich the answer
- the app generates a cautious draft reply

This is a support copilot, not a full CRM.

## MVP scope
The MVP must support these flows:
- Where is my order
- Delivery delay
- Package marked as delivered but not received
- Package appears stuck
- Refund request
- Unknown / manual review case

The MVP must:
- extract useful identifiers from the message
- search Shopify for matching orders
- retrieve order, customer, fulfillment, and tracking information
- resolve tracking sources when needed
- generate a professional draft reply based on verified facts
- clearly show confidence and ambiguities

## Out of scope for MVP
Do not build any of the following unless explicitly requested:
- Gmail integration
- Outlook integration
- automatic email sending
- automatic refunds
- automatic order edits
- live chat
- WhatsApp / Instagram / omnichannel support
- public Shopify App Store distribution
- advanced analytics dashboards
- multi-store support
- background agents doing autonomous actions

## Core principle
The app must behave as a truth-seeking support assistant.

Order of operations:
1. Parse the email subject and body
2. Detect likely intent
3. Extract identifiers
4. Search Shopify
5. Retrieve verified order and fulfillment facts
6. Resolve tracking source if relevant
7. Retrieve tracking facts if possible
8. Separate verified facts from assumptions
9. Generate a careful draft reply

## Non-negotiable rules
- Never invent Shopify data
- Never invent tracking status
- Never invent a carrier
- Never claim a refund was issued unless verified
- Never claim a parcel is lost unless the source clearly supports it
- If data is missing, say it is missing
- If several possible orders exist, show ambiguity clearly
- If confidence is low, say so
- Prefer structured data over scraping
- Use scraping only as a fallback and isolate it in a dedicated module

## Technical stack
Use the existing Shopify app scaffold.

Preferred stack:
- Shopify app scaffold generated with Shopify CLI
- React Router
- TypeScript
- Shopify Admin API
- simple server-side modules
- minimal dependencies
- clean modular architecture

## Coding style
- TypeScript only
- prioritize readability over cleverness
- small focused modules
- avoid large monolithic files
- avoid business logic inside UI components
- prefer pure functions where possible
- keep data contracts explicit
- add types for all major domain objects
- add comments only where they actually help

## Architecture guidelines
Keep the project modular.

Suggested logical modules:
- `message-parser`
- `intent-classifier`
- `identifier-extractor`
- `shopify-order-search`
- `shopify-order-normalizer`
- `tracking-provider-resolver`
- `tracking-service`
- `response-draft-generator`
- `confidence-scoring`

UI should stay thin and orchestrate server actions only.

## Data flow
Expected high-level flow:
1. User submits subject + body
2. Parse and extract:
   - order number
   - customer email
   - customer name
   - tracking number
   - keywords and support intent
3. Search Shopify in this priority order:
   - order number
   - customer email
   - customer name
   - tracking number
4. If order found, retrieve:
   - order number
   - order date
   - customer name
   - customer email
   - order status
   - financial status if useful
   - fulfillment status
   - tracking numbers
   - tracking URLs
   - carrier if present
   - line items if useful
5. If tracking is relevant:
   - use Shopify tracking URL first if available
   - otherwise use carrier info if available
   - otherwise infer likely provider from tracking number pattern
   - use external tracking lookup only if needed
6. Build a structured result:
   - detected intent
   - extracted identifiers
   - verified Shopify facts
   - verified tracking facts
   - ambiguities / warnings
   - confidence level
   - draft reply

## Confidence model
Use a simple confidence model:
- `high`
- `medium`
- `low`

Examples:
- high: exact order match + clear fulfillment/tracking state
- medium: likely order match but partial tracking info
- low: ambiguous order match or insufficient data

## Draft reply rules
Draft replies must be:
- professional
- concise
- factual
- careful
- ready for human copy/paste

Draft replies must:
- rely on verified facts first
- mention uncertainty when needed
- avoid overpromising
- avoid saying anything unsupported by data

## UI requirements
Keep the interface simple.

Main page must include:
- email subject field
- email body field
- analyze button

Results area must include:
- detected intent
- extracted identifiers
- matched Shopify order(s)
- fulfillment and tracking info
- confidence level
- warnings / ambiguities
- draft reply

No complex design work for MVP.
Functionality first.

## Shopify access rules
Only request and use the minimum necessary Shopify scopes.

Likely required read scopes:
- orders
- customers
- fulfillments / fulfillment-related data

Do not add write capabilities unless explicitly requested.

## Tracking integration rules
Tracking lookup must be extensible.

Requirements:
- create a provider resolution layer
- isolate each tracking source in its own adapter/service
- prefer Shopify-provided tracking URLs or carrier data
- if scraping is introduced, keep it behind a dedicated interface
- clearly label fallback-derived data as less reliable

Do not hardcode one giant tracking logic block inside a route or component.

## Development process
When working on changes:
1. inspect the existing scaffold first
2. propose the minimal implementation plan
3. identify files to create or modify
4. implement in small steps
5. explain meaningful changes
6. avoid broad refactors unless needed

Do not rewrite the entire scaffold unless necessary.

## Dependency policy
- prefer built-in platform capabilities when reasonable
- avoid adding packages for trivial tasks
- keep dependencies minimal
- if adding a dependency, explain why it is needed

## Error handling
- fail safely
- return clear error states
- distinguish between:
  - no match found
  - ambiguous match
  - Shopify API failure
  - tracking lookup failure
  - parsing failure

Never hide uncertainty behind a confident UI message.

## Testing guidance
For MVP, prioritize pragmatic testing.

At minimum:
- test parsing of email subject/body
- test extraction of order numbers and emails
- test Shopify search logic
- test confidence scoring
- test draft generation for common support cases

Use small deterministic test cases when possible.

## Sample product mindset
This is not a generic AI chatbot.

This is an operational support tool that helps answer real customer requests using real store data.

The most important thing is not sounding smart.
The most important thing is being correct, useful, and safe.

## What to avoid
Avoid:
- over-engineering
- generic CRM abstractions too early
- adding background automation too early
- mixing UI code and domain logic
- using AI for facts that can be retrieved from Shopify
- using scraping as the default strategy

## First implementation priority
Build the simplest useful vertical slice:
- page with subject + body input
- parser and extractor
- Shopify order search
- display of verified facts
- simple confidence level
- simple draft reply generation

Only after that should tracking enrichment be expanded.

## Working style
If asked to implement something:
- think step by step
- preserve the current scaffold where possible
- propose minimal viable architecture first
- then implement incrementally