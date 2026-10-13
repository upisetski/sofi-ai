# Architecture

## Goals

The MVP architecture should be:
- simple
- cheap
- observable
- safe from runaway AI costs
- easy to change as product assumptions change

We optimize for learning speed, not hypothetical scale.

The first external release is text + bounded multi-turn context + web search. Its required work packages and release gates are tracked in the [MVP roadmap](roadmap.md). Image/vision is deferred from this release.

## Application structure and business-logic boundaries

The application uses a small layered structure. The layers have explicit responsibilities:

```text
src/
  integrations/       external-system adapters (Viber, OpenRouter, etc.)
  application/        business use cases and orchestration
  localization/       user-facing translated copy and locale selection
  domain/             shared business rules/types when complexity justifies them
  config/              environment/configuration
```

### Integrations

Integration code translates external protocols into application-facing operations and performs external I/O.

Examples:
- Viber webhook signature verification and callback parsing
- Viber `send_message` API client
- OpenRouter client

Integration code must not decide product behavior such as which welcome text to send or which business rule applies.

### Application

Application code contains business logic and use cases.

Examples:
- deciding what should happen for `conversation_started`
- selecting the appropriate user-facing operation
- applying product/rate/budget rules
- orchestrating calls to integrations

Application code should depend on small integration interfaces rather than provider-specific HTTP details.

### Localization

Localization owns:
- supported locales
- locale fallback rules
- user-facing translated strings

Business logic may request a localized message but must not embed translated copy in webhook handlers or provider adapters.

### Domain

Use `src/domain/` for reusable business rules/types once a feature has domain complexity. Do not create domain abstractions speculatively.

### Configuration

Environment variables and runtime configuration belong in `src/config/`. Secrets must never be hard-coded.

## High-level architecture

```text
                         VIBER
                           |
                           v
                 integrations/viber
                           |
                           v
                    application
                           |
                 +---------+---------+
                 |                   |
           localization          AI Router
                 |                   |
                 +---------+---------+
                           |
                       providers
```

The rule is:

> External adapters translate protocols. Application services decide behavior. Localization supplies user-facing language.

## Runtime

Node.js + TypeScript owns the HTTP server, webhook handling, background worker, application logic, rate/budget guards, analytics, and provider orchestration.

Fastify is used for the Viber webhook, health check, and future API/admin endpoints.

## Viber request flow

The webhook acknowledges only after the callback has been durably accepted:

```text
Viber
  |
  | POST /viber/webhook
  v
verify + parse + validate
  |
  v
PostgreSQL transaction
  |-- upsert user
  |-- resolve conversation
  |-- insert/deduplicate event
  |-- create or wake processing job
  |
  v
HTTP 200
  |
  v
conversation worker
  |
  |-- select events by Viber timestamp
  |-- serialize processing per conversation
  |-- update conversation state
  |-- project inbound messages
  v
future: AI / outbound processing
```

Webhook handlers should be thin. They validate the external request, persist it through an application use case, and translate the result back to the transport protocol. They must not perform AI work or contain user-facing product decisions.

## Background jobs

The MVP uses a PostgreSQL-backed job table rather than Redis/BullMQ.

A job contains:
- id
- type
- conversation_id
- status
- attempts
- available_at
- locked_at
- created_at
- completed_at
- last_error

The worker initially runs in the same Node.js application.

A conversation processing job is created or woken as part of accepting an inbound event. Processing uses PostgreSQL locking so one conversation is handled by at most one worker at a time, while unrelated conversations can run concurrently.

Newly accepted events have a small configurable reordering delay before processing. For text messages, the same job `available_at` field also provides the debounce timer: each accepted message can push the processing deadline forward, so a burst is processed only after the configured quiet period (10 seconds by default). Text messages do not trigger an immediate response. Once the quiet period expires, the worker processes the persisted burst and sends one AI-generated text response through the existing Viber client. If generation fails, Sofi sends a localized temporary-error response rather than echoing user text. This is separate from provider event ordering and does not require a new debounce table.

Move to Redis + BullMQ + dedicated workers only if actual workload makes that worthwhile.

## Conversations

Conversation processing is backed by PostgreSQL tables:

- `users` — provider identity.
- `conversations` — current conversation, context version, and processing state.
- `conversation_events` — durable inbound callback history.
- `messages` — ordered user/assistant message content; assistant content is stored only once.
- `conversation_turns` — durable turn generation and delivery state, retry counters, and the reference to the stored assistant message.
- `viber_delivery_callbacks` — content-free Viber delivery callback metadata keyed by outbound message token, including callbacks that arrive before the sender has persisted its token.
- `jobs` — asynchronous processing and recovery.

For a conversation, each accepted event receives a local position. The position represents durable acceptance order and is not a chronological sequence.

Pending events are processed using:

```text
ORDER BY occurred_at ASC, id ASC
```

where `occurred_at` is the Viber callback timestamp and `id` provides deterministic ordering for equal timestamps.

Very late events are retained as durable history and surfaced operationally rather than silently rewriting already processed conversation state.

Conversation context uses up to 12 recent user/assistant messages from the current context version, followed by the current debounced burst. The combined history and current-user content is bounded by the existing 12,000-character AI input limit; current input takes priority over older history. History includes only previous turns whose generation succeeded and whose outbound send was accepted or confirmed delivered. Failed-generation fallbacks and reset acknowledgements are not fed back as context. Users can send `/reset` (or `/forget`) to clear prior context for their conversation.

Rapid text-message debounce is implemented at the job scheduling layer. Messages remain separate durable events/messages; debounce changes only when the conversation processing job becomes eligible. The current Viber Bot API does not provide a typing-indicator operation, so the waiting period does not send a typing signal.

## AI Router

All provider calls go through one internal abstraction.

Example:

```ts
ai.generate({
  input,
  conversation,
  hasImage,
  needsWeb,
})
```

Target route classes for the first text + web MVP:
- `cheap_text`
- `web`

`strong_text` may be added later if evaluations justify its cost. `vision` is deferred until after this MVP.

Business logic should not depend directly on a specific model name. The initial `cheap_text` route maps to `AI_MODEL_CHEAP_TEXT` (default `openai/gpt-6-luna`). The OpenRouter adapter sets a request timeout and `max_tokens` and sends `provider.zdr` (default true) plus `provider.data_collection` (default `deny`) on every request. Operators can override these through `OPENROUTER_REQUIRE_ZDR` and `OPENROUTER_DATA_COLLECTION_POLICY`, but production must retain strict settings unless an alternative has been reviewed and verified. Request-level filters supplement rather than replace account privacy settings and guardrails. The effective provider endpoint must still be verified; if no endpoint meets the selected privacy policy, the request should fail rather than relaxing the policy. The current implementation uses OpenRouter defaults for provider selection and fallback. Before the MVP, configure and test route-specific models and bounded fallback/retry behavior, as described in the [roadmap](roadmap.md). The combined user input is capped at 12000 characters; generated output is capped by `AI_MAX_OUTPUT_TOKENS` (default 512).

For each processed text burst, one `conversation_turns` row is committed with the event cursor and inbound message projection. A conversation worker holds a PostgreSQL session-level advisory lock for the lifecycle of that conversation turn, generates only when no assistant message has been persisted, and commits the assistant message plus delivery state before attempting an outbound Viber send. The job remains pending while eligible turn or inbound work remains and is recovered after its lease becomes stale. Generation retries are bounded to three attempts and delivery retries to five attempts with backoff; terminal states and safe failure categories remain queryable. The worker periodically redacts processed inbound event payloads after 30 days, deletes expired message content after 30 days unless required for an unfinished turn, and retains deduplication/delivery metadata for up to 90 days.

The Viber Bot API returns a message token for accepted `send_message` calls and provides `delivered`, `seen`, and `failed` callbacks. The application stores these callbacks and correlates them with turns by token, including callback-before-response races. Viber does not document an outbound idempotency key, so an interrupted send with an unknown outcome is retried at most within the bounded delivery policy and may be delivered twice. A `failed` callback is stored as a terminal/uncertain outcome rather than automatically resent. See [ADR 0008](decisions/0008-durable-chat-turn-and-viber-delivery.md) and the [feature specification](features/multi-turn-context-and-durable-delivery.md).

## OpenRouter

OpenRouter is the initial AI gateway because it provides multiple models through one API, provider/model experimentation, provider routing, and web search support.

Specific models remain configuration, not product logic.

## Web search

Search only when current information is needed. When search is used, the answer should include useful sources.

## Vision (deferred until after the first MVP)

The first external MVP accepts text input only. If vision is added later, support images only in that feature's scope.

```text
Viber media URL
  |
download temporarily
  |
optional resize
  |
vision model
  |
answer
  |
delete temporary data
```

Do not persist images by default.

## Data

Current PostgreSQL persistence covers users, conversations, inbound events, user/assistant messages, durable conversation-turn/delivery state, delivery callback metadata, jobs, and the content-free `ai_usage_attempts` ledger. `usage_budget_mutex` serializes budget reservations and reconciliation. Minimal product analytics remain a separate roadmap work package.

## Rate and budget protection

Every current `cheap_text` provider call goes through the AI Router with a stable internal user ID, conversation ID, durable turn ID, and WP1 generation-attempt number. The router builds the bounded provider messages, reserves a conservative cost bound in PostgreSQL, marks the attempt in-flight, and only then calls OpenRouter. The application enforces:

- Per-user daily provider-attempt count and daily spend.
- Global UTC daily and monthly spend ceilings, including held/uncertain reservations.
- Economy mode at the configured `AI_ECONOMY_THRESHOLD_PERCENT` (default 80%) of projected global daily/monthly spend, limiting output to `AI_ECONOMY_MAX_OUTPUT_TOKENS` (default 256) or the normal token cap, whichever is lower.
- Fail-closed behavior for unknown model pricing and budget denial, with localized user-facing copy.

The content-free `ai_usage_attempts` ledger distinguishes actual, estimated, and unknown costs. OpenRouter usage/cost reporting is requested explicitly. If a response includes actual cost, it is reconciled; if cost is missing but both token counts exist, cost is estimated from the reviewed configured model rates. Missing usage/cost or ambiguous provider outcomes retain a conservative hold instead of silently recording zero. Reservations that expire before entering in-flight can be released; expired in-flight attempts are marked uncertain. Terminal accounting records are retained for 90 days.

Initial configurable defaults are 50 provider attempts per user/day, $0.20 per user/day, $2 global/day, and $30 global/month. There is no separate per-request price cap; bounded input/output, timeouts, request-count limits, and global budgets remain in force. The default reviewed `openai/gpt-6-luna` rates are $0.10/M input tokens and $0.50/M output tokens (OpenRouter standard rates checked 2026-10-13). To switch models, set `AI_MODEL_CHEAP_TEXT`, `AI_USAGE_PRICING_MODEL`, `AI_USAGE_INPUT_PRICE_PER_MILLION_USD`, and `AI_USAGE_OUTPUT_PRICE_PER_MILLION_USD` consistently in Railway. A custom model requires a matching pricing model and verified rates or the guard blocks the call. Operators must also configure an OpenRouter account-level spend cap before an external pilot.

The shared accounting contract accepts AI Router route IDs, but web search is not implemented by WP2. WP3 must reserve for any separately billed search/tool costs before the `web` route is enabled. Structured budget and usage events are not a substitute for WP4 alerting or a dashboard.

## Privacy principles

- minimize stored personal data
- do not persist avatars unless needed
- avoid long-term image storage
- avoid full user content in technical logs
- consider data retention when adding persistent fields
- use appropriate provider privacy/ZDR controls where applicable

Belarusian personal-data requirements must be validated separately before public launch.

## Observability

### Pino

Structured application logs. Do not log sensitive user content.

### Sentry

Sentry is the intended runtime and integration error-reporting service, but a `SENTRY_DSN` environment variable alone does not initialize the SDK. Wire and verify actual error reporting before the first external rollout, or document and implement an alternative.

### Product analytics

Minimal product events and AI usage/cost metadata should be stored in PostgreSQL initially. This is a roadmap item, not a claim that complete product analytics is already implemented.

## Admin / dashboard

Do not build a custom admin frontend initially. Start with PostgreSQL-backed queries or Metabase.

## Deployment

Railway is the intended production platform.

```text
GitHub
  |
Railway application service
  |
root Dockerfile
  |
Node.js application
```

Railway PostgreSQL is the intended managed production database. The application runs database migrations before accepting traffic and checks PostgreSQL readiness through `/health`.

## Evolution path

### Current implemented baseline

- One Node.js application.
- PostgreSQL-backed event persistence and jobs.
- OpenRouter through the internal AI Router.
- Text-only generation after the existing debounce.
- PostgreSQL usage accounting and enforced budget reservations for `cheap_text`.

### Before the first external MVP

Follow the ordered work packages and explicit release gates in [docs/roadmap.md](roadmap.md):

1. Multi-turn context plus durable turn/reply and delivery lifecycle.
2. Usage/cost accounting and enforced user/request/global limits.
3. Configurable `cheap_text` and `web` routes, web search, and bounded fallbacks.
4. Runtime monitoring, cost visibility, and minimal product analytics.
5. Provider/search privacy verification and end-to-end release validation.

Instrument observability as each work package is implemented; this list does not imply these capabilities already exist.

### After the MVP, only if required

- Image/vision support.
- Additional model routes such as `strong_text` when evaluation supports them.
- Redis, BullMQ, or dedicated workers.
- Object storage, a separate analytics store, or a custom admin frontend.

## Architectural principle

Do not introduce infrastructure because we might need it someday.

Introduce it when a concrete product requirement, measured workload, or operational problem justifies it.
