# ADR 0008: Durable chat turns and Viber delivery recovery

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

The existing worker could mark a conversation job complete before generating and sending its response. That made a generated reply vulnerable to process and outbound network failures. Multi-turn context also required assistant messages to be durably ordered with inbound messages.

The MVP already uses PostgreSQL for inbound event persistence and job scheduling. Viber `send_message` returns a `message_token` for an accepted send and later provides `delivered`, `seen`, and `failed` callbacks. The Bot API does not document a client-supplied idempotency key for outbound sends. A callback can arrive before the sending process commits the returned token, and a lost HTTP response may leave the send outcome ambiguous. These API contracts were checked against Viber's [Bot API getting-started guide](https://developers.viber.com/docs/general/getting-started-with-bots/) and [REST API reference](https://developers.viber.com/rest/).

## Decision

- Keep the existing PostgreSQL job queue and debounce scheduling. Do not add another queue or service.
- Create a durable `conversation_turns` row in the same transaction that projects inbound messages and advances the conversation cursor.
- Store assistant reply content once in `messages`; a turn row references the assistant message and owns its generation, delivery, retry, and callback state.
- Serialize a conversation's worker lifecycle with a PostgreSQL session advisory lock. Keep turn transitions conditional and transactional so stale/recovered workers cannot commit a second assistant message for the same turn.
- Commit the assistant message and pending-delivery state before calling Viber. Recovered delivery uses the stored message without another AI generation.
- Bound generation to three attempts and delivery to five attempts with increasing delays. Store terminal and retryable failure categories without raw provider descriptions or exception text.
- Persist delivery callbacks keyed by Viber message token so a callback received before the send response is committed can be applied when that token is known.
- Treat Viber's `failed` callback as terminal/uncertain rather than auto-resending, since it is not proof that the user did not receive the message.
- When a send's result is ambiguous because of a process/network interruption, retry the same stored reply within the bound. This is at-least-once behavior and can still produce a duplicate; exactly-once delivery cannot be promised without provider idempotency support.
- Retain message content for up to 30 days and delivery/event deduplication metadata for up to 90 days, except unfinished turns retain the minimum content needed for recovery. A user-issued `/reset` (`/forget`) increments a conversation context version and removes old context content without cancelling an already-generated reply that remains pending delivery.

## Consequences

- The MVP can continue using one PostgreSQL-backed worker process and survive recoverable restart/delivery failures.
- Assistant reply text is stored only in the message projection; turn rows store lifecycle metadata and a foreign key rather than duplicating completion content.
- Viber delivery status distinguishes provider acceptance from delivery confirmation.
- Ambiguous delivery outcomes remain an unavoidable bounded duplicate risk and must be visible in operational state/logs.
- Usage accounting, budget reservation, and spend limits remain separate WP2 work; this schema leaves turn identifiers and outcome states available for that integration.
