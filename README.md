# Sofi — Development Environment

Sofi is an AI assistant for Viber. This repository bootstraps the local development environment and keeps it aligned with the planned Railway deployment.

## Project knowledge

Before making non-trivial changes, read:

- [Agent instructions](AGENTS.md)
- [Product context](docs/product.md)
- [Architecture](docs/architecture.md)
- [MVP roadmap and release gates](docs/roadmap.md)
- [Pre-release test cases, rubric, and pilot evaluation](docs/testing/README.md)
- [Architecture decisions](docs/decisions/)

These documents are the repository source of truth for product and engineering context. Keep them factual and current; `docs/roadmap.md` is the source of truth for first-MVP scope, sequencing, and release gates.

## Stack

- Node.js 24 LTS
- TypeScript
- Fastify
- Pino
- Zod
- Vitest
- ESLint + Prettier
- Docker Compose for local PostgreSQL
- Dockerfile for production / Railway
- GitHub Actions CI

PostgreSQL is used for application persistence and the durable conversation job queue. The local database runs through Docker Compose; production uses Railway PostgreSQL via DATABASE_URL.

## Requirements

- Node.js 24 LTS
- npm 11+
- Docker Desktop / Docker Engine with Compose

## Local development

Install dependencies:

```bash
npm install
```

Start PostgreSQL:

```bash
docker compose up -d postgres
```

Create local environment:

```bash
cp .env.example .env
```

Start the application:

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{ "status": "ok" }
```

When a database is configured, the health endpoint performs a lightweight PostgreSQL readiness check. If PostgreSQL is unavailable, it returns HTTP 503.

Stop PostgreSQL:

```bash
docker compose down
```

Remove the local database volume as well:

```bash
docker compose down -v
```

## Available commands

```bash
npm run dev
npm run build
npm start
npm run typecheck
npm run lint
npm run lint:fix
npm run format
npm run format:fix
npm run format:check
npm run check
npm test
npm run test:watch
npm run db:migrate
```

## Git hooks

Running `npm install` configures the repository to use the committed `.githooks/pre-commit` hook. Before each commit it automatically runs Prettier and ESLint with `--fix` on staged files and stages the fixes. If a file has both staged and unstaged changes, the hook stops to avoid accidentally staging unrelated edits.

The CI pipeline remains check-only: it verifies formatting and linting but does not modify the branch.

## Project structure

```text
src/
  config/
    env.ts
  app.ts
  app.test.ts
  server.ts
```

The structure grows by feature in subsequent PRs. Avoid creating infrastructure abstractions before they are needed by an actual feature.

## Docker

The root `Dockerfile` builds the application as a multi-stage production image.

Build locally:

```bash
docker build -t sofi-ai .
```

Run locally with an environment file:

```bash
docker run --rm --env-file .env -p 3000:3000 sofi-ai
```

The application listens on `0.0.0.0` and uses the `PORT` environment variable, which makes it compatible with Railway's runtime environment.

## CI

GitHub Actions runs on pushes to `main` and pull requests.

It verifies:

1. dependencies install successfully
2. TypeScript type-checks
3. ESLint passes
4. Prettier formatting is clean
5. tests pass
6. production TypeScript build succeeds
7. production Docker image builds successfully

## Railway

The intended production setup is:

```text
GitHub repository
       ↓
Railway application service
       ↓
root Dockerfile
       ↓
Sofi Node.js application

Railway PostgreSQL
       ↓
DATABASE_URL
       ↓
Sofi application
```

Railway should use the repository's root `Dockerfile`. Runtime secrets and configuration are supplied through Railway environment variables.

Expected application variables include:

```text
NODE_ENV=production
PORT=<provided by Railway>
HOST=0.0.0.0
DATABASE_URL=\${{Postgres.DATABASE_URL}}
REORDER_DELAY_MS=1000
MESSAGE_DEBOUNCE_MS=5000
VIBER_AUTH_TOKEN=...
AI_ENABLED=true
OPENROUTER_API_KEY=...
AI_MODEL_CHEAP_TEXT=google/gemma-3-4b-it
AI_MAX_OUTPUT_TOKENS=512
AI_REQUEST_TIMEOUT_MS=30000
AI_USAGE_PRICING_MODEL=google/gemma-3-4b-it
AI_USAGE_INPUT_PRICE_PER_MILLION_USD=0.05
AI_USAGE_OUTPUT_PRICE_PER_MILLION_USD=0.1
AI_USER_DAILY_REQUEST_LIMIT=50
AI_USER_DAILY_BUDGET_USD=0.2
AI_GLOBAL_DAILY_BUDGET_USD=2
AI_GLOBAL_MONTHLY_BUDGET_USD=30
AI_ECONOMY_THRESHOLD_PERCENT=80
AI_ECONOMY_MAX_OUTPUT_TOKENS=256
```

In production, `DATABASE_URL` is required during configuration parsing. `OPENROUTER_API_KEY` is also required when `AI_ENABLED=true`. Set `AI_ENABLED=false` to disable generation; the debounce handler sends a localized temporary-unavailable response. The application runs database migrations before starting the HTTP server, and the `/health` endpoint verifies PostgreSQL readiness.

## Implemented

The repository already includes:

- Viber webhook validation and event processing
- PostgreSQL schema and migrations
- PostgreSQL-backed background jobs
- message ordering and configurable 5-second text debounce; `/reset` and `/forget` bypass the debounce delay
- OpenRouter-backed AI text responses with localized failure handling
- sanitized OpenRouter error diagnostics
- localized responses
- production Docker image
- Railway-compatible runtime configuration

## Deliberately deferred

The first external MVP is text + bounded multi-turn context + web search; see [docs/roadmap.md](docs/roadmap.md) for work still required before launch.

The first MVP does not include image/vision input, audio, video, or document processing. It also does not introduce:

- Redis
- BullMQ
- S3/object storage
- separate worker services
- Kubernetes
- admin dashboard

These should be added only when a concrete product or operational requirement justifies them.
