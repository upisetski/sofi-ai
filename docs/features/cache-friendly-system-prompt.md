# Feature: Cache-friendly date-aware system prompt

## Goal

Give Sofi an explicit current date for date-relative questions while keeping the reusable system-prompt prefix stable across locales and dates.

## User behavior

- Sofi receives the current date as an explicit UTC date and can interpret references such as “today” and “yesterday” more reliably.
- Sofi continues to answer in the user's resolved locale.
- Conversation history remains the same bounded list of role/content messages.

## Scope

### In scope

- Keep invariant identity, style, conversation, and web-search instructions at the beginning of the system prompt.
- Append the locale instruction and current UTC date after the stable instructions.
- Cover prompt content and ordering with deterministic tests.

### Out of scope

- Adding timestamps to individual user/assistant messages.
- Inferring a user's timezone or adding timezone configuration.
- Changing OpenRouter provider routing, cache controls, model configuration, or general prompt policy beyond this layout/date addition.

## Requirements

1. The system prompt contains the current date in an explicit `YYYY-MM-DD` UTC format.
2. Dynamic locale and date context follows the invariant instructions, keeping the longest practical shared prompt prefix unchanged.
3. Existing identity, concise style, history-ordering, web-search, citation, and truthful-search instructions remain present.
4. AI message payloads continue using the existing `role` and `content` fields; no per-message timestamp is added.
5. The current date is computed when the prompt is built, not persisted or cached in application state.

## Acceptance criteria

- [ ] The prompt includes a deterministic UTC date string from the current clock.
- [ ] Locale selection remains correct and follows the stable prompt instructions.
- [ ] Existing stable prompt rules remain unchanged and appear before dynamic context.
- [ ] Tests verify the date, locale instruction, and ordering with a fixed clock.
- [ ] No message content or timestamp is added to logs or persistence.
- [ ] Repository checks and CI pass.

## Technical notes

- Viber inbound callback payloads include a provider timestamp in Unix milliseconds and the application uses event time for ordering. The AI chat message contract itself contains only `role` and `content`; this feature does not expose the Viber event timestamp to the model.
- UTC is explicit because the AI Router does not currently receive a reliable user timezone. Cache reuse remains model/provider-dependent; this change preserves a stable textual prefix but does not force caching or guarantee cost savings.

## Data and privacy

- No new persistent data is introduced.
- The date is derived at request time and included in the provider prompt.
- Do not log prompts, messages, or completions.

## Observability

- No new telemetry is needed. Validate cache benefits separately using provider-reported cached-token usage where available.

## Testing

- Unit: prompt date formatting, locale selection, stable prefix ordering.
- Integration: existing AI Router tests ensure the assembled messages are passed to the provider.
- E2E / manual: optionally verify date-relative questions with the deployed model and inspect reported cached-token usage.
- Edge cases: UTC day rollover; Russian, Belarusian, English, and unknown locale fallback.

## Dependencies

- Existing locale resolution and AI Router.

## Open questions

- User-specific timezone support can be considered separately if Sofi later has a trustworthy timezone source.

## Implementation checklist

- [ ] Implementation complete
- [ ] Tests added or updated
- [ ] Documentation updated where needed
- [ ] ADR added if a significant architectural decision was made
- [ ] Full local checks pass
- [ ] Focused PR opened
