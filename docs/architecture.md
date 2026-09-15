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
  domain/              shared business rules/types when complexity justifies them
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

```text
Viber
  |
  | POST /viber/webhook
  v
integration: verify + parse callback
  |
application: handle use case
  |
integration: send_message / persistence / AI
  |
HTTP 200
```

Webhook handlers should be thin. They validate the external request, call an application use case, and translate the result back to the transport protocol. They must not contain product decisions or user-facing copy.

## Background jobs

The MVP uses a PostgreSQL-backed job table rather than Redis/BullMQ.

A job contains:
- id
- type
- payload
- status
- attempts
- available_at
- locked_at
- created_at
- processed_at
- error

The worker initially runs in the same Node.js application.

Move to Redis + BullMQ + dedicated workers only if actual workload makes that worthwhile.

## Conversations

Conversation context is built from a conversation summary plus recent messages. Do not send unbounded history to the model.

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

PostgreSQL is the planned persistent store for users, conversations, messages, AI requests, jobs, daily usage, and analytics events.

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
