# Agent Instructions

## Mission

Sofi is an AI assistant for Viber. The repository is an MVP and should remain intentionally simple while we learn from real user behavior.

The primary engineering goal is to ship small, verifiable increments quickly without building infrastructure for hypothetical scale.

## Product context

Sofi's launch interaction is:

> Send it to Sofi. We'll figure it out.

Initial capabilities:
- text input
- image input
- web search when current information is required

Not in the initial MVP:
- audio
- video
- document processing

Sofi should feel warm, competent, concise, approachable, and clearly AI — not like a human pretending to be one.

## Current stack

- Node.js 24 LTS
- TypeScript
- Fastify
- PostgreSQL
- OpenRouter
- Pino
- Sentry
- Vitest
- ESLint
- Prettier
- Docker / Docker Compose
- Railway for deployment

Current MVP deliberately does not use Redis, BullMQ, S3, Kubernetes, Kafka, microservices, or a separate admin frontend.

Do not introduce new infrastructure unless a concrete requirement or measured bottleneck justifies it.

## Development workflow

For non-trivial work:

1. Read `AGENTS.md`, `docs/product.md`, and `docs/architecture.md`.
2. Inspect the existing implementation before making assumptions.
3. Keep the change narrowly scoped to the requested issue.
4. Prefer a small implementation over speculative abstraction.
5. Add or update tests for behavior that changed.
6. Run the full local checks:
   - `npm run typecheck`
   - `npm run lint`
   - `npm run format:check`
   - `npm test`
   - `npm run build`
   - `docker build -t sofi-ai:ci .`
7. Create a focused branch and PR.
8. Do not merge unless CI passes.

## Code quality

- TypeScript strict mode is required.
- Validate external inputs at system boundaries.
- Prefer small, focused modules.
- Keep business logic separate from provider-specific API code.
- Do not put secrets in source control.
- Do not log full user messages, images, or credentials.
- Do not invent external API behavior. Verify integration contracts before coding.
- Preserve backward compatibility unless the issue explicitly requires a breaking change.

## AI architecture

All AI provider calls go through the internal AI Router.

Application code should not hard-code a specific model/provider in business logic.

Use route classes such as:
- `cheap_text`
- `strong_text`
- `vision`
- `web`

## Data and privacy

Minimize personal data.

At launch:
- keep Viber user ID as the stable external identifier
- do not persist avatars unless a concrete feature needs them
- keep message history only as long as required by product/debugging needs
- process images temporarily and avoid permanent storage unless required
- do not put complete user content into ordinary application logs

## Cost controls

Sofi is free, so runaway AI spend is a first-class concern.

The architecture includes:
- per-user daily USD budget
- per-user request limits
- per-request cost guard
- global daily/monthly budget
- economy mode

Do not bypass these controls for a new AI feature. Extend them as part of the feature.

## Testing and CI

CI is the merge gate.

A change is not complete until:
- typecheck passes
- lint passes
- formatting passes
- tests pass
- production build passes
- Docker image builds

Do not weaken CI just to make a PR green.

## Documentation

Update documentation when a durable product or architecture decision changes.

Use ADRs in `docs/decisions/` for decisions that are likely to matter later.

Keep documentation factual and current. Do not document hypothetical systems as if they already exist.

## Scope discipline

If a proposed change seems to require a new queue, cache, service, provider, database, or framework, first ask whether the current scale actually requires it.

Prefer:
> simplest thing that works and can be replaced later

over:
> infrastructure for a future we do not yet know exists
