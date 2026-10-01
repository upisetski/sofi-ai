# Architecture

## Goals

The MVP architecture should be:
- simple
- cheap
- observable
- safe from runaway AI costs
- easy to change as product assumptions change

We optimize for learning speed, not hypothetical scale.

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

Newly accepted events have a small configurable reordering delay before processing. For text messages, the same job `available_at` field also provides the debounce timer: each accepted message can push the processing deadline forward, so a burst is processed only after the configured quiet period (10 seconds by default). The first text message in an unprocessed burst receives one localized thinking acknowledgement that echoes up to 1000 Unicode characters of that message. Once the quiet period expires, the worker sends one localized echo containing the text messages from the burst. This is separate from provider event ordering and does not require a new debounce table.

Move to Redis + BullMQ + dedicated workers only if actual workload makes that worthwhile.

## Conversations

Conversation processing is backed by five MVP tables:

- `users` — provider identity.
- `conversations` — current conversation and processing state.
- `conversation_events` — durable inbound callback history.
- `messages` — normalized conversation message projection.
- `jobs` — asynchronous processing and recovery.

For a conversation, each accepted event receives a local position. The position represents durable acceptance order and is not a chronological sequence.

Pending events are processed using:

```text
ORDER BY occurred_at ASC, id ASC
```

where `occurred_at` is the Viber callback timestamp and `id` provides deterministic ordering for equal timestamps.

Very late events are retained as durable history and surfaced operationally rather than silently rewriting already processed conversation state.

Conversation context is built from a bounded set of recent messages and the current processing unit. Do not send unbounded history to the model.

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

Route classes:
- `cheap_text`
- `strong_text`
- `vision`
- `web`

Business logic should not depend directly on a specific model name.

## OpenRouter

OpenRouter is the initial AI gateway because it provides multiple models through one API, provider/model experimentation, provider routing, and web search support.

Specific models remain configuration, not product logic.

## Web search

Search only when current information is needed. When search is used, the answer should include useful sources.

## Vision

Launch supports images only.

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

PostgreSQL is the persistent store for users, conversations, conversation events, messages, jobs, AI requests, daily usage, and analytics events.

The application schema is introduced in feature PRs rather than the initial environment bootstrap.

## Rate and budget protection

Before an OpenRouter request:
1. identify the user
2. check request limits
3. check daily user budget
4. estimate maximum request cost
5. reserve budget
6. call the AI Router
7. record actual cost
8. release unused reservation

Global protection includes a daily budget, monthly budget, economy mode near the threshold, and a hard ceiling.

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

Runtime and integration error monitoring.

### Product analytics

Store product events and AI usage metadata in PostgreSQL initially.

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

PostgreSQL will be added as a Railway managed service when the database layer is implemented.

## Evolution path

### Stage 0

- one Node.js application
- PostgreSQL
- OpenRouter

### Stage 1

- real user analytics
- stronger rate/budget controls
- PostgreSQL-backed jobs

### Stage 2

Only if required:
- Redis
- BullMQ
- dedicated workers
- object storage

### Stage 3

Only if required:
- infrastructure monitoring stack
- dedicated analytics store
- additional services

## Architectural principle

Do not introduce infrastructure because we might need it someday.

Introduce it when a concrete product requirement, measured workload, or operational problem justifies it.
