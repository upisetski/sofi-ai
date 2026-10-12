# Sofi MVP Roadmap

**Status:** agreed product and engineering plan  
**Updated:** 2026-10-10  
**Scope:** first release to external users

This is the single prioritized checklist for reaching the first user-facing MVP. Feature specifications in `docs/features/` define implementation details and acceptance criteria; this file records release scope, order, dependencies, and release gates. Do not treat a roadmap item as implemented until code, tests, and its feature specification agree.

## MVP definition

Sofi's first external release is a **text-first AI assistant in Viber with bounded multi-turn conversation context and web search**.

Users can ask ordinary questions, draft or rewrite messages, ask follow-up questions referring to earlier turns, and request current information with useful source links. They should not need commands or prompt-engineering knowledge.

### Included in the first release

- Text input and AI-generated text responses.
- Multi-turn conversation context across separate message bursts.
- Bounded recent history, isolated per user/conversation, with a defined retention and reset/forget behavior.
- A provider-neutral AI Router with configurable text and web routes.
- Web search for current information, with source links in the answer.
- Tested, bounded retry/fallback behavior appropriate to the selected route.
- Durable turn/reply state and recoverable Viber delivery.
- Enforced request limits, per-user budgets, per-request cost guards, and global spending ceilings covering model and web-search costs.
- Operational monitoring, sanitized logs, error reporting, cost/usage visibility, and minimal product analytics.
- Verified provider/search data-handling settings, accurate user-facing copy, and an end-to-end-tested production deployment.

### Explicitly out of scope

- Image/vision input, audio, video, and document processing.
- Long-term personal memory, profiles, or vector search.
- An AI intent classifier or autonomous multi-tool agent.
- A separate worker service, Redis/BullMQ, Kubernetes, S3, or a custom admin dashboard.
- A `strong_text` route unless evaluations show the initial text model is insufficient.

These can be reconsidered after the MVP based on user needs and measured bottlenecks.

## Current baseline

Already implemented on the current main branch:

- Viber webhook validation/signature verification and localized welcome/error messages.
- PostgreSQL persistence, inbound-event deduplication, ordered conversation processing, and a PostgreSQL-backed job worker.
- Rolling 10-second text debounce; one reply is produced for each completed text burst.
- Provider-neutral AI Router and OpenRouter `cheap_text` integration.
- Configurable text model, output-token limit, and request timeout.
- Sanitized provider errors and malformed-response diagnostics.
- Automated tests for routing, mocked OpenRouter responses, debounce, and core integration behavior.
- Railway-oriented deployment, database migrations/readiness checks, Docker build, and CI.

WP1 adds persisted assistant history, bounded multi-turn context, a localized reset, and durable turn/reply delivery recovery; see the [feature specification](features/multi-turn-context-and-durable-delivery.md). WP2 adds content-free per-attempt accounting, PostgreSQL atomic reservations/reconciliation, per-user and global budget limits, a per-request cost guard, economy mode, and localized denials for the current `cheap_text` route; see [usage accounting and cost controls](features/usage-accounting-and-cost-controls.md). WP3 web search and WP4 complete product analytics/alerting remain outstanding. Web search must pass separately billed tool costs through the shared guard before it is enabled. Viber delivery cannot be guaranteed exactly once when a send outcome is ambiguous.

## Prioritized work before the first external users

Implement each work package as a focused feature PR. Before coding a non-trivial package, create/update its feature specification from `docs/features/_template.md`. Agree on shared persistence and lifecycle contracts first to avoid building overlapping schemas twice.

### WP1 — Multi-turn context and durable turn/reply lifecycle

**Priority:** P0 — first

- Persist user and assistant messages in a stable, ordered form.
- Build bounded recent conversation context across separate debounce bursts.
- Keep contexts isolated between Viber users and conversations.
- Define context limits and retention; provide a clear way for a user to reset/forget the conversation context.
- Persist a generated reply and its delivery state before attempting Viber delivery.
- Model enough turn/job state to recover from restarts and transient failures without silently losing replies or unnecessarily regenerating an answer.
- Prevent concurrent processing of the same conversation/turn and minimize duplicate replies on retries.
- Add automated tests for follow-up behavior, history limits, isolation, restart/recovery, and delivery failure cases.

**Exit criteria:** a follow-up such as “make it shorter” works after the previous response was delivered; history cannot leak across users; generated responses and delivery attempts can be recovered safely.

### WP2 — Usage accounting and enforced cost/abuse controls

**Priority:** P0 — required before any external users; design alongside WP1

- Record request/turn outcome, route, model, duration, token usage, and provider cost where available without storing full prompts or completions in analytics.
- Enforce configurable per-user request limits and daily budget.
- Enforce a per-request maximum-cost guard and global daily/monthly hard ceilings.
- Reserve estimated budget before provider work and reconcile actual model and search costs afterwards; release unused reservations.
- Make reservations atomic under concurrent requests and fail closed when spend cannot be safely determined.
- Define a safe, localized response when a limit is reached.
- Keep the OpenRouter account-level spend limit as an additional safeguard, not a replacement for application checks.
- Provide a configurable economy/degraded mode near the global ceiling.

**Exit criteria:** tests prove an over-limit request is blocked before external calls, concurrent requests cannot bypass a limit, usage is reconciled, and global limits cover both model generation and web search.

### WP3 — Explicit model routing, web search, and bounded fallbacks

**Priority:** P0 — required before launch

- Keep all model calls behind the internal AI Router; business logic must not depend on OpenRouter request/response types.
- Keep `cheap_text` configurable for normal chat and introduce a separate configurable `web` route.
- Search when current information is needed; avoid unnecessary searches for ordinary writing and explanations.
- Use a verified OpenRouter-compatible web-search mechanism and a model that supports the required tool behavior.
- Include useful source URLs/titles in web-backed answers; do not claim to have searched when no search ran.
- Cap search calls/results and ensure web-search costs pass through the same budget guard.
- Configure route-specific models and bounded fallback/retry behavior for transient or availability failures. Fallbacks must support the route's requirements and remain within cost/privacy limits.
- Avoid retrying non-transient failures blindly; prevent retry loops and unnecessary duplicate generation.
- Add mocked contract/integration tests for search results, source-link formatting, route selection, tool/model incompatibility, provider failures, fallbacks, and cost-limit interactions.
- Verify current provider/tool contracts and privacy/data-handling implications before implementation; do not assume every model/provider supports web search.

**Exit criteria:** ordinary requests use the text route; current-information requests use the web route and return source links; route failures are observable and terminate within configured limits.

### WP4 — Production observability and minimal product analytics

**Priority:** P0 — required before launch; instrument incrementally in WP1–WP3

- Wire actual runtime error reporting (Sentry if retained as the chosen tool, otherwise document the alternative); a configured `SENTRY_DSN` alone is not integration.
- Keep structured logs sanitized: no full user prompts, assistant completions, images, or credentials.
- Expose operational signals for successful/failed generation, route/model, latency, timeouts, fallback use, search usage, Viber delivery status, token/cost data, and budget rejections.
- Record minimal privacy-conscious product events to answer which task categories are used, whether requests complete, and whether users return.
- Define a practical alert/response procedure for high failure rates, delivery failures, and spend approaching limits.
- Use PostgreSQL initially; do not add a separate analytics service/dashboard for the MVP.

**Exit criteria:** an operator can diagnose a failed response and see usage/cost and return-use indicators without reading users' message contents.

### WP5 — Privacy, production configuration, and release validation

**Priority:** P0 — release gate

- Verify effective OpenRouter data-handling/retention settings for the selected plan, model, and provider routing; verify web-search data handling separately. Code that omits request-level privacy parameters does not prove the effective policy.
- Validate applicable Belarusian personal-data and privacy requirements, disclose external AI processing, define retention, and minimize stored content.
- Make welcome/help copy accurate for the text + web scope; do not promise images or documents.
- Set production secrets/configuration, an OpenRouter account-level spend cap, database backups/restore expectations, health checks, and a documented AI disable/rollback procedure.
- Run end-to-end checks with production-like Viber, PostgreSQL, OpenRouter, and web-search configuration using synthetic content until privacy guarantees are verified.
- Test database restart/recovery, webhook duplicates, debounce boundaries, multi-turn context, search/source handling, route fallback, AI timeouts, Viber send failures, budget exhaustion, and shutdown behavior.
- Require full repository checks and a successful production Docker build before merging.

**Exit criteria:** release gates below are all satisfied and a small, invited pilot cohort can be enabled intentionally.

## Release gates

Do not enable external users until every item is satisfied:

- [ ] Multi-turn text conversations work across distinct message bursts.
- [ ] Context is bounded, isolated by user/conversation, and has documented retention/reset behavior.
- [ ] Replies and delivery state are durable; recoverable failures do not silently drop replies or trigger uncontrolled duplicate generation.
- [ ] Text and web routes are configurable and covered by tests; web answers include useful sources.
- [ ] Retry/fallback behavior is bounded, tested, and route-compatible.
- [ ] Per-user limits, per-request cost guards, atomic budget reservation/reconciliation, and global daily/monthly ceilings are enforced for model and search calls.
- [ ] Runtime error reporting, sanitized operational logs, spend visibility, and minimal product analytics are working in the deployed environment.
- [ ] Effective provider and search privacy settings have been verified; user disclosure and retention rules are documented.
- [ ] Welcome/help copy matches the actual text + web capabilities.
- [ ] Production-like end-to-end tests pass, CI is green, and rollback/AI-disable steps are documented.

## After the MVP

Prioritize these only from pilot evidence or a concrete requirement:

- Image/vision input.
- A stronger text route if evaluation demonstrates a quality gap.
- Voice, documents, and other input modalities.
- Long-term memory or user preferences.
- A dashboard, separate workers, Redis/BullMQ, or other infrastructure when operational needs justify them.

## Working rules

- This roadmap is the source of truth for MVP scope and sequencing; feature specs remain the source of truth for each implementation.
- Keep PRs small and aligned to one coherent feature.
- Update status only when code, tests, and documentation support it.
- Do not weaken CI to get a PR green.
- Optimize for reliable learning from first users, not hypothetical scale.
