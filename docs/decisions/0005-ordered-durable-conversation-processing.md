# ADR 0005: Ordered, durable conversation processing

## Status

Accepted

## Context

Sofi receives user messages and lifecycle events from Viber through a webhook. The webhook must remain fast and reliable, while the actual conversation processing may be asynchronous and can involve AI requests that take several seconds.

The system needs to preserve the order in which events are accepted by Sofi, tolerate duplicate provider deliveries, recover from worker failures, maintain current conversation state, respect subscription state, and allow users to send several short messages before Sofi responds.

The MVP already uses PostgreSQL as its persistent store and as the durable job queue. Introducing Redis, BullMQ, or another messaging system only for conversation ordering would add infrastructure without a current product requirement.

## Decision

Sofi will treat incoming Viber callbacks as a durable, ordered conversation event stream backed by PostgreSQL.

### 1. Persist before acknowledging

The webhook performs only transport-level work:

1. verify the Viber signature
2. parse and validate the callback
3. persist the inbound event transactionally
4. schedule or wake conversation processing
5. return the successful HTTP acknowledgement

AI processing and other long-running work must not happen inside the webhook request.

An inbound event is considered accepted only after it is durably persisted. This allows the webhook to acknowledge the provider while the actual processing continues asynchronously.

### 2. Deduplicate provider deliveries

Inbound events are stored with the provider's callback/message token when one is available.

A database uniqueness constraint prevents the same provider event from being inserted more than once. Duplicate deliveries are treated as successful no-ops and still receive the normal webhook acknowledgement.

The application therefore uses at-least-once delivery semantics with database-backed deduplication rather than relying on exactly-once delivery from the provider.

### 3. Assign a conversation-local position

Each conversation maintains its last accepted event position.

When an inbound event is inserted, the application obtains a row lock on the conversation, assigns the next position, stores the event, and advances the conversation projection in the same transaction.

For example:

- event A -> position 18
- event B -> position 19
- event C -> position 20

This position represents the order in which Sofi accepted the events. It is not treated as a provider-generated sequence number.

### 4. Process one conversation sequentially

At most one conversation processor may actively process a conversation at a time.

Workers use PostgreSQL locking/state to serialize processing for the same conversation while allowing unrelated conversations to be processed concurrently.

Processing follows the conversation's accepted event positions and never relies on concurrent AI requests for the same conversation.

### 5. Coalesce rapid messages into turns

User messages are not necessarily processed one-by-one.

A configurable debounce period is applied after a new user message. Additional messages received during the debounce window extend the window and are grouped into the same conversation turn.

A maximum turn delay prevents an active user from being deferred indefinitely.

For the MVP, a turn does **not** need its own database table. It can be represented by the range of unprocessed conversation positions that is selected when a processing job runs.

Example:

- message A arrives
- message B arrives shortly afterwards
- message C arrives shortly afterwards
- quiet period expires
- A+B+C are selected and processed as one logical turn

This reduces unnecessary AI requests and better matches natural chat behavior without introducing another persistence model prematurely.

### 6. Keep durable history separate from current state

Durable inbound events and messages are the historical source of truth.

The conversation record is a current-state projection containing only the state needed for processing and fast decisions, such as:

- subscription status
- locale
- last accepted position
- last processed position
- debounce state
- processing state
- conversation summary, if needed by the AI context

The AI context is constructed from the current conversation summary, a bounded set of recent messages, and the current turn. Unbounded conversation history is not sent to the model.

### 7. Subscription state participates in processing

Subscription and unsubscription events are part of the ordered conversation stream.

Before creating an outbound response, the processor checks the current subscription state. A response that becomes invalid because the user unsubscribed must be suppressed rather than sent blindly.

The implementation must preserve the distinction between a conversation-start event and an actual subscription state change.

### 8. Use PostgreSQL jobs for recovery

Conversation processing is driven by the existing PostgreSQL-backed job queue.

A job such as `process_conversation` can be retried after a worker failure. The processor determines work from durable conversation state and unprocessed events rather than relying on in-memory queues.

The transaction boundary must never remain open while waiting for an AI provider or Viber API call.

### 9. Accept at-least-once outbound semantics

Sofi cannot guarantee exactly-once delivery to Viber across a process crash between an external send and the corresponding database commit.

Outbound processing therefore remains at-least-once/best-effort. Rare duplicate outbound messages after a crash are an accepted limitation of the MVP architecture.

The system must make outbound state and retries observable so that this behavior can be revisited if it becomes a material product problem.

## MVP data model

The first implementation intentionally uses only five tables:

### `users`

Stores the provider identity of a person independently from conversations.

- `id` — internal identifier; keeps provider identifiers out of internal primary-key relationships.
- `provider` — provider name, initially `viber`; allows future integrations without changing the user identity model.
- `provider_user_id` — external provider user ID used to associate callbacks and send messages.
- `created_at`, `updated_at` — lifecycle timestamps.

A unique constraint on `(provider, provider_user_id)` prevents duplicate users for the same provider identity.

### `conversations`

Stores the current processing state for a conversation.

- `id` — internal conversation identifier.
- `user_id` — reference to the owning user.
- `status` — conversation lifecycle state, kept separate from subscription state.
- `subscription_status` — current ability to send, for example `unknown`, `subscribed`, or `unsubscribed`.
- `locale` — current locale used for localized responses and AI context.
- `last_event_position` — highest position accepted into the conversation stream.
- `last_processed_position` — highest position fully processed; the difference exposes pending work.
- `debounce_until` — earliest time a pending message batch should be processed.
- `processing_state` — small coordination/observability state such as `idle` or `processing`.
- `summary` — optional compact conversation context; recent messages remain the source for detailed history.
- `created_at`, `updated_at` — lifecycle timestamps.

### `conversation_events`

Stores every accepted inbound callback as durable history and provides the ordered stream.

- `id` — internal event identifier.
- `conversation_id` — conversation to which the event belongs.
- `provider` — source provider, initially `viber`.
- `event_type` — callback type such as `conversation_started`, `subscribed`, `unsubscribed`, or `message`.
- `provider_event_id` — provider identifier used for deduplication when available; for Viber messages this can be the message token.
- `position` — Sofi-assigned conversation-local order.
- `occurred_at` — provider event time, useful for diagnostics but not used for ordering.
- `received_at` — time Sofi received the callback.
- `payload` — validated original callback payload for replay/debugging and future migrations.
- `created_at` — database record timestamp.

Uniqueness on the provider event identifier prevents duplicate inbound processing.

### `messages`

Stores the conversation content needed by processing and AI context construction.

- `id` — internal message identifier.
- `conversation_id` — owning conversation.
- `role` — initially `user` or `assistant`; can be extended later if needed.
- `content` — message text/content used for conversation context.
- `event_id` — reference to the inbound event that produced the message, when applicable.
- `position` — conversation position for efficient ordered message retrieval.
- `created_at` — message timestamp.

For the initial implementation, this is a simple content projection rather than a separate event-sourcing mechanism.

### `jobs`

Provides durable asynchronous processing using the existing PostgreSQL job-queue decision.

- `id` — job identifier.
- `type` — initially `process_conversation`.
- `conversation_id` — conversation the job wakes/processes.
- `status` — pending, processing, completed, or failed.
- `available_at` — when the job becomes eligible; this also supports debounce delays.
- `locked_at` — worker claim timestamp for recovery of stale jobs.
- `attempts` — retry count.
- `last_error` — most recent failure information for diagnostics.
- `created_at`, `completed_at` — job lifecycle timestamps.

The first implementation does **not** add `conversation_turns` or a dedicated outbound-delivery event table. Those can be introduced when a concrete requirement justifies them.

## Consequences

### Positive

- Webhook latency is independent of AI latency.
- Provider retries do not create duplicate inbound work.
- Conversation processing remains ordered and recoverable.
- Several rapid user messages can be handled as one AI turn.
- Current conversation state is explicit and queryable.
- One PostgreSQL system provides persistence, deduplication, ordering, and jobs.
- The MVP data model stays small and can evolve when actual requirements appear.
- The worker can later be moved to a separate process or service without changing the conversation model.

### Negative

- PostgreSQL locking and transactions become part of the concurrency model.
- The system must distinguish historical events from current conversation state.
- Exactly-once outbound delivery is not guaranteed.
- Debounce introduces intentional response latency.
- A stale or late provider event can be accepted after a newer event because provider ordering is not our sequence source.

## Rejected alternatives

### Process callbacks directly in the webhook

Rejected because AI work can be slow and provider retries could otherwise create duplicate processing or timeouts.

### Redis + BullMQ for the MVP

Rejected because PostgreSQL is already the durable store and job queue, and current scale does not justify another stateful infrastructure component.

### Fire one AI job per message

Rejected because natural chat messages often arrive as several short messages that should be interpreted together.

### Rely on provider timestamps for ordering

Rejected because timestamps do not provide a database-enforced, conversation-local ordering guarantee.

### Hold a database transaction open during AI processing

Rejected because long-running external calls would hold locks and reduce database availability and concurrency.

## Implementation notes

Implementation should be split into small feature PRs rather than one large persistence/processing change. The first code iteration should cover only:

1. `users` and `conversations` persistence
2. `conversation_events` persistence and deduplication
3. conversation-local positions
4. `messages` projection for inbound user messages
5. `jobs` integration for waking conversation processing

The next iteration can add the actual sequential processor and debounce behavior on top of these primitives. AI generation and outbound delivery should build on this foundation rather than coupling transport handling directly to provider calls.

Do not introduce `conversation_turns`, Redis, BullMQ, or additional delivery infrastructure until a concrete requirement requires them.
