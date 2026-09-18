# Feature: Viber event persistence and ordered processing

## Goal

Persist the four user-facing Viber callbacks needed by the MVP and process them asynchronously with provider-event deduplication and conversation-local ordering.

The four callbacks in scope are:

- `conversation_started`
- `subscribed`
- `message`
- `unsubscribed`

## User behavior

Webhook delivery must not wait for conversation processing or AI work.

A valid callback is durably accepted, acknowledged quickly, and processed asynchronously. Duplicate provider deliveries do not create duplicate business events or messages.

For a single user conversation, events are processed in provider `timestamp` order. Events that arrive out of order are held briefly by the processing scheduler so that a later-arriving event with an earlier provider timestamp can be considered before processing advances.

Rapid-message debounce is intentionally not implemented by this feature.

## Scope

### In scope

- PostgreSQL persistence for users.
- PostgreSQL persistence for conversations.
- Durable storage of accepted Viber callbacks.
- Deduplication of provider callbacks.
- Conversation-local ordering based on Viber `timestamp`, with a deterministic database tie-breaker.
- Asynchronous processing through the existing PostgreSQL-backed job mechanism.
- Projection of inbound Viber messages into `messages`.
- Subscription state changes from `subscribed` and `unsubscribed`.
- Conversation lifecycle handling for the four events.
- Retry/recovery of processing after worker failure.
- Keeping the webhook transport handler thin.

### Out of scope

- Message debounce/coalescing.
- AI generation.
- Outbound message delivery.
- Conversation summaries.
- Redis, BullMQ, Kafka, or another external queue.
- A dedicated `conversation_turns` table.
- Persistence of Viber avatars or other non-essential profile data.
- Viber callback types other than the four in scope.

## Requirements

- A valid callback must be persisted before the webhook returns success.
- The original validated callback payload must be retained as durable event data.
- Duplicate delivery of the same provider event must be a no-op.
- Events for the same conversation must be selected for processing by `timestamp ASC`, then a deterministic database key.
- Provider `timestamp` is the event ordering signal; webhook receipt time is retained separately for diagnostics.
- Processing of one conversation must be serialized so two workers cannot process its events concurrently.
- Different conversations may be processed concurrently.
- A worker failure must leave enough durable state to retry without losing the event.
- `message` callbacks create inbound user messages only once.
- `subscribed` and `unsubscribed` update the current subscription state.
- `conversation_started` must remain distinct from `subscribed`; it must not implicitly change subscription state.
- A new conversation must be created when the product lifecycle requires one, while `conversation_started` alone must not blindly create duplicates.
- The implementation must not hold a database transaction open while performing external I/O.
- Full user message content, media URLs, and credentials must not be written to ordinary application logs.

## Acceptance criteria

- [ ] A valid `conversation_started` callback is stored and scheduled for asynchronous processing.
- [ ] A valid `subscribed` callback is stored and updates the user's subscription state when processed.
- [ ] A valid `unsubscribed` callback is stored and updates the user's subscription state when processed.
- [ ] A valid `message` callback is stored and produces exactly one inbound message.
- [ ] Re-delivery of an already accepted callback does not create another event or message.
- [ ] Events for one conversation are processed in ascending Viber `timestamp` order.
- [ ] Equal timestamps have deterministic ordering.
- [ ] Processing the same conversation cannot run concurrently in two workers.
- [ ] A failed processing attempt can be retried from durable state.
- [ ] Webhook success does not depend on completing conversation processing.
- [ ] Debounce behavior is not introduced as part of this feature.

## Technical notes

The minimal persistence model uses five tables:

### `users`

- `id`: internal primary key.
- `provider`: initially `viber`; keeps the identity model provider-neutral.
- `provider_user_id`: Viber user ID.
- `created_at`, `updated_at`: lifecycle timestamps.

Unique constraint: `(provider, provider_user_id)`.

### `conversations`

Current state and processing coordination for one conversation.

- `id`: internal primary key.
- `user_id`: owning user.
- `status`: conversation lifecycle state.
- `subscription_status`: current ability to send, independent from conversation lifecycle.
- `locale`: current user locale.
- `last_event_position`: highest durable stream position assigned to the conversation.
- `last_processed_position`: highest position fully processed.
- `processing_state`: worker coordination state.
- `created_at`, `updated_at`: lifecycle timestamps.

The model should not persist debounce state yet; that belongs to the later debounce feature.

### `conversation_events`

Immutable accepted inbound event history.

- `id`: internal primary key and deterministic tie-breaker.
- `conversation_id`: conversation stream.
- `provider`: initially `viber`.
- `event_type`: one of the four supported callback types.
- `provider_event_id`: provider callback identifier used for deduplication.
- `position`: conversation-local accepted position.
- `occurred_at`: Viber callback `timestamp`.
- `received_at`: time Sofi received the callback.
- `payload`: validated original callback payload.
- `created_at`: database record timestamp.

A unique provider-event constraint prevents duplicate acceptance. The implementation must use the Viber `message_token` where it is the callback identifier available for these events.

The provider timestamp determines processing order. The local `position` identifies the event in the durable stream and must not be confused with provider chronological order.

### `messages`

Inbound message projection.

- `id`: internal primary key.
- `conversation_id`: owning conversation.
- `role`: initially `user`.
- `content`: normalized content required by processing.
- `event_id`: source conversation event.
- `position`: corresponding conversation event position.
- `created_at`: persistence timestamp.

A unique constraint on `event_id` prevents duplicate message projection.

### `jobs`

Durable asynchronous processing.

- `id`: job identifier.
- `type`: initially `process_conversation`.
- `conversation_id`: conversation to process.
- `status`: pending, processing, completed, or failed.
- `available_at`: earliest processing time; can later support debounce without schema redesign.
- `locked_at`: worker claim timestamp.
- `attempts`: retry count.
- `last_error`: latest failure diagnostics.
- `created_at`, `completed_at`: lifecycle timestamps.

The webhook persists the event and creates/wakes the conversation job transactionally.

### Processing flow

```
Viber
  |
  v
verify + parse + validate
  |
  v
transaction:
  user upsert
  conversation resolve
  event insert / dedup
  job create-or-wake
  |
  v
HTTP 200
  |
  v
worker
  |
  v
claim conversation
  |
  v
select pending events
  ORDER BY occurred_at ASC, id ASC
  |
  v
apply business projection
  |
  v
advance last_processed_position
```

The scheduler must use a small configurable ordering/reordering delay before processing newly accepted events. This is separate from message debounce: it exists only to reduce incorrect ordering caused by webhook delivery arriving out of order.

If an event arrives after processing has already advanced past its provider timestamp, the system should preserve the late event as durable history and expose the condition operationally rather than silently rewriting already processed conversation state.

## Data and privacy

Persist only data needed for conversation processing and debugging.

- Persist Viber user ID as the stable external identity.
- Do not persist avatars by default.
- Retain the validated callback payload because it is the source record for replay/debugging.
- Do not put complete callback payloads or full user messages into ordinary logs.
- Media should not be permanently downloaded or copied by this feature.
- Retention of raw callback payloads should be revisited before public launch.

## Observability

- Log callback event type, internal event ID, conversation ID, and processing outcome.
- Log duplicate acceptance as a debug/info-level operational event without logging the payload.
- Record processing failures with retry count and safe error information.
- Make late/out-of-order callbacks observable.
- Do not log message text, media URLs, credentials, or raw payloads.

## Testing

- Unit: event deduplication, event ordering, conversation state transitions.
- Integration: transactional event + job persistence, PostgreSQL locking, message projection, retry/recovery.
- E2E / manual: send each of the four callback types through the webhook and verify asynchronous processing.
- Edge cases:
  - duplicate callback
  - equal timestamps
  - callbacks received out of timestamp order
  - late event after processing has advanced
  - two workers targeting the same conversation
  - worker failure after claim
  - message projection retry
  - unsubscribe followed by a message
  - conversation_started for an already subscribed user

## Dependencies

- Existing Viber callback validation.
- Existing PostgreSQL configuration and database layer.
- Existing PostgreSQL-backed job queue decision.

## Open questions

- Exact reordering delay should be selected during implementation/testing based on observed Viber delivery behavior.
- Exact conversation lifecycle transition rules should be confirmed against the existing product behavior before implementation.
- Raw callback retention period should be decided before production launch.

## Implementation checklist

- [ ] Implementation complete
- [ ] Tests added or updated
- [ ] Documentation updated where needed
- [ ] ADR added if a significant architectural decision was made
- [ ] Full local checks pass
- [ ] Focused PR opened
