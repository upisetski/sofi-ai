# ADR 0003: OpenRouter as initial AI gateway

## Status

Accepted

## Decision

Use OpenRouter as the initial gateway for model and provider access.

## Why

The product needs to experiment with inexpensive text models, stronger text models, vision models, and web search. A gateway makes model/provider changes easier without changing product logic.

## Constraint

Application code should depend on an internal AI Router abstraction, not directly on OpenRouter-specific details.

## Future

Direct provider integrations may be added if cost, reliability, data policy, or feature requirements justify bypassing the gateway.
