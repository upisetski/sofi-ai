# Feature: Text message debounce and echo

## Goal

Make rapid text messages feel like one conversational turn instead of triggering a response for every message.

## User behavior

When a user starts a burst of text messages:

1. Sofi immediately sends one localized thinking acknowledgement for the first message.
2. Each subsequent text message resets the response timer.
3. While the timer is running, Sofi does not send another acknowledgement.
4. When 10 seconds have passed without another text message, Sofi sends one localized echo containing the text messages from the burst.

Viber does not expose a typing-indicator operation in the current Bot REST API, so no typing signal is sent during the waiting period. The supported outbound operation remains `send_message`. citeturn357672view0turn357672view1

## Scope

### In scope

- 10-second configurable text-message debounce.
- One localized thinking acknowledgement at the start of a burst.
- Resetting the debounce deadline for each accepted text message.
- One localized echo after the quiet period.
- Keeping rapid messages as separate durable events and messages.
- Collecting text messages from the completed burst for the echo response.

### Out of scope

- AI generation.
- Typing indicators.
- Combining or rewriting user messages before the AI layer exists.
- Redis/BullMQ or another queue.
- A dedicated debounce table.

## Requirements

- The default text debounce must be 10,000 ms.
- An accepted text message must move the conversation job deadline to at least its received time plus the debounce period.
- A text message arriving during an existing burst must not trigger another thinking acknowledgement.
- A new text burst after the previous burst has completed must trigger a new thinking acknowledgement.
- The final echo must be sent only after the conversation job reaches a completed state for the burst.
- The echo must contain the text messages from that burst in timestamp processing order.
- The echo must use the conversation locale and the existing Viber text-message client.
- Full message content must not be logged.

## Acceptance criteria

- [ ] The first text message receives one localized thinking acknowledgement.
- [ ] A second text message in the same burst receives no additional thinking acknowledgement.
- [ ] The job deadline is extended by each subsequent text message.
- [ ] No echo is sent before the 10-second quiet period after the latest message.
- [ ] One echo is sent after the quiet period.
- [ ] The echo contains all text messages from the burst in processing order.
- [ ] A later burst starts a new thinking acknowledgement window.
- [ ] The implementation does not require a new database table.
- [ ] Viber typing-indicator behavior is not assumed or emulated.

## Technical notes

The existing PostgreSQL job row is the debounce state:

- `jobs.available_at` is extended with `GREATEST(current, latest_message_received_at + debounce)`.
- The worker only claims jobs whose `available_at` has passed.
- Processing remains serialized per conversation.
- The worker emits the echo after the job is complete.

The default can still be overridden with `MESSAGE_DEBOUNCE_MS` for development/testing.

## Data and privacy

No new persistent data model is introduced.

The existing raw Viber callback and normalized message records remain the source of truth. User message content is passed to the response handler but is not added to ordinary logs.

## Observability

- Keep existing callback and job-processing logs.
- Echo delivery failures are logged as safe operational errors without message content.

## Testing

- Integration: deadline extension for rapid messages.
- Integration: no response before the latest debounce deadline.
- Integration: one echo containing the whole text burst.
- Existing webhook test: exactly one thinking acknowledgement for rapid messages.
- Localization tests: echo text for supported locales and Unicode truncation.

## Dependencies

- Existing PostgreSQL-backed conversation jobs.
- Existing Viber `send_message` integration.
- Existing localization.

## Open questions

- Replace the echo with AI generation when the AI response pipeline is implemented.

## Implementation checklist

- [x] Implementation complete
- [x] Tests added or updated
- [x] Documentation updated where needed
- [x] ADR added if a significant architectural decision was made
- [ ] Full local checks pass
- [ ] Focused PR opened
