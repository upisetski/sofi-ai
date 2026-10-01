# Feature: Viber message debounce

## Goal

Collect rapid user messages into one processing batch so Sofi does not start conversation processing after every individual message.

For now, the user-facing response for the first text message in a debounce burst is a localized acknowledgement that repeats that message. The echoed text is limited to 1000 Unicode characters.

## User behavior

When a user sends several text messages close together:

1. Sofi accepts each callback durably.
2. Sofi sends one localized acknowledgement for the first message, including up to 1000 characters of that message.
3. Each new message postpones conversation processing until the debounce interval has elapsed since the latest message.
4. The messages remain separate inbound messages in PostgreSQL; debounce changes processing timing, not the durable event history.
5. A later message after the previous burst has finished starts a new acknowledgement/burst.

The acknowledgement is intentionally simple and temporary product behavior. AI generation is out of scope for this feature.

## Scope

### In scope

- Configurable text-message debounce interval.
- Reusing the existing PostgreSQL-backed conversation job.
- Extending the job availability time when another message arrives.
- Sending at most one localized acknowledgement for an unprocessed burst.
- Echoing the triggering text message with a 1000-character limit.
- Russian, Belarusian, and English acknowledgement copy.
- Safe worker recovery when a message arrives while a conversation job is processing.
- Tests for burst grouping and localized acknowledgement behavior.

### Out of scope

- AI generation.
- Streaming or typing indicators.
- Editing or deleting the acknowledgement message.
- Combining multiple inbound messages into one database row.
- Redis, BullMQ, or a dedicated debounce service.
- Debouncing non-message lifecycle events.

## Requirements

- A text `message` callback must remain durably persisted before webhook success.
- Picture, video, file, and other non-text message callbacks must not receive the text debounce acknowledgement.
- The first unprocessed text message in a burst must request one acknowledgement containing that message, truncated to at most 1000 Unicode characters.
- Additional text messages with an earlier unprocessed message must not request another acknowledgement.
- A duplicate callback must not request another acknowledgement.
- Each accepted text message must move the conversation processing deadline to at least the configured debounce interval after its receipt time.
- The effective message delay must not be shorter than the configured event reordering delay.
- A message arriving while a conversation job is processing must leave the job runnable again after the current processing finishes.
- Message text must not be logged by the debounce implementation.
- The acknowledgement must preserve the configured locale.
- No new persistent table is required.

## Acceptance criteria

- [ ] The first text message in a burst requests one localized acknowledgement containing that message.
- [ ] A second message accepted before the burst is processed does not request a second acknowledgement.
- [ ] A duplicate callback does not request an acknowledgement.
- [ ] The job `available_at` is extended after each accepted message in the burst.
- [ ] The debounce delay is configurable through environment configuration.
- [ ] The configured reorder delay remains a lower bound for message processing delay.
- [ ] A later message after the previous burst has completed requests a new acknowledgement.
- [ ] Russian, Belarusian, and English acknowledgement text is localized naturally.
- [ ] The echoed message is capped at 1000 Unicode characters.
- [ ] Non-text messages do not use text debounce acknowledgement behavior.
- [ ] Existing event ordering, deduplication, and message projection behavior remains intact.
- [ ] Full CI checks pass.

## Technical notes

The existing `jobs.available_at` field is the debounce scheduler. No `conversation_turns` or debounce-specific table is introduced.

For an accepted text message:

    available_at = received_at + max(REORDER_DELAY_MS, MESSAGE_DEBOUNCE_MS)

The job upsert uses the greatest of its current deadline and the new deadline, so each message in a burst pushes processing further out.

Acknowledgement eligibility is based on durable conversation state, not only on job status. A pending non-message lifecycle event must not suppress the first user-message acknowledgement.

If a message arrives while a worker holds the conversation job, the job deadline is updated. Job completion checks the updated deadline and/or remaining events so the new message cannot leave the conversation without a runnable job.

## Data and privacy

No new personal data is stored.

- Existing Viber callback payload persistence remains unchanged.
- Existing inbound message persistence remains unchanged.
- No user message content is added to logs.
- The localized acknowledgement uses only the user's stored/received locale and the triggering message text.
- The triggering message text is echoed only to the user through the Viber response and is not added to ordinary logs.

## Observability

Operational logging remains at the webhook/job level:

- callback event type
- event ID
- conversation ID
- duplicate flag
- processing outcome

Do not log message text or raw callback payloads.

## Testing

- Unit/application: acknowledgement eligibility, localization, and 1000-character truncation.
- Integration: debounce deadline extension in PostgreSQL.
- Webhook: one acknowledgement for a rapid-message burst.
- Regression: event ordering, deduplication, and message projection.
- Edge cases:
  - first message after a pending non-message event
  - duplicate message callback
  - multiple rapid messages
  - message arriving while the job is processing
  - a new message after a completed burst
  - equal provider timestamps

## Dependencies

- Existing Viber callback validation.
- Existing PostgreSQL event persistence.
- Existing PostgreSQL-backed conversation job.

## Open questions

- The default debounce interval should be tuned using real user message behavior after launch.

## Implementation checklist

- [ ] Implementation complete
- [ ] Tests added or updated
- [ ] Documentation updated where needed
- [ ] ADR added if a significant architectural decision was made
- [ ] Full local checks pass
- [ ] Focused PR opened