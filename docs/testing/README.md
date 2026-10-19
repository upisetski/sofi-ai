# Sofi pre-release evaluation

These documents define how to validate Sofi before the first external users and how to learn from an invited pilot.

## Documents

- [Pre-release test cases](pre-release-test-cases.md) — reproducible functional, search, context, reliability, cost, privacy, safety, and deployment scenarios.
- [Evaluation rubric](evaluation-rubric.md) — anchored scoring dimensions, critical-failure rules, and proposed go/no-go thresholds.
- [Pilot evaluation plan](pilot-evaluation-plan.md) — execution phases, evidence to collect, pilot questions, metrics, and rollout decisions.

## Source of truth and scope

The [MVP roadmap](../roadmap.md) defines release scope and mandatory release gates. The [product context](../product.md), [architecture](../architecture.md), and relevant feature specifications define expected behavior. These test documents do not mark a roadmap gate complete merely because a test case has been written.

The first external MVP supports text, bounded multi-turn context, and web search. Image, audio, video, and document processing are out of scope. Use synthetic content for technical tests and staging; do not put real users' private messages into a test corpus.

## Important environment note

The current configuration schema defaults web search to enabled, while the roadmap says production search must remain disabled until search-quality, billing, and privacy acceptance is complete. Explicitly set **AI_WEB_SEARCH_ENABLED=false** in the deployed environment until the web-search release gate is signed off. Do not rely on a code default as the release switch.

## Status convention

- **Not run** — no evidence yet.
- **Pass** — expected behavior was observed and evidence was recorded.
- **Fail** — expected behavior did not occur.
- **Blocked** — the test could not be completed because a dependency, permission, or environment was unavailable.
- **Not applicable** — explain why the case does not apply to this build.

Every release-critical case needs a result, evidence reference, tester, environment/build, and date. A blocked or not-run P0 case is not a pass.
