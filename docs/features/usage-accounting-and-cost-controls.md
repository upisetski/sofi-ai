# Feature: Usage accounting and enforced cost controls

## Goal

Prevent runaway paid AI usage before Sofi is exposed to external users, while making generation cost and failures visible without retaining message content.

## User behavior

- Requests within configured limits continue to receive the normal AI response.
- A request blocked by request-count or spend controls receives a short, localized response in Russian, Belarusian, or English. It does not call a paid provider.
- Near the global ceiling, Sofi switches to economy mode by lowering the output-token cap. At a hard daily/monthly ceiling, no new paid request proceeds.
- A previously persisted assistant reply is redelivered without reserving or recording another generation attempt.

## Scope

### In scope

- One content-free PostgreSQL accounting row per actual provider attempt, tied to the durable turn and retry attempt.
- Provider-neutral usage/pricing contracts at the application AI Router boundary; OpenRouter response parsing stays in its integration.
- Atomic budget reservation and reconciliation, stable attempt idempotency, stale-reservation recovery, and safe handling of ambiguous provider outcomes.
- Per-user daily attempt count and spend, per-request estimated-cost ceiling, global daily/monthly spend ceilings, and economy mode.
- Sanitized structured usage and budget events, localized guard responses, configuration validation, migration, and PostgreSQL-backed tests.

### Out of scope

- Web search implementation, web tool billing details, a dashboard, alerts, product analytics, direct provider integrations, a pricing microservice, Redis, or a separate worker.
- Automatically querying OpenRouter pricing on every request. Pricing is a reviewed, explicit runtime catalog; unknown models fail closed.
- Exactly-once provider execution when a process/network failure leaves the remote outcome ambiguous.

## Requirements

1. Each reservation identifies a durable conversation turn and attempt number. The deterministic attempt key is unique; duplicate reservation or reconciliation calls cannot create a second billable operation or release/reconcile twice.
2. The accounting row records internal user/conversation references, turn/attempt identifiers, route/model, start/finish timestamps, duration, outcome/failure category, available token counts, provider generation ID when safe, provider-reported cost, estimated cost, cost kind (actual, estimated, unknown), cost provenance, reserved amount, and reservation state.
3. Accounting never stores prompts, user messages, completions, credentials, raw provider bodies, or raw exception messages. `users.id` is the accounting identity; the external Viber user ID is not copied into the ledger.
4. Before provider I/O, the AI Router builds the exact bounded provider messages, obtains a conservative token/cost bound from the configured model prices and output limit, and requests an atomic PostgreSQL reservation. Missing/incomplete price metadata or an estimate above the per-request guard fails closed.
5. The text input estimate uses a conservative 8-token-per-UTF-16-code-unit bound plus message overhead. The existing 12,000-character bound and configured output-token cap bound the request. Prices are USD per million tokens. This is deliberately conservative, not an exact tokenizer; model price changes and custom models require pricing configuration to be reviewed.
6. All budget checks and reservation creation serialize through a single-row PostgreSQL budget mutex. In the same transaction, check per-user daily attempt count, per-user daily spend, per-request maximum estimate, global daily spend, and global monthly spend, including held/uncertain reservations. This intentionally favors simple correctness over cross-user reservation throughput at MVP scale.
7. The durable reservation is created in `reserved` state, then marked `in_flight` before the provider call. Known pre-call failures and explicit request rejections can release it. Timeouts, network interruptions, server errors, or malformed successful responses are ambiguous: retain the reserved amount as an unknown/uncertain cost rather than assuming zero.
8. On success, provider-reported `usage.cost` is actual cost. If cost is absent but both token counts and configured prices are available, store an estimated cost. Release the unused reservation only after that settled cost is persisted. If cost and token usage are unavailable, preserve `unknown` as the cost kind and keep the reservation amount charged against limits for the applicable daily/monthly windows.
9. An expired reservation that never reached `in_flight` is safely released. An expired `in_flight` reservation becomes an unknown/uncertain operation and continues counting against the current budget windows. It is not released just because the worker restarted; this avoids unsafe spend release. Records remain available for 90 days, then terminal accounting metadata may be removed; no content is stored in them.
10. Count each attempted provider call, including retries, against the per-user daily attempt limit. The existing turn attempt counter provides a stable attempt number; a new attempt gets a new reservation, while redelivery of a persisted reply does not.
11. Default pilot guardrails: 50 provider attempts per user per UTC day; USD 0.10 per user per UTC day; USD 0.01 maximum estimated cost per request; USD 2 global per UTC day; USD 30 global per UTC calendar month. These are deliberately conservative initial free-pilot ceilings, not a claim of a universally safe spend level; operators should lower them before a small pilot if required and adjust only using observed usage. Default model rates are USD 0.05/M input and USD 0.10/M output for `google/gemma-3-4b-it`, verified against OpenRouter's current model page on 2026-10-12. If that model changes, explicit prices must be configured or requests fail closed.
12. Economy mode activates when current or proposed reservation reaches 80% of a global daily/monthly ceiling, or the normal estimate exceeds the per-request guard. It caps output at the lesser of the normal token cap and 256 tokens. It is not a separate/bypass route and still uses all reservations/limits. A hard ceiling blocks new provider attempts.
13. The internal contract supports the existing `cheap_text` route and planned `web` route. This PR does not implement search. WP3 must pass every model/tool/search charge through the shared guard and include separately billed search costs in its reservation contract before enabling that route.
14. AI-disabled behavior does not create usage rows or reservations. Existing turn/reply lifecycle and generation retry limits remain intact. Budget denials are terminal for the current generation attempt and produce a localized response; they do not trigger more paid fallback calls.
15. UTC day/month windows are used independent of database session timezone. Terminal accounting rows are retained for 90 days; they contain identifiers, timing, usage and monetary metadata only.

## Acceptance criteria

- [ ] Each actual provider attempt is persisted once and identifiable by turn + attempt.
- [ ] Actual, estimated, and unknown costs are distinct; absent cost is never silently stored as zero.
- [ ] Missing price metadata and over-guard requests fail closed before provider I/O.
- [ ] Per-user attempts/daily spend, per-request maximum estimate, and global daily/monthly ceilings are enforced before paid provider I/O.
- [ ] Concurrent reservations cannot spend the same remaining budget.
- [ ] Reservation release/reconciliation is idempotent; retries create a distinct attempt.
- [ ] Successful replies reconcile actual cost or a documented estimate and release unused reservation.
- [ ] Ambiguous outcomes and expired in-flight reservations retain a conservative budget hold and emit sanitized events.
- [ ] Restart recovery does not release a reservation whose provider outcome could be billable.
- [ ] A stored assistant reply can be delivered again without a second generation reservation.
- [ ] AI-disabled paths do not invoke accounting or providers.
- [ ] Limit responses are localized and do not expose budgets or spend.
- [ ] Logs and accounting rows contain no prompts, completions, credentials, raw provider bodies, or user-facing message text.
- [ ] PostgreSQL integration tests cover idempotency, concurrency, isolation, limits, and recovery.
- [ ] Roadmap/architecture documentation state only what the implementation enforces; full repository checks and Docker build pass.

## Technical notes

- OpenRouter Chat Completions usage is requested with `usage: { include: true }`. The documented response can include `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`, and `usage.cost`. The OpenRouter model catalog also exposes pricing metadata, but this implementation deliberately uses a reviewed, model-keyed config snapshot to avoid introducing a runtime pricing-network dependency. Sources: [usage guidance](https://openrouter.ai/docs/guides/best-practices/usage), [model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), and [Gemma 3 4B pricing](https://openrouter.ai/google/gemma-3-4b-it/pricing), checked 2026-10-12.
- PostgreSQL remains the source of truth. A single singleton-row mutex serializes reservations/reconciliation so aggregate global and per-user limits remain correct under concurrent workers. This is acceptable for current MVP scale.
- The worker supplies the internal database user ID, conversation ID, durable turn ID, and generation attempt number to the router. External provider identity is not used for accounting joins.
- The accounting service is application-level and provider-neutral. OpenRouter-specific `usage.cost`, generation-ID, and token-field parsing stays in `src/integrations/openrouter/client.ts`.

## Data and privacy

- Ledger fields are limited to operational identifiers, route/model, status/category, timestamps/duration, token counts, and cost/reservation metadata. No content fields are permitted.
- Do not log full messages, prompts, completions, credentials, raw provider errors, or provider response bodies.
- Retain usage rows for 90 days. This is longer than the 30-day message-content retention but consistent with the current 90-day operational metadata window. Delete only terminal rows older than retention; do not delete active reservations. No user message-content retention policy is extended by WP2.

## Observability

Emit sanitized structured events for reservation creation, reservation adjustment/release/recovery, usage reconciliation, missing provider usage/cost, per-user limit rejection, request-cost rejection, global daily/monthly thresholds and ceilings, and economy mode activation. Include opaque internal IDs, route/model, outcome/category, duration, token values, cost kind, and numeric USD amounts as appropriate. Do not build alerts or a dashboard in this PR.

## Testing

- Unit: OpenRouter usage extraction including missing/malformed values; pricing-estimate arithmetic; actual/estimated/unknown cost distinctions; fail-closed price lookup; localized responses; sanitized event fields.
- PostgreSQL integration: per-user request and daily spend, per-request maximum, daily/monthly global limits, idempotent reserve/release/reconcile, parallel reservations racing for the same budget, process-restart/stale reservation recovery, and user isolation.
- Mocked provider tests: no call on guard rejection; success, provider error, timeout ambiguity, missing usage/cost, retry per attempt, and AI-disabled behavior.
- Regression: context construction, worker retries/delivery, webhook deduplication and debounce.
- CI uses mocked provider calls and deterministic costs/clocks; no real provider credentials or billable traffic.

## Dependencies

- PostgreSQL and current database migration/transaction helpers.
- Existing AI Router, OpenRouter adapter, and durable WP1 turn attempt lifecycle.
- Runtime configuration through the current Zod environment schema.

## Open questions

- No follow-up work is needed to decide the WP2 accounting/reservation contract. WP3 must add a conservative and explicit bound for any separately billed web-search/tool operations before enabling web search.

## Implementation checklist

- [ ] Implementation complete
- [ ] Tests added or updated
- [ ] Documentation updated where needed
- [ ] ADR added if a significant architectural decision was made
- [ ] Full local checks pass
- [ ] Focused PR opened
