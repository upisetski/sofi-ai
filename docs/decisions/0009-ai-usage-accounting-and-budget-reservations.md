# ADR 0009: PostgreSQL-backed AI usage accounting and budget reservations

- **Status:** Accepted
- **Date:** 2026-10-12

## Context

Sofi is free to users. WP1 provides durable conversation turns and a monotonically increasing generation-attempt count, but provider calls previously had no application-level accounting or aggregate spend guard. OpenRouter Chat Completions can return input/output/total token counts and request cost when usage reporting is explicitly enabled. Model prices can change, and an unknown model must not be treated as free.

Current usage reporting and pricing were verified against OpenRouter's [official usage accounting documentation](https://github.com/OpenRouterTeam/docs/blob/main/cookbook/administration/usage-accounting.mdx), [model catalog API](https://openrouter.ai/docs/api/api-reference/models/get-model), and [Gemma 3 4B pricing page](https://openrouter.ai/google/gemma-3-4b-it/pricing) on 2026-10-12. Non-streaming Chat Completions automatically include usage; `usage: { include: true }` is deprecated and has no effect, so the adapter does not send it. The configured model's displayed price was $0.05 per million input tokens and $0.10 per million output tokens. Application accounting still treats absent or malformed usage/cost fields as unavailable.

## Decision

- Persist one content-free 'ai_usage_attempts' row for each attempted provider call, keyed uniquely by (turn_id, attempt_number). The current WP1 turn attempt counter remains the source of stable retry identities.
- Keep the accounting contract in the application layer and provider-specific parsing in the OpenRouter adapter. AI Router reserves before calling the provider and reconciles after a response. A configured accounting guard rejects calls that lack usage-attempt metadata.
- Use a static, explicitly reviewed model-price configuration instead of fetching pricing synchronously on each request. The exact model ID must equal AI_USAGE_PRICING_MODEL; otherwise paid calls fail closed. Changing the model requires verifying its live pricing and setting the matching model/rates.
- Estimate prompt tokens conservatively as eight tokens per UTF-16 code unit plus per-message overhead, plus the configured output-token cap. This is a safe guard approximation, not a claim to reproduce model tokenization. Actual or estimated provider token usage replaces the estimate after a successful response.
- Serialize budget decisions and accounting reconciliation through one usage_budget_mutex row locked within PostgreSQL transactions. This deliberately prioritizes correct global ceilings over parallel reservation throughput, which is acceptable for MVP scale.
- Store cost as actual, estimated, or unknown. Never coerce unavailable cost to zero. A settled cost replaces the active reservation in budget totals and unused reservation is released.
- A request rejected before provider I/O creates no billable-attempt row. Explicit request/configuration rejections release the reservation. Timeouts, network interruptions, HTTP 408/425, server errors, and malformed successful responses are treated as ambiguous; their reservation remains held.
- A reserved state that expires before the router marks the provider call in-flight is safe to release. An expired in-flight reservation becomes uncertain, remains charged against applicable budget windows, and emits a sanitized recovery event. A duplicate (turn, attempt) cannot call the provider a second time.
- Apply UTC per-user attempt/daily-spend limits, per-request estimated-cost guard, and global UTC day/month ceilings. At the configured `AI_ECONOMY_THRESHOLD_PERCENT` (default 80%) of a projected global ceiling, or when the normal output estimate exceeds the per-request guard, economy mode limits output to `AI_ECONOMY_MAX_OUTPUT_TOKENS` (default 256) or the normal output cap, whichever is lower, and still runs every normal guard. Input/output price settings must be positive so a zero-price misconfiguration fails validation. Hard ceilings block new calls.
- Use conservative initial free-pilot limits: 50 provider attempts per user per UTC day, $0.10 per user/day, $0.01 estimated per request, $2 global/day, and $30 global/month. These are deliberately low starter ceilings, not universal safety thresholds. Operators must set/confirm these values and configure an OpenRouter account-level spend cap before inviting users.
- Keep accounting rows content-free and retain terminal rows for 90 days. No dashboard or separate accounting service is introduced.

## Consequences

- The current cheap_text route is budgeted before provider I/O. The same accounting service accepts the router's route contract; WP3 must include separately billed web-search/tool costs in a conservative reservation before enabling the web route.
- Global reservations serialize on a single PostgreSQL row. If measurable contention appears, revisit this only with workload evidence.
- Unknown/ambiguous usage may conservatively hold budget until its daily/monthly window ages out, reducing availability rather than risking unobserved overspend.
- Provider prices are an operational configuration responsibility. A model change without a reviewed matching price entry blocks paid calls instead of silently applying stale rates.
- Structured logs are operational signals only. Alerting, dashboards, and product analytics remain WP4 scope.