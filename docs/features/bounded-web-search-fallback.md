# Feature: Bounded web-search fallback behavior

## Goal

Keep the MVP responsive when OpenRouter's optional web-search tool is unsupported for a selected model/provider endpoint, without retrying ambiguous billable requests or bypassing usage budgets.

## User behavior

- Ordinary text requests continue to work when web search is disabled.
- If OpenRouter explicitly rejects a request because the web-search tool or its configuration is unsupported, Sofi may make one bounded fallback attempt without the search tool, provided the provider error can be classified confidently.
- The fallback answer must not claim to have searched or present fabricated sources.
- Transient failures and ambiguous outcomes are not blindly retried.

## Scope

### In scope
- Classify a narrow, explicit set of OpenRouter errors that indicate unsupported web-search/tool configuration.
- Permit at most one fallback request without web search for that generation.
- Preserve route/model configuration and privacy flags in the fallback request.
- Apply the same input/output/time limits and existing usage-accounting safety rules.
- Emit content-free structured telemetry indicating fallback reason and outcome.
- Add deterministic unit tests for classification, request shape, fallback bounds, and non-fallback cases.

### Out of scope
- Generic retries for timeouts, network errors, HTTP 5xx, rate limits, or other ambiguous provider outcomes.
- Automatic switching between models or search engines.
- A client-managed tool loop or autonomous agent.
- Claiming that a no-search fallback answer contains current verified facts.
- Enabling web search for external users before live acceptance, billing, and privacy checks pass.

## Requirements

- The normal OpenRouter server-tool call remains the primary path when search is enabled.
- Only an explicit, documented/verified unsupported-tool error may trigger fallback. Do not infer unsupported-tool status from arbitrary error-message text alone.
- The fallback request removes the search tool and tool-call parameters; it preserves model, messages, token limit, timeout, and provider privacy settings.
- Fallback is attempted no more than once. A failed fallback is returned as a failure; there is no retry loop.
- Never retry timeouts, network errors, HTTP 408/425, rate limiting, HTTP 5xx, malformed responses, or errors where provider execution/billing is uncertain.
- Do not retry a failure after a successful provider response, even if local post-processing fails.
- Keep fallback behavior within the existing usage-accounting contract. If the current reservation/attempt model cannot safely account for a second provider attempt, do not ship a second call until accounting is extended and tested. Never release an ambiguous reservation or count a potentially billable call as free.
- Logs contain route, model, safe error category/code, fallback attempted/succeeded, and duration only; no prompts, completions, search queries, citation URLs, or raw provider bodies.
- Preserve the user-facing language and never claim a search was performed if fallback ran without search.

## Acceptance criteria

- [ ] Explicit unsupported-tool errors are classified using stable provider status/code metadata, not broad message substring matching.
- [ ] At most one no-search fallback is attempted for a classified error.
- [ ] Fallback request preserves provider privacy policy and configured model/token/timeout limits.
- [ ] Timeouts, network failures, rate limits, server errors, malformed responses, and unclassified errors do not trigger fallback.
- [ ] Usage accounting reserves and reconciles both attempts safely, or implementation proves the fallback occurs before provider execution and no second billable attempt is possible.
- [ ] Structured logs distinguish primary and fallback outcomes without sensitive content.
- [ ] Tests cover unsupported tool, unrelated 4xx, 408/425, 429, 5xx, timeout/network, malformed response, and fallback failure.
- [ ] Live smoke test with synthetic content verifies the chosen provider's actual error contract before rollout.
- [ ] `AI_WEB_SEARCH_ENABLED=false` remains the external-user setting until search acceptance, billing, and privacy gates pass.

## Technical notes

The AI Router currently reserves and marks one provider attempt in flight before calling the provider. Its accounting logic treats most 4xx responses as known failures but holds ambiguous outcomes conservatively. A second provider call must not be hidden inside the OpenRouter adapter because the application ledger would otherwise record only one attempt. Implementation must either add an explicit, budgeted attempt lifecycle in the application layer or limit fallback to a proven pre-execution rejection that cannot be billed.

OpenRouter's documented `auto` engine fallback applies when native search is unsupported by an endpoint; it does not promise runtime retry after search execution errors. Do not duplicate that behavior in Sofi without a verified need.

## Data and privacy

- Reuse the existing bounded message payload; do not persist fallback-specific prompt copies.
- Do not log user content, search queries, result snippets, source URLs, or raw provider responses.
- Preserve configured OpenRouter ZDR and data-collection policy on every request.

## Observability

- Record a bounded fallback reason code and attempted/succeeded outcome.
- Keep provider error diagnostics sanitized and content-free.
- Compare request counts and costs against OpenRouter's billing console during pre-launch validation.

## Testing

- Unit: stable error classification and fallback request shape.
- Unit: exactly zero or one fallback attempt for each error category.
- Unit/integration: usage ledger accounts for each actual provider attempt and keeps ambiguous costs reserved.
- Manual: synthetic Russian/Belarusian current-information queries, unsupported endpoint behavior, billing, citations, latency, and effective provider privacy settings.

## Dependencies

- Existing OpenRouter client, AI Router, and PostgreSQL usage-accounting ledger.
- Verified OpenRouter error contract for unsupported server-tool configurations.

## Open questions

- Which stable OpenRouter status/code combination reliably identifies an unsupported server-tool request before execution?
- Can the current per-turn attempt identity represent a second, separately budgeted provider attempt without risking duplicate delivery or unaccounted spend?

## Implementation checklist

- [ ] Error contract verified against official documentation and a synthetic smoke test
- [ ] Application-level attempt accounting supports the bounded fallback
- [ ] Implementation and regression tests complete
- [ ] Roadmap and configuration docs updated
- [ ] Full local checks pass
- [ ] Focused PR opened
