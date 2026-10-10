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

Target route classes for the first text + web MVP:
- `cheap_text`
- `web`

`strong_text` may be added later if evaluations justify its cost. `vision` is deferred until after this MVP.

Business logic should not depend directly on a specific model name. The initial `cheap_text` route maps to `AI_MODEL_CHEAP_TEXT` (default `google/gemma-3-4b-it`). The OpenRouter adapter sets a request timeout and `max_tokens`, but does not hard-code provider selection, ZDR, or data-collection policy in each request; these policies are configured centrally in OpenRouter account privacy settings and guardrails where supported. Omitting request-level privacy options does not disable account-wide or guardrail enforcement. Free-tier routing does not support data-policy-based routing, so use only synthetic test messages unless the selected plan and endpoint provide the required privacy guarantees. The current implementation uses OpenRouter defaults for provider selection and fallback. Before the MVP, configure and test route-specific models and bounded fallback/retry behavior, as described in the [roadmap](roadmap.md). The combined user input is capped at 12000 characters; generated output is capped by `AI_MAX_OUTPUT_TOKENS` (default 512).

The current worker completes its PostgreSQL job before attempting AI generation and delivery. Generation errors are observed through structured logs and a temporary-error response; there is no automatic retry or fallback, so a subsequent Viber delivery failure is not retried. This is a known pre-MVP reliability gap: persist turn/reply and delivery state, then implement bounded recovery as specified by the [roadmap](roadmap.md).

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

Current PostgreSQL persistence covers users, conversations, inbound events/messages, and jobs. Durable assistant-turn/delivery state, AI usage and cost accounting, and product analytics persistence still need to be introduced in focused feature PRs. Do not assume these tables/controls already exist because they appear in a target design.

## Rate and budget protection

Planned public-launch protection should, before an OpenRouter request:
1. identify the user
2. check request limits
3. check daily user budget
4. estimate maximum request cost
5. reserve budget
6. call the AI Router
7. record actual cost
8. release unused reservation

**Implementation status:** these per-user limits, per-request cost guard, reservations/reconciliation, global daily/monthly budgets, economy mode, and hard ceiling are not enforced by the current application. The AI response feature only enforces per-request input-size, output-token, and timeout limits. Do not treat the architecture list above as implemented controls; close this gap before any external user rollout.

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

PostgreSQL will be added as a Railway managed service when the database layer is implemented.

## Evolution path

### Current implemented baseline

- One Node.js application.
- PostgreSQL-backed event persistence and jobs.
- OpenRouter through the internal AI Router.
- Text-only generation after the existing debounce.

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
