# Feature: Parallel web search and bounded cost

## Goal

Make web-search cost predictable by explicitly pinning Parallel in each Sofi request and bounding the number and size of searches.

## Decision

- Sofi sends `engine: "parallel"` on every search-enabled request. This is necessary because OpenRouter's `auto` engine uses native search when available and otherwise falls back to Exa.
- Do not rely on workspace `auto` routing or workspace fallback order to select the engine for Sofi requests.
- Sofi explicitly sends `engine: "parallel"` so each search uses Parallel instead of OpenRouter's `auto` behavior (native search when available, otherwise Exa).
- Sofi applies one bounded request policy: Parallel `fast` mode, medium search context, 5 results per search, at most 10 total results, and no more than 2 search/tool calls per generation. Parallel Fast language availability is not documented, so Russian and Belarusian search quality must be validated before external rollout.
- Sofi pins Parallel at request time. If Parallel is unavailable or errors, Sofi does not switch to Exa/native or retry with another engine; normal request failure handling applies.

## Request policy

The OpenRouter server tool request should use these bounds:

- `mode: "fast"` for lower-latency Parallel search.
- `search_context_size: "medium"`.
- `max_results: 5`.
- `max_total_results: 10`.
- `max_uses: 2`.
- Top-level `max_tool_calls: 2`.

Set both `max_uses` and top-level `max_tool_calls` to 2: the former caps search uses, while the latter caps tool calls in the generation. Keep the search tool model-invoked so ordinary writing requests need not search.

## Cost and usage accounting

- Reserve the configured search-cost estimate for up to two search calls before generation, and reconcile it against OpenRouter's returned usage when available.
- OpenRouter documents Parallel Fast at $0.001 per search request, including up to 10 results. Keep the `$0.01`-per-search reservation as a conservative estimate and verify the live billing view before enabling external users.
- The configured search-tool reserve with that estimate is $0.02 per generation, in addition to model-token usage. The normal per-user and global budgets, per-request guard, and economy mode must remain in force.
- Do not treat the defaults as a hard cap on model-token costs; model input/output costs are accounted separately.
- Do not enable external-user search until the combined maximum model + search cost is enforced and verified.

## In scope

- Pin Parallel Fast and set bounded request defaults for result count, context, and tool calls.
- Preserve existing privacy settings on every OpenRouter request.
- Keep content-free usage accounting and sanitized telemetry.
- Add unit tests for the exact request body, search limits, and accounting reservation/reconciliation behavior.
- Update configuration docs to describe the explicit Parallel request setting.

## Out of scope

- Application-managed cross-engine fallback or retries.
- Generic retries for timeouts, network errors, HTTP 5xx, rate limits, or ambiguous provider outcomes.
- Searching every request; the model should invoke search only when useful.
- A custom multi-step search agent.
- Enabling search for external users before live billing, privacy, language-quality, and cost-guard checks pass.

## Requirements

- Search is enabled only when configured on, and the OpenRouter server tool remains the normal search path.
- The request explicitly sets `engine: "parallel"`; it must not use `auto`, because `auto` can fall back to Exa when native search is unavailable.
- The application applies the bounded request policy above on every search-enabled request.
- No more than two server-tool calls are allowed for one generation.
- The app keeps strict ZDR and data-collection settings; search-backend retention and regional availability must be separately checked.
- Timeouts, network failures, rate limits, 5xx responses, malformed responses, and other ambiguous failures are not retried by Sofi.
- Logs must not contain prompts, completions, search queries, snippets, citation URLs, or raw provider bodies.
- The normal usage-accounting reserve must cover the maximum allowed search cost before the provider is called.

## Acceptance criteria

- [x] Request explicitly pins Parallel; OpenRouter `auto` routing is not used for Sofi searches.
- [ ] Sofi explicitly selects Parallel and does not use OpenRouter `auto` routing.
- [ ] Request carries `engine: "parallel"`, `mode: "fast"`, `search_context_size: "medium"`, `max_results: 5`, `max_total_results: 10`, and `max_uses: 2`.
- [ ] Top-level `max_tool_calls` is 2.
- [ ] Tests verify the exact Parallel engine and bounded request parameters.
- [ ] Usage accounting reserves costs for two search calls and reconciles actual reported usage where available.
- [ ] Tests prove that existing per-user/per-request/global budgets still apply.
- [ ] Live synthetic Russian and Belarusian queries validate relevance, citations, latency, region availability, privacy, and charges for Parallel Fast.
- [ ] `AI_WEB_SEARCH_ENABLED=false` remains the external-user setting until search acceptance, billing, privacy, and cost guards are verified.
- [ ] Typecheck, lint, formatting, tests, production build, and Docker build pass before merge.

## Observability

Record route/model, search request count, model token usage, estimated/reported cost, and sanitized error categories. Do not log prompts, search queries, result snippets, source URLs, or raw provider responses. Compare the internal usage ledger with OpenRouter's billing console during pre-launch validation.

## Dependencies

- Existing OpenRouter client, AI Router, and PostgreSQL usage-accounting ledger.
- OpenRouter workspace Server Tools access to verify Parallel availability and billing.
- Current pricing and privacy/region behavior validated against the actual workspace.

## Implementation checklist

- [ ] Verify Parallel availability and billing in the OpenRouter workspace
- [ ] Implement bounded request defaults without application-level engine routing
- [ ] Verify two-call cost reservation and reconciliation
- [ ] Add regression tests and update architecture/configuration docs
- [ ] Run full local checks and synthetic live acceptance tests
- [ ] Update the roadmap and prepare the implementation PR
