# ADR 0009: Native-first OpenRouter web search

- **Status:** Proposed in PR
- **Date:** 2026-10-13

## Context

Sofi needs current web information, but a separate search client and client-managed tool loop would add code and operational complexity. OpenRouter exposes a server-side search tool that lets the model choose whether to search and reports the number of search requests in usage metadata.

## Decision

Use `openrouter:web_search` on normal text requests when enabled. Default to `engine: auto`, which uses native provider search on supported endpoints and falls back to Exa when native search is unsupported. Bound results and search context. Reserve a configurable maximum search cost before generation and reconcile reported search-request counts with a conservative configured estimate.

## Consequences

- Ordinary requests can decide not to search, avoiding unnecessary tool calls.
- Native search behavior depends on the selected provider endpoint; the same model may use native search or Exa depending on routing.
- Search costs are estimated separately from model-token costs because native provider pricing is pass-through and may vary. Operators must compare ledger estimates with actual billing.
- The documented `auto` fallback is not a guaranteed runtime retry after a search execution error.
- Russian and Belarusian quality and effective data handling remain launch validation items.
- OpenRouter server tools are beta; the integration may need updating if the contract changes.

## Alternatives considered

- Always invoke a search plugin: rejected because it searches even when unnecessary.
- Build a custom search-provider integration: deferred because the server tool already supplies search and the current MVP favors a small implementation.
- Pin Exa for every request: rejected because it prevents native-first behavior.
