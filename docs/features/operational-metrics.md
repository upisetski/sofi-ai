# Feature: Protected operational metrics

## Goal

Give operators a quick, content-free view of AI reliability, delivery state, cost exposure, and returning use without requiring a dashboard or direct access to user conversations.

## User behavior

This is an operator-only endpoint, not a user-facing Viber feature. When enabled, an authorized operator can request aggregate metrics from the running application.

## Scope

### In scope

- A bearer-token-protected `GET /ops/metrics` endpoint.
- An endpoint that remains undiscoverable when its token is not configured.
- Aggregate AI request counts, success/failure counts, p95 latency, provider-reported and estimated cost separately, outstanding reservation exposure, and unknown-cost attempts for the last 24 hours and 7 days.
- Aggregate reply generation/delivery/failure/pending counts and active/returning-user counts.
- Consistent `LOG_LEVEL` configuration for Fastify logs.

### Out of scope

- User IDs, prompts, completions, message contents, provider payloads, or per-user analytics.
- A dashboard, separate analytics database, external service, or intent classifier.
- Alert delivery, Sentry SDK integration, and live-provider verification; these remain separate WP4/release tasks.

## Requirements

- Require a configured token and compare equal-length credentials using a timing-safe comparison.
- Do not query the database for unauthenticated requests.
- Return aggregate data only; never include conversation or user identifiers.
- Report provider-reported costs, rate-based estimated costs, and outstanding reserved exposure separately; unknown costs remain separately countable.
- Return a generic unavailable response on database errors without exposing internal details.
- Use the existing PostgreSQL tables; do not add an analytics persistence model.

## Acceptance criteria

- [x] The endpoint returns 404 when its token is not configured.
- [x] Unauthorized requests return 401 and do not query PostgreSQL.
- [x] Authorized requests return aggregate metrics for 24-hour and 7-day windows.
- [x] The metrics exclude content and user/conversation identifiers.
- [x] Database failures return a generic 503 response and are logged server-side.
- [x] `OPS_METRICS_TOKEN` is optional, but when set must be at least 32 characters.
- [x] `LOG_LEVEL` configures Fastify logging.

## Technical notes

Metrics are computed on demand from `ai_usage_attempts` and `conversation_turns`. Active users are users with a chat turn in the time window; returning users are active in the last 7 days with at least one retained chat turn older than 7 days. Turn history and usage rows follow the existing retention policies, so returning-user metrics cover retained history only.

## Data and privacy

The response contains counts and aggregate costs/latency only. The bearer token is not returned or logged. No user message content, IDs, prompt text, completion text, or search content is stored or transmitted by this endpoint.

## Observability

Database failures are logged through Fastify's structured logger. The endpoint exposes recent AI reliability/cost indicators and reply delivery status without creating new persistent analytics data. A separate error-reporting integration and alerting policy remain outstanding.

## Testing

- Unit/integration: endpoint disabled, unauthorized token, authorized aggregate response, database failure.
- Configuration: optional token behavior and minimum length; log-level wiring.
- Privacy: response contains no message content or user/conversation identifiers.

## Dependencies

- Existing PostgreSQL usage ledger and durable conversation-turn tables.

## Open questions

- Which external error-reporting service and alert destinations should be enabled for the invited pilot?

## Implementation checklist

- [x] Implementation complete
- [x] Tests added or updated
- [x] Documentation updated where needed
- [ ] ADR added if a significant architectural decision was made
- [x] CI checks pass
- [x] Focused PR opened
