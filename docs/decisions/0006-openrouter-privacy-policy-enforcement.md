# ADR 0006: Keep OpenRouter privacy policy centrally configured

## Status

Accepted

## Context

Sofi previously attached `provider.zdr: true`, `provider.data_collection: "deny"`, and `provider.allow_fallbacks: false` to every OpenRouter completion request. The hard-coded data-policy restrictions can make free-tier model routing unavailable, and request-specific policy settings duplicate platform-level configuration.

## Decision

- Do not hard-code ZDR or data-collection policy into the OpenRouter completion payload.
- Configure ZDR through OpenRouter account privacy settings and API-key/model-group guardrails where available.
- Configure provider training/data-collection restrictions through OpenRouter privacy settings or other platform controls that support that policy.
- Leave provider selection and fallback behavior to OpenRouter defaults unless a route has an explicit, tested need for a different behavior.
- Treat policy enforcement as a deployment configuration requirement, not as a guarantee provided by the selected model slug.

Omitting request-level `provider.zdr` does not disable account-wide or guardrail ZDR enforcement. The plan and selected endpoint must still support the required policy. OpenRouter's free tier does not support data-policy-based routing, so free-tier experiments must use synthetic messages unless the required data handling has been independently verified.

## Consequences

- Free-model/router requests are not rejected solely because Sofi hard-codes request-level data-policy constraints.
- OpenRouter account settings and guardrails become the source of truth for centrally supported privacy requirements.
- Before sending real user conversations, operators must verify effective ZDR and training/data-collection settings for the deployed key, plan, model group, and endpoint.
