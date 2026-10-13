# Feature: Configurable message debounce and reset-command bypass

## Goal

Reduce the wait before Sofi responds to a completed text burst while keeping the quiet period configurable and allowing context reset commands to run without waiting for that period.

## User behavior

- Ordinary text messages are grouped until the conversation has been quiet for five seconds by default.
- Operators can change the quiet period through `MESSAGE_DEBOUNCE_MS`.
- Exact `/reset` and `/forget` commands bypass the debounce wait. They still respect `REORDER_DELAY_MS` so inbound events retain the existing reordering protection.

## Scope

### In scope

- Set the default message debounce to 5,000 milliseconds.
- Keep the debounce duration configurable through the existing environment variable.
- Recognize reset commands using the same case-insensitive, whitespace-trimmed matcher for scheduling and command processing.
- Bring an existing pending conversation job's deadline forward when a reset command arrives.

### Out of scope

- Changing reset/forget command semantics or localized confirmations.
- Removing the event reordering delay.
- Introducing a new queue or persistence mechanism.
- Changing non-command text grouping or AI response behavior.

## Requirements

- Preserve the existing debounce behavior for ordinary text: each accepted text message extends the quiet period.
- Treat `/reset` and `/forget` as reset commands regardless of surrounding whitespace or letter case.
- Do not apply the debounce delay to reset commands.
- Ensure a reset command can move an already-scheduled job earlier instead of leaving it blocked by a pending text debounce.
- Preserve `REORDER_DELAY_MS`, webhook deduplication, durable event persistence, and conversation ordering.

## Acceptance criteria

- [x] The default `MESSAGE_DEBOUNCE_MS` is 5000 milliseconds.
- [x] Operators can override `MESSAGE_DEBOUNCE_MS` through environment configuration.
- [x] Both reset commands bypass debounce while retaining the reordering delay.
- [x] An arriving reset command moves a pending job deadline forward.
- [x] Tests cover command recognition, configured defaults/overrides, and job scheduling behavior.

## Technical notes

The PostgreSQL `jobs.available_at` timestamp remains the debounce timer. Ordinary messages retain the existing `GREATEST` scheduling behavior; reset commands use the earlier of the current and newly calculated eligibility times. No schema migration is needed.

## Data and privacy

No new user data is persisted. Existing event payloads and reset processing remain unchanged. Tests use synthetic messages. Logs must not include message text.

## Observability

No new logging or metrics are needed. Existing webhook/job processing observability remains unchanged.

## Testing

- Unit: command recognition, including case and surrounding whitespace.
- Integration: a reset command advances a pending job's debounce deadline.
- Configuration: verify the 5-second default and environment override.
- Edge cases: duplicate webhook events still deduplicate; regular text still extends the deadline; reset command retains the reorder delay.

## Dependencies

- Existing PostgreSQL-backed conversation job queue and context reset command handling.

## Open questions

- None.

## Implementation checklist

- [x] Implementation complete
- [x] Tests added or updated
- [x] Documentation updated where needed
- [ ] ADR added if a significant architectural decision was made
- [ ] Full local checks pass
- [x] Focused PR opened
