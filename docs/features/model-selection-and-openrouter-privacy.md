# Feature: Configurable model selection and OpenRouter privacy enforcement

## Goal

Let operators test GPT-6 Luna and other OpenRouter models by changing Railway variables, while requiring ZDR and no provider data collection by default.

## User behavior

No user-facing behavior changes beyond using the configured model for normal text replies.

## Scope

### In scope
- Set GPT-6 Luna as the default `cheap_text` model.
- Keep model ID and reviewed input/output token prices independently configurable in Railway.
- Add request-level OpenRouter provider constraints for ZDR and data collection.
- Default privacy constraints to ZDR required and data collection denied.
- Cover defaults and overrides with automated tests and document deployment setup.

### Out of scope
- Direct provider integrations, automatic model selection, model benchmarking, web search, and dynamic pricing retrieval.
- Guaranteeing privacy beyond the effective OpenRouter account, plan, guardrails, and eligible endpoint configuration.

## Requirements

- All model requests continue through the internal AI Router and OpenRouter integration.
- Every OpenRouter chat completion includes `provider.zdr` and `provider.data_collection`.
- Defaults are `OPENROUTER_REQUIRE_ZDR=true` and `OPENROUTER_DATA_COLLECTION_POLICY=deny`.
- Operators can explicitly override model, matching pricing model, rates, and privacy controls through environment variables.
- Usage accounting remains fail-closed if the configured pricing model does not match the requested model.
- No prompt or completion content is added to logs or usage accounting.

## Acceptance criteria

- [ ] GPT-6 Luna is the default model and matching pricing model.
- [ ] Default prices match the published standard OpenRouter rates: $0.10/M input and $0.50/M output tokens, checked 2026-10-13.
- [ ] ZDR and data collection denial are included in every OpenRouter request by default.
- [ ] Privacy settings can be explicitly overridden by validated environment variables.
- [ ] Tests cover default request payload, explicit overrides, and environment validation.
- [ ] Railway operators can switch models without code changes and configure corresponding rates.
- [ ] Documentation explains privacy limitations and model/pricing consistency.
- [ ] Full repository checks and Docker build pass.

## Technical notes

- Model: `openai/gpt-6-luna`.
- OpenRouter request-level controls are `provider.zdr` and `provider.data_collection`.
- `AI_MODEL_CHEAP_TEXT` selects the model; `AI_USAGE_PRICING_MODEL` and the two per-million-token price variables must be updated together for another model.
- Do not enable cheaper/free endpoints for real conversations until their effective data handling has been verified.

## Data and privacy

User prompts and bounded conversation context continue to be sent to OpenRouter for inference. No new content is stored locally. ZDR and data-collection constraints are sent with each request by default, but actual guarantees depend on OpenRouter plan, account controls, and eligible endpoints. Operators must not disable these constraints for production conversations unless they have separately approved and verified the replacement privacy arrangement.

## Observability

Continue existing sanitized model, latency, token, cost, and error metadata. Do not log prompts, completions, credentials, or raw provider response bodies.

## Testing

- Unit: default environment values and Railway overrides.
- Integration: mocked OpenRouter payload contains strict privacy controls by default and honors validated overrides.
- E2E / manual: verify that a real request succeeds on the deployed key with ZDR and data collection denial enabled; use synthetic content until verified.
- Edge cases: model/pricing mismatch remains blocked by existing usage accounting; no eligible ZDR endpoint returns a provider error rather than silently relaxing request privacy.

## Dependencies

- Existing OpenRouter API key and account access.
- Existing usage accounting and budget guards.

## Open questions

- Confirm actual ZDR eligibility for GPT-6 Luna providers on the deployed OpenRouter plan/key before sending real user conversations.

## Implementation checklist

- [ ] Implementation complete
- [ ] Tests added or updated
- [ ] Documentation updated where needed
- [ ] ADR added if a significant architectural decision was made
- [ ] Full local checks pass
- [ ] Focused PR opened