# Sofi MVP Roadmap

**Status:** agreed product and engineering plan  
**Updated:** 2026-10-14  
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
- Sanitized OpenRouter HTTP and embedded provider-error diagnostics, including response shape, typed provider codes, and retry hints.
- Automated tests for routing, mocked OpenRouter responses, debounce, and core integration behavior.
- Railway-oriented deployment, database migrations/readiness checks, Docker build, and CI.

WP1 adds persisted assistant history, bounded multi-turn context, a localized reset, and durable turn/reply delivery recovery; see the [feature specification](features/multi-turn-context-and-durable-delivery.md). WP2 adds content-free per-attempt accounting, PostgreSQL atomic reservations/reconciliation, per-user and global budget limits, a per-request cost guard, economy mode, and reason-specific localized denials for the current `cheap_text` route; see [usage accounting and cost controls](features/usage-accounting-and-cost-controls.md). WP3's model-invoked OpenRouter search integration and URL citations are implemented. This branch pins search to Parallel Fast (`engine: parallel`, `mode: fast`), sets medium context, 5 results per search / 10 total, and caps search/tool calls at 2; live pre-launch search-quality, billing, and privacy validation remain outstanding. Sofi does not automatically fall back to Exa or native search when Parallel is unavailable. WP4 production observability and product analytics/alerting remain outstanding. Search must not be enabled for external users until separately billed tool costs are safely guarded and provider/search privacy and billing have been verified. Viber delivery cannot be guaranteed exactly once when a send outcome is ambiguous.

## Next recommended moves — start here

The durable context and usage-accounting foundations (WP1/WP2) are already on the current main branch. Do not restart those work packages by default; verify them as part of the release checks below and reopen implementation only if a test exposes a gap. The remaining launch blockers should be closed in this order:

1. **Finish WP3 web-search acceptance (P0).**
   - Test representative Russian and Belarusian current-information queries, confirm useful source titles/URLs, and verify that Sofi never claims to have searched when no search was performed.
   - Exercise Parallel availability/errors, bounded search limits, and budget-denied cases; confirm failures do not trigger a cross-engine retry.
   - Compare usage-ledger search-cost estimates with actual OpenRouter billing and adjust conservative configuration as needed.
   - Keep `AI_WEB_SEARCH_ENABLED=false` in Railway for external users until search acceptance, cost accounting, and privacy checks pass.

2. **Make WP4 operational visibility real (P0).**
   - Trigger a test exception and verify it arrives in the configured error-reporting system; a DSN alone is not sufficient.
   - Confirm sanitized signals cover route/model, success/failure, latency/timeouts, fallback/search use, Viber delivery outcomes, cost, and budget denials.
   - Add a practical alert/response procedure for elevated failures, delivery problems, and spend approaching limits. Keep analytics content-free and define retention.

3. **Close WP5 user copy, privacy, and production setup (P0).**
   - Review every supported locale's welcome/help text: promise only text and web capabilities, provide a few example prompts, and make `/reset`/`/forget` discoverable. Do not promise photo or document processing.
   - Verify the effective OpenRouter provider and web-search data-handling settings separately; document the user's external AI processing disclosure and content-retention behavior.
   - Configure an OpenRouter account-level spend cap, verify database backup/restore expectations, and document how to disable AI and roll back safely.

4. **Run the production-like end-to-end release gate (P0).**
   - Use synthetic content with production-like Viber, PostgreSQL, model, and search configuration.
   - Cover multi-turn follow-ups, reset/forget, duplicate webhooks, restart/recovery, search citations, provider failures, timeouts, budget exhaustion, uncertain provider outcomes, and Viber delivery failures.
   - Pass the repository's full checks and Docker build. Do not enable the pilot if any release gate below is unchecked.

This order is intended to get the existing MVP safely in front of users quickly, not to add more infrastructure or new modalities before the current scope is validated.

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

### WP3 — Model-invoked web search and bounded fallbacks

**Priority:** P0 — Parallel Fast request policy being finalized; live acceptance remains a release blocker

- Keep all model calls behind the internal AI Router; business logic must not depend on OpenRouter request/response types.
- Keep `cheap_text` configurable for normal chat and make model-invoked web search available through the same route; do not force a separate search route for each request.
- [x] Make OpenRouter's `openrouter:web_search` server tool available on normal text requests so the model can choose when current information is needed; avoid unnecessary searches for ordinary writing and explanations.
- [x] Pin Sofi search requests to Parallel Fast (`engine: parallel`, `mode: fast`) rather than OpenRouter `auto` routing to native search or Exa. Fast-mode Russian/Belarusian quality still requires manual validation.
- [x] Cap results and reserve/reconcile separately billed search costs through the shared budget guard.
- [x] Preserve and render validated OpenRouter URL-citation annotations as source titles/URLs when those links are not already in answer text; retain the explicit instruction never to claim a search that did not occur.
   - [ ] Manually verify useful citations and truthful search claims with representative Russian and Belarusian current-information queries.
- [x] Keep search calls/results bounded and include estimated search-tool charges in the shared budget guard.
- Keep generation retries bounded. Do not add cross-engine search fallback: if Parallel is unavailable, use existing failure handling rather than silently switching to native search or Exa.
- Avoid retrying non-transient failures blindly; prevent retry loops and unnecessary duplicate generation.
- Add mocked contract/integration tests for search results, source-link formatting, route selection, tool/model incompatibility, provider failures, fallbacks, and cost-limit interactions.
- [ ] Verify effective provider/search privacy and data handling before rollout; do not assume every model/provider supports web search.

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

## Invited pilot and learning plan

Start the pilot only after every release gate above is satisfied. A practical starting point is **15–25 invited users for 1–2 weeks**; treat the cohort size and duration as an initial experiment, not as a product requirement.

- Ask participants to use Sofi for real everyday tasks rather than only following scripted examples.
- Before inviting users, write down what results would justify continuing, fixing reliability, or pausing rollout. Avoid deciding success only after seeing the results.
- Review first successful request, returning users and D1/D7 retention, follow-up rate, task categories (write/rewrite/explain/ideas/web/other), search usage, failure rate, response latency, and AI cost per active user.
- Talk to participants who stop using Sofi as well as those who return. Find the specific jobs they tried, what failed, and what would make them use it again.
- Keep analytics privacy-conscious: use event and cost metadata, not full prompts or completions. Handle any direct user feedback under the documented retention/privacy rules.
- Use pilot evidence to choose the next product investment. Do not start image, voice, document, long-term-memory, dashboard, or infrastructure work merely because it is technically possible.

**Pilot exit decision:** summarize findings, reliability/cost risks, the strongest repeated use cases, and a prioritized next backlog item before broadening access.

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
