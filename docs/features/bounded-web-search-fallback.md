# Feature: OpenRouter-managed web search and bounded cost

## Goal

Make web-search cost predictable by explicitly pinning Parallel in each Sofi request and bounding the number and size of searches.

## Decision

- Sofi sends `engine: "parallel"` on every search-enabled request. This is necessary because OpenRouter's `auto` engine uses native search when available and otherwise falls back to Exa.
- Do not rely on workspace `auto` routing or workspace fallback order to select the engine for Sofi requests.
- Sofi explicitly sends `engine: "parallel"` so each search uses Parallel instead of OpenRouter's `auto` behavior (native search when available, otherwise Exa).
- Sofi applies one bounded request policy: Parallel's default `basic` mode (the current server-tool API documents `basic` and `advanced`, not `fast`), medium search context, 5 results per search, at most 10 total results, and no more than 2 search/tool calls per generation.
- OpenRouter's workspace engine list provides centralized provider selection and availability-based fallback. It does **not** guarantee a retry against another engine after every runtime search error; Sofi will not implement its own cross-engine retry loop in this feature.

## Request policy

The OpenRouter server tool request should use these bounds:

- Do not send a `mode` parameter: the current OpenRouter server-tool API documents Parallel modes as `basic` and `advanced`, not `fast`; use Parallel's default `basic` mode.
- `search_context_size: "medium"`.
- `max_results: 5`.
- `max_total_results: 10`.
- `max_uses: 2`.
- Top-level `max_tool_calls: 2`.

Both `max_uses` and top-level `max_tool_calls` are set because native-provider enforcement of `max_uses` varies. `max_tool_calls` is the overall server-tool step limit. Keep the search tool as model-invoked so ordinary writing requests need not search.

## Cost and usage accounting

- Reserve the configured search-cost estimate for up to two search calls before generation, and reconcile it against OpenRouter's returned usage when available.
- Keep `AI_WEB_SEARCH_COST_PER_REQUEST_USD` conservative enough for every engine allowed by the workspace. OpenRouter currently documents Parallel at $0.005 per search request, including up to 10 results. Keep the $0.01-per-search reservation as a conservative estimate and verify the live billing view before enabling external users.
- The configured search-tool reserve with that estimate is $0.02 per generation, in addition to model-token usage. The normal per-user and global budgets, per-request guard, and economy mode must remain in force.
- Do not treat the defaults as a hard cap on model-token costs; model input/output costs are accounted separately.
- Do not enable external-user search until the combined maximum model + search cost is enforced and verified.

## In scope

- Pin Parallel and set bounded request defaults for result count, context, and tool calls.
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

- [ ] Request explicitly pins Parallel; OpenRouter `auto` routing is not used for Sofi searches.
- [ ] Sofi explicitly selects Parallel and does not use OpenRouter `auto` routing.
- [ ] Request carries `engine: "parallel"`, `search_context_size: "medium"`, `max_results: 5`, `max_total_results: 10`, and `max_uses: 2`; no unsupported `mode: "fast"` field is sent.
- [ ] Top-level `max_tool_calls` is 2.
- [ ] Tests verify the exact Parallel engine and bounded request parameters.
- [ ] Usage accounting reserves costs for two search calls and reconciles actual reported usage where available.
- [ ] Tests prove that existing per-user/per-request/global budgets still apply.
- [ ] Live synthetic Russian and Belarusian queries validate relevance, citations, latency, region availability, privacy, and charges across the configured engine list.
- [ ] `AI_WEB_SEARCH_ENABLED=false` remains the external-user setting until search acceptance, billing, privacy, and cost guards are verified.
- [ ] Typecheck, lint, formatting, tests, production build, and Docker build pass before merge.

## Observability

Record route/model, search request count, model token usage, estimated/reported cost, and sanitized error categories. Do not log prompts, search queries, result snippets, source URLs, or raw provider responses. Compare the internal usage ledger with OpenRouter's billing console during pre-launch validation.

## Dependencies

- Existing OpenRouter client, AI Router, and PostgreSQL usage-accounting ledger.
- OpenRouter workspace Server Tools access to verify Parallel availability and billing.
- Current pricing and privacy/region behavior validated against the actual workspace.

## Implementation checklist

- [ ] Confirm workspace default and fallback engine order
- [ ] Implement bounded request defaults without application-level engine routing
- [ ] Verify two-call cost reservation and reconciliation
- [ ] Add regression tests and update architecture/configuration docs
- [ ] Run full local checks and synthetic live acceptance tests
- [ ] Update the roadmap and prepare the implementation PR
