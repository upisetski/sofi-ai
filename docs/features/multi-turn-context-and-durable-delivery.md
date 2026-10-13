# Feature: Multi-turn context and durable reply delivery

## Goal

Let users refer to earlier answers across separate text-message bursts without leaking context between users, and ensure a generated response is durably recoverable through the outbound Viber lifecycle.

## User behavior

- Text messages are grouped by a configurable quiet period (5 seconds by default); `/reset` and `/forget` bypass the debounce delay.
- Sofi uses a bounded recent conversation history when generating each reply.
- Sending `/reset` (also accepted: `/forget`) clears the conversation context and receives a localized confirmation. Messages after the reset command start a fresh context.
- A temporary generation problem produces a localized temporary-error reply after bounded generation retries. A delivery problem does not regenerate a reply that has already been persisted.

## Scope

### In scope

- Persist user and assistant messages, context version, turn generation state, and Viber delivery state in PostgreSQL.
- Stable ordered history across debounce bursts, strict conversation/user isolation, bounded prompt input, and reset behavior.
- Transactional event-to-turn projection, single-conversation worker serialization, bounded retry/backoff, restart recovery, outbound callback correlation, sanitized operational events, and content retention.
- Preserve inbound event deduplication and the current text debounce window.

### Out of scope

- Long-term personal memory, summaries, embeddings, vector search, web search, usage accounting, budget reservations, and the WP2 cost-control package.
- Exactly-once outbound delivery: Viber does not document an idempotency key for `send_message`.
- New infrastructure or a separate worker service.

## Requirements

1. Each processed text burst that contains ordinary text creates one durable chat turn, with user messages and the turn record committed in the same transaction as advancing the conversation cursor.
2. User and assistant messages have stable ordering and belong to a specific conversation and context version. A prompt includes only prior user messages and assistant replies whose outbound send was accepted or confirmed delivered, then the current burst.
3. The AI Router receives no more than 12 recent history messages and no more than the existing 12,000 aggregate characters of user/history content (the current burst takes priority). Existing output-token and timeout constraints remain unchanged.
4. A reset command increments the context version, removes old message content from the prompt/history, redacts previously processed inbound message payloads, cancels not-yet-generated prior-context turns, and does not discard an already generated reply that still needs delivery. Old-context replies delivered later must not re-enter the new context.
5. A reply's assistant message and turn delivery state are persisted transactionally before calling Viber. The assistant text is stored once; turn rows reference the message.
6. Turn generation and delivery are separate state transitions. Generation retries are bounded to three attempts; delivery retries are bounded to five attempts with backoff. Retryable and terminal failures are recorded with content-free categories.
7. A recovered worker reuses a persisted assistant message rather than regenerating it. A turn still marked generating after a worker crash is safely returned to a generation-retry state; a send interrupted while in progress is treated as ambiguous and retried only under the bounded at-least-once policy.
8. A session-level PostgreSQL advisory lock serializes the full turn operation for one conversation, including provider calls. The PostgreSQL job lease/recovery logic remains the scheduling mechanism; no external queue is added.
9. Successful `send_message` acceptance is stored with its Viber message token. `delivered`/ `seen` callbacks confirm delivery; a `failed` callback is recorded as terminal/uncertain and is not automatically resent because Viber documents that such a message may still have reached the user. Callback-before-response races are buffered in PostgreSQL.
10. Webhook duplicates remain deduplicated. Delivery callbacks update state idempotently. Logs contain only event names, stage, attempts, safe failure categories, turn/job IDs, and elapsed time—not message contents, prompts, completions, or credentials.
11. Keep message payload content for at most 30 days; then delete message content and redact processed inbound event payloads while retaining event/token metadata for 90 days to preserve a practical deduplication window. Active unfinished turns retain the minimal content required for recovery. Delivery callback metadata is retained for 90 days.

## Acceptance criteria

- [ ] A follow-up in a later debounce burst receives the previous delivered/accepted assistant reply in its AI context.
- [ ] History ordering and count/character bounds are deterministic; an empty history produces the existing single-turn prompt.
- [ ] Context and reset operations are scoped to the resolved conversation, and reset affects all subsequent prompts but never cancels a previously generated reply's delivery.
- [ ] Reset acknowledgements are localized and do not become AI context.
- [ ] A turn and assistant message are durable before an outbound Viber call begins.
- [ ] A transient delivery failure retries the same persisted message without invoking generation again.
- [ ] Pending generation/delivery work survives a process restart and stale job recovery.
- [ ] Duplicate webhook events, delivery callbacks, and job retries do not create unbounded turns, generation, or outbound attempts.
- [ ] PostgreSQL locking prevents two workers from executing the same conversation turn concurrently.
- [ ] Terminal/ambiguous failures are durably recorded and observable without persisting raw exception text.
- [ ] Existing debounce, inbound webhook deduplication, localization, and error handling remain covered by tests.

## Technical notes

- Use the existing PostgreSQL jobs and connection pool. Migration SQL must be forward-only and safe to apply repeatedly during app startup.
- Keep existing `messages.event_id` uniqueness for inbound rows; assistant rows have a nullable `event_id` and a `turn_id`.
- Store assistant content in `messages` only once. A `conversation_turns` row stores generation/delivery state and references its assistant message.
- Keep generation retry classification in the application layer and HTTP/API status interpretation in the Viber adapter.
- The Viber API returns a `message_token` for accepted sends, and delivery callbacks report that token. There is no documented request idempotency key; a crash/network failure after the provider accepts a send but before the response is persisted can cause a duplicate on bounded retry.
- Keep a callback row for an unmatched outbound token so a callback racing the sender's database update is applied after the token is stored.

## Data and privacy

- Persistent content: accepted user text, generated assistant text, and inbound event payloads needed before processing.
- After 30 days, delete expired message text and redact all processed inbound event payloads. Keep provider event identifiers and non-content metadata for 90 days; keep unfinished turn content until its lifecycle is terminal.
- Reset removes prior-context message content and redacts processed inbound payloads for that context. It does not delete webhook event identifiers needed for deduplication or interrupt an already-generated pending reply.
- Never log content, prompts, completions, auth tokens, or raw exceptions that could contain them. Store only safe error categories and numeric status when available.

## Observability

- Structured events for generation success/failure, delivery attempt accepted/retryable/terminal/delivered, callback correlation, context reset, and retention cleanup.
- Include safe identifiers, stage, attempt count, latency, and error category; exclude message content and raw Viber callback descriptions.
- Persist generation/delivery states and the last safe failure category in PostgreSQL so restart recovery and terminal failures are queryable.

## Testing

- Unit: context builder order/limits, reset command recognition, generation retry classification, Viber response/error mapping, callback state mapping.
- Integration (PostgreSQL, where configured): transactional turn creation, cross-burst history, reset/retention isolation, deduplicated webhook events, callback correlation including callback-before-token persistence, advisory-lock serialization, and worker recovery.
- Mocked integration: generated reply persisted before Viber send, same response reused after transient delivery failure, bounded attempts, terminal/ambiguous errors recorded, AI generation not repeated once the response exists.
- E2E / manual: verify Viber webhook is subscribed to `delivered`, `seen`, and `failed` callbacks and test with synthetic messages. Never use real provider credentials in CI.
- Edge cases: empty/incomplete history; previous turn generation failure; reset amid a burst; reset while an earlier reply awaits delivery; a crash during generation/send; out-of-order provider timestamps; duplicate callbacks.

## Dependencies

- PostgreSQL and the existing job worker.
- Existing provider-neutral AI Router and Viber client.
- Viber Bot API delivery callbacks enabled in webhook configuration.

## Open questions

- No exactly-once guarantee is possible for an outbound send whose result is ambiguous; bounded retry can produce a duplicate. The implementation must retain and document this risk.

## Implementation checklist

- [x] Implementation complete
- [x] Tests added or updated
- [x] Documentation updated where needed
- [x] ADR added if a significant architectural decision was made
- [ ] Full local checks pass
- [x] Focused PR opened
