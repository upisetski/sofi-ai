# Feature: OpenRouter error diagnostics

## Goal

Make AI generation failures actionable during development and production diagnosis without putting user content or credentials in application logs.

## User behavior

No user-visible behavior changes. When OpenRouter returns a malformed successful response, the application records a specific reason rather than only the generic `malformed_response` category.

## Scope

### In scope

- Identify invalid JSON and common Chat Completions response-shape failures.
- Include safe response metadata in structured AI failure logs.
- Preserve the existing sanitized provider message for HTTP errors.
- Add unit tests that prove diagnostics are informative without exposing message content.

### Out of scope

- Logging raw request or response bodies.
- Logging prompts, assistant completions, API keys, or authorization headers.
- Retries, provider fallback, or changing provider/model routing.
- Adding a separate logging or monitoring service.

## Requirements

- Malformed-response failures must include a stable `responseIssue` diagnostic when known.
- Record response content type and byte length when the response body was read.
- Record the provider response ID, returned model, choice count, finish reason, and content type of the message only when those values are present and safe to normalize.
- Never include arbitrary response values or response-body text in these diagnostic fields.
- Preserve the existing route, configured model, duration, outcome, and category log fields.

## Acceptance criteria

- [ ] Invalid JSON is distinguishable from a missing `choices` array, missing message/content, non-string content, and empty content.
- [ ] Structured failure logs include safe response metadata when available.
- [ ] Unit tests verify diagnostic fields and ensure prompts, response content, and credentials are not exposed.
- [ ] Existing AI generation behavior remains unchanged for valid responses.

## Technical notes

Diagnostics remain provider-neutral in the AI Router log type, while the OpenRouter adapter is responsible for extracting and normalizing provider response shape details. No request-level OpenRouter privacy settings or routing behavior change.

## Data and privacy

No new data is persisted. Do not log full request or response content, user messages, assistant completions, secrets, or unvalidated provider fields. Response identifiers and model names are bounded and restricted to safe identifier characters before logging.

## Observability

Malformed-response logs add a stable reason plus bounded response metadata. Existing HTTP status and sanitized provider error message behavior remains unchanged.

## Testing

- Unit: malformed JSON and response-shape fixtures; safe metadata propagation through the AI Router.
- Integration: mocked HTTP only; no live OpenRouter requests.
- Edge cases: invalid JSON, empty choices, missing message/content, non-string content, and empty assistant content.

## Dependencies

- Existing AI Router and OpenRouter client.

## Open questions

- None.

## Implementation checklist

- [x] Implementation complete
- [x] Tests added or updated
- [x] Documentation updated where needed
- [ ] ADR added if a significant architectural decision was made
- [ ] Full local checks pass
- [x] Focused PR opened
