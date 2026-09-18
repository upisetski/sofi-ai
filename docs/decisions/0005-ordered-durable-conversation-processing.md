# ADR 0005: Ordered, durable conversation processing

## Status

Accepted

## Context

Sofi receives user messages and lifecycle events from Viber through a webhook. The webhook must remain fast and reliable, while actual conversation processing may be asynchronous and can involve AI requests that take several seconds.

The system needs to preserve conversation order, tolerate duplicate provider deliveries, recover from worker failures, maintain current conversation state, and keep provider transport concerns separate from application behavior.

The MVP already uses PostgreSQL as its persistent store and durable job queue. Introducing Redis, BullMQ, or another messaging system only for conversation ordering would add infrastructure without a current product requirement.

## Decision

Sofi will treat incoming Viber callbacks as a durable conversation event stream backed by PostgreSQL.

### 1. Persist before acknowledging

The webhook performs only transport-level work:

1. verify the Viber signature
2. parse and validate the callback
3. persist the inbound event transactionally
4. schedule or wake conversation processing
5. return the successful HTTP acknowledgement

AI processing and other long-running work must not happen inside the webhook request.

An inbound event is considered accepted only after it is durably persisted.

### 2. Deduplicate provider deliveries

Inbound events are stored with the provider's callback identifier when one is available.

A database uniqueness constraint prevents the same provider event from being inserted more than once. Duplicate deliveries are treated as successful no-ops and still receive the normal webhook acknowledgement.

The application therefore uses at-least-once inbound delivery semantics with database-backed deduplication.

### 3. Separate acceptance order from processing order

Every accepted event receives a conversation-local position. The position identifies the durable stream record and provides a deterministic database identity for processing state; it is not treated as the provider's chronological order.

Processing order is determined by:

1. Viber `timestamp` ascending
2. event ID ascending as a deterministic tie-breaker

Webhook receipt time is stored separately for diagnostics and operational analysis.

Because callbacks can arrive out of order, newly accepted events are given a small configurable reordering delay before processing. This delay is intentionally separate from message debounce: it exists only to reduce incorrect ordering caused by callback delivery order.

If an event arrives after processing has already advanced past its provider timestamp, the event remains durable and the late-order condition is observable. The system does not silently rewrite already processed state.

### 4. Process one conversation sequentially

At most one conversation processor may actively process a conversation at a time.

Workers use PostgreSQL locking/state to serialize processing for the same conversation while allowing unrelated conversations to process concurrently.

The processor never performs concurrent AI requests for the same conversation.

### 5. Keep durable history separate from current state

Durable inbound events and messages are historical records.

The conversation record is a current-state projection containing only state needed for processing and fast decisions, such as:

- subscription status
- locale
- last accepted position
- last processed position
- processing state
- conversation summary, if later required

The AI context is constructed from bounded recent messages and the current processing unit. Unbounded conversation history is not sent to the model.

### 6. Subscription state participates in processing

Subscription and unsubscription events are part of the ordered conversation stream.

Before creating an outbound response, the processor checks the current subscription state. A response that becomes invalid because the user unsubscribed must be suppressed rather than sent blindly.

The implementation must preserve the distinction between a conversation-start event and an actual subscription state change.

### 7. Use PostgreSQL jobs for recovery

Conversation processing is driven by the existing PostgreSQL-backed job queue.

A `process_conversation` job can be retried after a worker failure. The processor determines work from durable conversation state and unprocessed events rather than relying on an in-memory queue.

The transaction boundary must never remain open while waiting for an AI provider or Viber API call.

### 8. Accept at-least-once outbound semantics

Sofi cannot guarantee exactly-once delivery to Viber across a process crash between an external send and the corresponding database commit.

Outbound processing therefore remains at-least-once/best-effort. Outbound state and retries must be observable.

## MVP data model

The first implementation intentionally uses only five tables.

### `users`

Stores the provider identity of a person independently from conversations.

- `id` — internal identifier.
- `provider` — provider name, initially `viber`.
- `provider_user_id` — external provider user ID.
- `created_at`, `updated_at` — lifecycle timestamps.

Unique constraint: `(provider, provider_user_id)`.

### `conversations`

Stores current conversation and processing state.

- `id` — internal conversation identifier.
- `user_id` — owning user.
- `status` — conversation lifecycle state.
- `subscription_status` — current ability to send, independently from lifecycle.
- `locale` — current locale.
- `last_event_position` — highest durable stream position accepted.
- `last_processed_position` — highest position fully processed.
- `processing_state` — worker coordination state.
- `summary` — optional compact context, if needed later.
- `created_at`, `updated_at` — lifecycle timestamps.

### `conversation_events`

Stores every accepted inbound callback.

- `id` — internal event identifier and deterministic tie-breaker.
- `conversation_id` — conversation stream.
- `provider` — initially `viber`.
- `event_type` — supported callback type.
- `provider_event_id` — provider identifier used for deduplication.
- `position` — conversation-local accepted position.
- `occurred_at` — Viber callback `timestamp`.
- `received_at` — time Sofi received the callback.
- `payload` — validated original callback payload.
- `created_at` — database record timestamp.

A unique provider-event constraint prevents duplicate inbound processing.

### `messages`

Stores the conversation content needed by processing and AI context construction.

- `id` — internal message identifier.
- `conversation_id` — owning conversation.
- `role` — initially `user`.
- `content` — normalized content required by processing.
- `event_id` — source event.
- `position` — corresponding conversation event position.
- `created_at` — persistence timestamp.

A unique constraint on `event_id` prevents duplicate message projection.

### `jobs`

Provides durable asynchronous processing.

- `id` — job identifier.
- `type` — initially `process_conversation`.
- `conversation_id` — conversation to process.
- `status` — pending, processing, completed, or failed.
- `available_at` — earliest processing time.
- `locked_at` — worker claim timestamp.
- `attempts` — retry count.
- `last_error` — latest failure diagnostics.
- `created_at`, `completed_at` — lifecycle timestamps.

The webhook persists the event and creates or wakes the conversation job transactionally.

## Consequences

### Positive

- Webhook latency is independent of AI latency.
- Provider retries do not create duplicate inbound work.
- Conversation processing is sequential and recoverable.
- Chronological provider timestamps are respected where the event has not already been processed.
- One PostgreSQL system provides persistence, deduplication, ordering metadata, and jobs.
- The data model stays small.
- Debounce can be added later without coupling it to webhook ingestion.

### Negative

- PostgreSQL locking and transactions become part of the concurrency model.
- Out-of-order delivery requires a small reordering delay.
- Very late events cannot safely rewrite already processed state automatically.
- Exactly-once outbound delivery is not guaranteed.
- Debounce remains a separate source of intentional response latency when implemented.

## Rejected alternatives

### Process callbacks directly in the webhook

Rejected because AI work can be slow and provider retries could otherwise create duplicate processing or timeouts.

### Redis + BullMQ for the MVP

Rejected because PostgreSQL is already the durable store and job queue, and current scale does not justify another stateful infrastructure component.

### Use receipt time as event order

Rejected because network delivery order is not the same as the provider event timestamp order.

### Treat the local event position as chronological order

Rejected because the position reflects durable acceptance order. Provider `timestamp` is the chronological ordering signal.

### Hold a database transaction open during AI processing

Rejected because long-running external calls would hold locks and reduce database availability and concurrency.

### Add a conversation-turn table now

Rejected because debounce/coalescing is a separate feature and does not yet require its own persistence model.

## Implementation notes

Implementation should be split into small feature PRs.

The first code iteration covers:

1. `users` and `conversations` persistence
2. `conversation_events` persistence and deduplication
3. conversation-local positions
4. `messages` projection for inbound user messages
5. `jobs` integration for waking conversation processing
6. ordered event selection and per-conversation serialization

A later feature will add message debounce/coalescing on top of these primitives.

Do not introduce `conversation_turns`, Redis, BullMQ, or additional delivery infrastructure until a concrete requirement requires them.
