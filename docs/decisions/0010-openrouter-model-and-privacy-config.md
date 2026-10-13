# ADR 0010: Configure model and enforce OpenRouter privacy filters per request

## Status

Accepted

## Context

Sofi needs a practical way to evaluate paid OpenRouter models in production without code changes, while retaining a privacy-first default and the existing fail-closed usage accounting.

## Decision

- Default `cheap_text` to `openai/gpt-6-luna`.
- Keep the model and its usage-accounting pricing model/rates configurable through environment variables.
- Send `provider.zdr: true` and `provider.data_collection: "deny"` with every OpenRouter chat completion by default.
- Expose explicit validated environment overrides: `OPENROUTER_REQUIRE_ZDR` and `OPENROUTER_DATA_COLLECTION_POLICY`.
- Keep OpenRouter account-level privacy settings and guardrails configured as defense in depth.
- Before changing model IDs, update the matching pricing model and both rates together. Unknown or mismatched prices must continue to fail closed.
- Do not treat request flags or a model slug as proof that the effective endpoint meets privacy requirements; verify the selected endpoint and plan.

## Consequences

- Model tests can be performed by changing Railway variables and redeploying, without a code change.
- Strict privacy filters can make a request fail when no eligible provider endpoint is available; Sofi must not silently retry without them.
- Operators can override privacy settings for a specific approved test, but must not disable them for real user conversations without a reviewed alternative.
- The default published standard rates for GPT-6 Luna are $0.10/M input and $0.50/M output tokens, checked 2026-10-13. Provider rates can change and must be re-reviewed when switching models.