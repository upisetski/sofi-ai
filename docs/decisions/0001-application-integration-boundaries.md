# ADR 0001: Application and integration boundaries

## Status

Accepted

## Context

The Viber webhook is an external transport boundary, while product behavior such as welcome-message selection is business logic. Mixing the two makes handlers hard to test and couples product behavior to Viber's HTTP protocol.

## Decision

Sofi uses a small layered boundary:

- `src/integrations/` owns external protocols and provider I/O.
- `src/application/` owns business use cases and orchestration.
- `src/localization/` owns supported locales, fallback rules, and translated user-facing copy.
- `src/domain/` is reserved for reusable business rules when complexity justifies it.

Webhook handlers must validate and translate external input, call an application use case, and return the transport-level acknowledgement. They must not contain product rules or translated copy.

## Consequences

- Business behavior can be tested without Fastify or provider HTTP details.
- Provider integrations can change without moving product logic.
- Localization changes do not require editing transport handlers.
- The project gains a small amount of structure, but no new framework or infrastructure is required.

## Rejected alternative

Keeping business decisions directly in each webhook/provider handler was rejected because it couples product behavior to transport details and encourages duplicated logic.
