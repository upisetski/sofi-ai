# Feature: System prompt quality improvements

## Goal

Make Sofi's answers fit Viber and the product personality, and remove prompt instructions that conflict with application behavior (source rendering, web-search configuration).

## User behavior

- Sofi replies in the language of the user's latest message; the resolved Viber locale is only the fallback.
- Replies are short, plain-text friendly (no Markdown headings or tables), and write/rewrite requests return ready-to-send text without preambles.
- Sofi makes reasonable assumptions instead of asking unnecessary clarifying questions.
- Sofi says it cannot see images, voice messages, videos, or files, and can mention `/reset` and `/forget`.
- Sensitive topics get a neutral, safe default: general information plus a professional referral for medical/legal/financial questions, empathy and crisis guidance for self-harm, and neutrality on political/contested topics.
- Source links are listed only once, by the application's validated citation rendering; the model no longer writes its own URL list.
- When web search is disabled, the prompt does not mention web search and Sofi says it cannot check live data.
- "Today"/"yesterday" are interpreted using the Europe/Minsk calendar date.

## Scope

### In scope

- Rewrite the system prompt in `buildAiMessages` as short newline-separated sections.
- Pass the web-search setting from configuration to the AI Router and select the matching prompt section.
- Replace the UTC date with the Europe/Minsk date.
- Keep all invariant instructions before the dynamic locale/date context.

### Out of scope

- Per-user time zones.
- Model, provider, routing, or citation-rendering changes.
- Live evaluation of answer quality (manual review after deploy).

## Requirements

1. The stable prompt prefix is identical across locales and dates for a given web-search setting.
2. The dynamic context contains the default language and the current Europe/Minsk date in `YYYY-MM-DD` format.
3. The prompt never asks the model to write URLs or source lists.
4. With web search disabled, no web-search usage instructions are sent.
5. Identity (Sofi / Софи / Софі), history-ordering, and truthful-search rules remain.

## Acceptance criteria

- [x] Prompt contains language-mirroring, length, Viber formatting, persona, capability, and sensitive-topic rules.
- [x] Prompt asks the model not to write URLs; application-rendered sources remain the single source list.
- [x] `AI_WEB_SEARCH_ENABLED=false` removes web-search instructions from the prompt.
- [x] Date uses Europe/Minsk and rolls over at 21:00 UTC.
- [x] Stable prefix is identical across locales and dates.
- [x] Repository checks and CI pass.

## Technical notes

- The usage guard estimates prompt tokens conservatively (8 tokens per UTF-16 code unit), so the longer prompt raises the per-request reservation by roughly $0.002 at the default $0.10/M input price. Reconciliation still uses provider-reported cost.
- The prompt stays cache-friendly: the variable part is only the final `# Context` section.
- The default reply budget (`AI_MAX_OUTPUT_TOKENS=512`) motivated the explicit ~250-word upper bound.

## Data and privacy

- No new persistent data. Prompts, messages, and completions are still not logged.

## Observability

- No new telemetry. Track follow-up rate ("make it shorter") and reply length after deploy.

## Testing

- Unit: prompt sections, language fallback, Minsk date rollover, stable prefix across locales/dates, web-search on/off, router passing the setting.
- Manual: spot-check Russian/Belarusian replies for length, formatting, and language mirroring after deploy.

## Dependencies

- Existing AI Router, locale resolution, and OpenRouter web-search configuration.

## Open questions

- The sensitive-topic policy is a neutral default; product owner should confirm or adjust wording (especially for political topics).

## Implementation checklist

- [x] Implementation complete
- [x] Tests added or updated
- [x] Documentation updated where needed
- [ ] ADR added if a significant architectural decision was made
- [x] Full local checks pass
- [x] Focused PR opened
