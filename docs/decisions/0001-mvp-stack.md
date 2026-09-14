# ADR 0001: MVP stack

## Status

Accepted

## Decision

Use:
- Node.js 24
- TypeScript
- Fastify
- PostgreSQL
- OpenRouter
- Pino
- Sentry
- Docker
- Railway

## Why

The project currently has no validated scale. The stack minimizes operational overhead while providing typed backend development, webhook handling, durable relational storage, flexible AI routing, basic observability, and easy deployment.

## Rejected for now

- NestJS: additional framework structure is not necessary at current size.
- Redis: no concrete need yet.
- BullMQ: PostgreSQL-backed jobs are sufficient initially.
- Kubernetes: unnecessary complexity.
- microservices: no scaling or ownership boundary justifies them.
- ClickHouse/Kafka: no event volume requires them.
