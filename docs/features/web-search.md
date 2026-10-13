# Feature: Model-invoked native-first web search

## Goal

Give Sofi access to current information without requiring users to issue a search command, while keeping search cost bounded and visible.

## User behavior

- The model may search when current facts, recent events, or sources are useful.
- Ordinary writing and explanation requests should not trigger search unnecessarily.
- Search-backed answers should include useful source URLs and should not claim a search occurred when it did not.
- Search queries should preserve the user's language where appropriate, including Russian and Belarusian.

## Scope

### In scope

- OpenRouter's `openrouter:web_search` server tool on normal text requests.
- `auto` as the default engine: native provider search where supported, Exa fallback when unsupported.
- Configurable engine, result limits, context size, and a conservative search-cost reservation.
- Parsing the reported search-request count and reconciling an estimated search-tool cost through the existing usage ledger.
- Tests for request shape, tool usage parsing, config validation, and budget accounting behavior.

### Out of scope

- A custom search provider integration or client-managed tool loop.
- Guaranteed runtime retry to another search engine after a search execution error.
- A claim that Russian/Belarusian result quality is already validated.
- A dashboard, external search evaluation service, or live billable integration tests.

## Requirements

- Include the search tool in AI requests when enabled; let the model decide whether to call it.
- Default to engine `auto`, five results, five total results, and low context.
- Keep provider selection and tool protocol details inside the OpenRouter integration.
- Reserve model-generation cost plus the configured per-search maximum before the request. The default reservation is up to five searches at USD 0.01 each.
- Read `usage.server_tool_use.web_search_requests` when present and apply the configured estimated per-search cost in reconciliation. If usage needed for safe reconciliation is missing, retain the existing conservative reservation.
- Keep all search charges within the existing per-user and global daily/monthly budgets.
- Keep privacy filters on the OpenRouter request. This does not prove that a native provider or external search engine has the same retention policy; verify effective handling before launch.
- Do not log search queries, user messages, response contents, or raw provider bodies.

## Acceptance criteria

- [ ] OpenRouter requests include the configurable server search tool by default.
- [ ] The default engine is native-first `auto`, falling back to Exa when native search is unsupported.
- [ ] Search can be disabled through configuration.
- [ ] Result count and context size are bounded.
- [ ] Search request counts are parsed without logging search queries or content.
- [ ] Reservations include the configured maximum possible search-tool cost.
- [ ] Reconciliation adds estimated search cost to model cost and records the cost as estimated when search was used.
- [ ] Missing usage does not silently release a potentially billable reservation.
- [ ] Russian and Belarusian query quality and actual OpenRouter billing are manually evaluated before external rollout.

## Technical notes

- OpenRouter documents server-tool use as zero or more calls per completion and exposes `usage.server_tool_use.web_search_requests`. Its `auto` engine uses native search on supported provider endpoints and Exa otherwise. The web-search server tool is beta.
- The default USD 0.01/search estimate is a budget guard, not a statement of the final provider price. Native search is pass-through priced; compare ledger estimates with OpenRouter billing and adjust Railway configuration if needed.
- Parallel is available as an explicit engine and may be cheaper per request, but OpenRouter's documented `auto` mode cannot use Parallel as its secondary fallback. Pinning Parallel trades native-first behavior for a fixed search engine.
- OpenRouter's documented fallback is for endpoints that do not support native search. This feature does not promise a second request to another engine when search execution fails at runtime.

## Data and privacy

- Search queries and result content are transmitted to OpenRouter and may be sent to the selected native provider or fallback search service.
- Do not log query strings, snippets, sources returned to the model, or complete prompts/completions.
- Existing message-retention rules remain unchanged. Verify search-provider data handling and any applicable disclosure requirements before external rollout.

## Observability

- Record the search request count and estimated tool cost in the existing sanitized usage-reconciliation event.
- Keep OpenRouter provider diagnostics content-free.
- Compare estimates against the provider billing console during pilot validation.

## Testing

- Unit: tool request construction, enabled/disabled behavior, usage metadata parsing, malformed/missing search counts, and config validation.
- Accounting: worst-case search reservation, no-search reconciliation, search cost reconciliation, and missing-usage reservation retention.
- Manual: representative Russian and Belarusian current-events, local-information, and general web queries; verify links, latency, and actual billing.

## Dependencies

- OpenRouter Chat Completions server-tool support.
- Existing AI Router and PostgreSQL usage-accounting ledger.

## Open questions

- Does the selected production provider endpoint offer native search under the configured privacy policy, and how does its actual search price compare with the configured estimate?
- Does Exa fallback meet Russian and Belarusian retrieval quality requirements for the pilot?

## Implementation checklist

- [x] Implementation complete
- [x] Tests added or updated
- [x] Documentation updated where needed
- [x] ADR added for the native-first search decision
- [ ] Full local checks pass
- [x] Focused PR opened
