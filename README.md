# Sofi — Development Environment

Sofi is an AI assistant for Viber. This repository bootstraps the local development environment and keeps it aligned with the planned Railway deployment.

## Project knowledge

Before making non-trivial changes, read:

- [Agent instructions](AGENTS.md)
- [Product context](docs/product.md)
- [Architecture](docs/architecture.md)
- [Architecture decisions](docs/decisions/)

These documents are the repository source of truth for product and engineering context. They are intentionally initial versions and should evolve with the project.

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
npm run format
npm run format:check
npm test
npm run test:watch
npm run db:migrate
```

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

Railway PostgreSQL should be added as a managed service and its DATABASE_URL should be made available to the application service.
```

Railway should use the repository's root `Dockerfile`. Runtime secrets and configuration are supplied through Railway environment variables.

Expected application variables include:

```text
NODE_ENV=production
PORT=<provided by Railway>
HOST=0.0.0.0
VIBER_AUTH_TOKEN=...
OPENROUTER_API_KEY=...
SENTRY_DSN=...
```

`DATABASE_URL` will be added when the PostgreSQL application layer is introduced.

## Deliberately deferred

This bootstrap does not implement:

- Viber API/webhook logic
- PostgreSQL schema or ORM
- database migrations
- OpenRouter integration
- AI routing
- background jobs
- Redis
- BullMQ
- S3/object storage
- Sentry integration
- admin dashboard
- analytics
- rate limiting

Those are introduced in focused follow-up PRs as the corresponding application features are implemented.
