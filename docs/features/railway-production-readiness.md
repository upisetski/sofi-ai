# Feature: Railway production readiness

## Goal

Make the application fail clearly when required production configuration is missing and expose a health endpoint that verifies PostgreSQL readiness.

## User behavior

Railway can determine whether a newly started Sofi instance is ready to receive webhook traffic.

## Scope

### In scope

- Require `DATABASE_URL` when `NODE_ENV=production`.
- Check PostgreSQL connectivity from `GET /health` when a database is configured.
- Return HTTP 503 when the database readiness check fails.

### Out of scope

- Sentry integration.
- Separate liveness and readiness endpoints.
- Additional production infrastructure.

## Requirements

- Production startup must reject missing `DATABASE_URL`.
- A successful database readiness check must return HTTP 200.
- A failed database readiness check must return HTTP 503.
- Development and test environments may run without `DATABASE_URL` for unit-only checks.

## Acceptance criteria

- [ ] Missing `DATABASE_URL` causes production configuration parsing to fail.
- [ ] `GET /health` returns 200 when PostgreSQL is reachable.
- [ ] `GET /health` returns 503 when PostgreSQL is unavailable.
- [ ] Existing webhook behavior remains unchanged.

## Technical notes

The readiness check uses a lightweight `SELECT 1` query through the existing PostgreSQL pool. No new infrastructure or health-check service is introduced.

## Data and privacy

The health endpoint does not expose database content or user data. Database connection errors are logged through the existing structured logger without returning internal details to the client.

## Observability

- Log database readiness failures through Fastify's structured logger.
- Return a machine-readable `status` field.

## Testing

- Unit: production environment validation.
- Integration: health endpoint with a reachable database abstraction.
- Edge cases: database query failure returns HTTP 503.

## Dependencies

- Existing PostgreSQL connection pool.

## Open questions

- None.

## Implementation checklist

- [x] Implementation complete
- [x] Tests added or updated
- [x] Documentation updated where needed
- [x] ADR added if a significant architectural decision was made
- [ ] Full local checks pass
- [x] Focused PR opened
