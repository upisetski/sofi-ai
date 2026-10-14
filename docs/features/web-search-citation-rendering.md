# Feature: Web-search citation rendering

## Goal

Ensure web-backed answers expose source links returned by OpenRouter even when the model's answer omits them, without inventing sources or duplicating links.

## User behavior

- When OpenRouter returns URL-citation annotations, Sofi appends missing source titles and URLs below the answer.
- The source-section label matches the user's resolved language: Russian, Belarusian, or English.
- An answer without citation annotations receives no synthetic source list.

## Scope

### In scope

- Parse OpenRouter `url_citation` annotations from the first assistant choice.
- Validate HTTP(S) URLs and reject malformed URLs, unsafe schemes, and embedded URL credentials.
- Deduplicate citations, sanitize titles, and cap the rendered list at five items.
- Avoid listing source URLs already present in the generated answer.
- Preserve the provider-neutral AI Router boundary.

### Out of scope

- Running live billable search requests in automated tests.
- Claiming Russian/Belarusian retrieval quality or actual charges have been validated.
- Semantic classification or rewriting of every possible unsupported claim that the model searched.
- Adding model-level fallback chains or retry loops.

## Requirements

- Only structured provider citation annotations may create appended source links.
- Source titles must be single-line and bounded; a missing title falls back to the source hostname.
- Only HTTP(S) URLs without embedded credentials are rendered.
- No citation URL or title is added to application logs.

## Acceptance criteria

- [x] Valid OpenRouter URL citations are preserved as source metadata by the adapter.
- [x] Malformed, duplicate, unsafe-scheme, and credential-bearing URLs are rejected.
- [x] Missing source links are appended with a Russian, Belarusian, or English section label.
- [x] Existing source URLs in the answer are not repeated.
- [x] Answers without citations are returned without an empty source section.
- [ ] Live Russian/Belarusian search quality, source usefulness, and actual OpenRouter billing are verified before rollout.

## Technical notes

OpenRouter's documented Chat Completions response exposes search sources as `message.annotations` entries of type `url_citation`, containing a URL and (when available) a title. Sofi supports both the wrapped `url_citation` object and a flattened citation object, and validates the URL before presenting it.

The adapter extracts citation metadata without logging it. The AI Router formats it as plain text so Viber clients can recognize the URLs without relying on Markdown rendering.

## Data and privacy

- Source URL/title metadata exists only in the provider response and in the generated answer sent/stored under the existing message-retention rules.
- Do not persist a separate source index or search-query history.
- Do not log source URLs, titles, query strings, or full model output.

## Observability

- Reuse existing content-free route/model/usage outcome logs.
- Do not add citation content or source URLs to structured log records.

## Testing

- Unit: valid, malformed, duplicate, missing-title, unsafe-scheme, and credential-bearing annotations.
- Unit: source-section rendering for all supported locales and no duplication when a URL is already in the answer.
- Integration/manual: run representative Russian and Belarusian current-information queries and compare usage-ledger search-cost estimates with actual billing before launch.

## Dependencies

- Existing OpenRouter web-search integration and AI Router.
- OpenRouter Chat Completions URL-citation annotation contract.

## Open questions

- Which production-routed provider/engine combination supplies useful URL annotations for Russian and Belarusian queries under the selected privacy policy?
- Do the configured search-cost estimates track actual production billing closely enough?

## Implementation checklist

- [x] Implementation complete
- [x] Tests added or updated
- [x] Documentation updated where needed
- [x] ADR not required; this consumes the existing OpenRouter citation contract
- [ ] Full local checks pass
- [x] Focused PR opened
