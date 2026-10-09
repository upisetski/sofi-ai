# Feature: AI response generation via OpenRouter

## Goal

Replace the temporary post-debounce text echo with a real AI-generated response while preserving the existing Viber webhook, PostgreSQL persistence, and debounce flow.

The first AI implementation should be deliberately small and verifiable:

    Viber
      -> durable event
      -> debounce
      -> ConversationWorker
      -> internal AI Router
      -> OpenRouter
      -> configured small text model
      -> Viber response

The initial production/default model is `google/gemma-3-4b-it`, subject to the configured OpenRouter provider being Zero Data Retention (ZDR).

## User behavior

After a text-message burst has been debounced, Sofi sends the burst to the AI layer and returns one generated response to the user.

The existing debounce behavior remains unchanged:
- rapid text messages are collected into one processing unit;
- Sofi does not answer immediately after the first message;
- the latest message extends the debounce deadline.

The temporary localized "Думаю над вашим вопросом" echo is removed and replaced by the generated answer.

The first implementation handles text bursts only.

## Scope

### In scope

- Internal AI Router application abstraction.
- OpenRouter integration behind the application abstraction.
- Configurable model selection with `cheap_text` as the initial route.
- `google/gemma-3-4b-it` as the initial default model.
- Request-level ZDR/privacy restrictions when calling OpenRouter.
- Construction of a small system instruction that keeps Sofi clearly AI, concise, helpful, and replies in the user's language.
- Sending one generated response through the existing Viber client.
- Normalized handling of successful OpenRouter responses.
- Explicit handling and observability of OpenRouter request/response errors.
- Unit and integration-style tests using mocked HTTP rather than real OpenRouter traffic.
- Configuration through environment/runtime configuration rather than hard-coded secrets.

### Out of scope

- Jev or another AI-based intent/router classifier.
- Automatic model selection based on semantic intent.
- OpenRouter web search or other tools.
- Vision/image processing.
- Multi-turn conversation memory beyond the current processed burst.
- Assistant-message persistence required for long-term conversational context.
- Automatic provider fallback.
- Automatic retry/backoff policy for AI requests.
- Circuit breakers or provider health scoring.
- Additional direct model-provider integrations.
- Streaming responses.
- Changes to debounce timing or event ordering.

## Requirements

- All AI calls must go through the internal AI Router abstraction.
- Application/business logic must not depend directly on OpenRouter-specific request or response formats.
- The OpenRouter API key must come from environment/runtime configuration and must never be committed to the repository.
- The OpenRouter request must request ZDR-compatible handling using provider/privacy controls supported by the gateway.
- The application must not log full user message content, prompts, images, or credentials.
- The initial route must be configuration-driven:
  - `cheap_text` -> configured initial model.
- The initial text-generation request must include the current debounced user messages and the user's resolved locale/language when available.
- The response sent to Viber must contain only the generated assistant text, not raw provider metadata.
- A successful provider response must result in at most one outbound Viber response for the processed burst.
- Provider/API failures must be represented as application-level errors and be observable without exposing provider secrets or full user content.
- The feature must not require a live OpenRouter API key in automated CI.
- Existing debounce and durable-event behavior must remain unchanged.

## Acceptance criteria

- [x] A debounced text burst is sent to the internal AI Router instead of the temporary echo handler.
- [x] The AI Router resolves the `cheap_text` route from configuration.
- [x] The OpenRouter integration sends the configured model and ZDR/privacy provider controls.
- [x] The OpenRouter API key is read from environment configuration only.
- [x] A successful provider response is converted into one Viber text response.
- [x] The user-facing response is not the old localized echo.
- [x] The request contains the debounced burst and locale/language context.
- [x] Provider errors do not expose API keys, raw request headers, or full user content in logs/errors.
- [x] Automated tests do not require network access or OpenRouter credentials.
- [x] Existing debounce tests still pass without changing debounce timing/semantics.
- [x] The feature can be disabled or reconfigured by changing runtime configuration rather than source-code business logic.
- [x] Full project checks pass.

## Implemented limits and failure behavior

- `AI_ENABLED` defaults to `true`; production requires `OPENROUTER_API_KEY` when AI is enabled. Disabling AI keeps the debounce path intact and sends a localized temporary-unavailable response.
- `AI_MODEL_CHEAP_TEXT` defaults to `google/gemma-3-4b-it`. `AI_MAX_OUTPUT_TOKENS` defaults to `512` and accepts values from 1 through 8192. `AI_REQUEST_TIMEOUT_MS` defaults to `30000` and accepts values from 1000 through 120000.
- The combined burst sent to the model is bounded to 12000 characters. If it exceeds that limit, the request preserves the beginning of the burst in order and marks the omitted remainder. Normal-sized bursts are passed as separate ordered user messages.
- OpenRouter requests set `provider.zdr: true`, `provider.data_collection: "deny"`, and `provider.allow_fallbacks: false`. No prompt, user text, API key, authorization header, or raw provider response body is written to logs.
- Successful usage and cost metadata is logged when the provider returns it; it is not persisted to a usage table in this feature.
- The worker completes the database job before generating and sending the outbound response. A generation failure is logged with safe metadata and produces a localized temporary-error message instead of an echo. This PR adds no retry: if Viber delivery also fails, the completed job is not retried and the response can be lost.

### Cost-control gap before public rollout

The current application does not enforce the per-user daily USD budget, per-user request limits, per-request maximum cost guard, global daily/monthly budgets, or economy mode described as planned architecture safeguards. Input-size and output-token caps limit individual requests but do not cap aggregate spend. Cost metadata is logged when available, not reserved or reconciled in PostgreSQL. Implement and verify those budgets before wider public rollout.

## Technical notes

### Application flow

Keep the current processing boundaries intact:

    ConversationWorker
        |
        +--> processConversation()
        |
        +--> AI response handler
                 |
                 +--> AI Router
                        |
                        +--> OpenRouter integration
                               |
                               +--> OpenRouter API

The webhook must remain thin and must not perform AI work.

The AI Router should expose a provider-neutral interface similar to:

    generate({
      route,
      messages,
      language,
    })

The Router owns route-to-model configuration. The OpenRouter integration owns HTTP/API details.

### Initial route

Only `cheap_text` is required for this feature.

Example configuration concept:

    cheap_text -> google/gemma-3-4b-it

The exact model remains configuration rather than application business logic.

### Prompting

The initial prompt should be minimal and deterministic. It should communicate:
- Sofi is an AI assistant.
- Answer in the user's language when known.
- Be concise and useful.
- Treat the current burst as the user's current request.

Do not add a large personality prompt or complex intent taxonomy in this feature.

### ZDR

The OpenRouter request must explicitly use provider/privacy controls that require ZDR-compatible handling.

Model selection alone must not be treated as proof of ZDR. The effective provider configuration must enforce the privacy requirement.

### Errors

This feature defines error normalization and observability, but intentionally does not define an automatic retry/fallback strategy.

The first implementation should fail predictably on provider errors. Automatic retry, backoff, fallback providers, and provider health logic belong to a follow-up reliability feature.

## Data and privacy

User text is transmitted to OpenRouter only when the debounced burst reaches the AI processing stage.

No new persistent table is required by this feature.

Do not add user content to ordinary logs. In particular, do not log:
- complete prompts;
- full provider responses;
- Viber message text;
- API keys or authorization headers.

Provider/model identifiers, latency, request success/failure, and token/cost metadata may be logged or stored when available and when consistent with existing cost/observability design.

The OpenRouter request should require ZDR/privacy-compatible routing.

No images are transmitted by this feature.

## Observability

Relevant operational signals:
- AI route;
- model identifier;
- provider response status/category;
- request latency;
- success/failure;
- token usage and cost metadata when returned by the provider.

Do not log full request/response content.

Errors should be distinguishable at least as:
- configuration error;
- provider HTTP/API error;
- malformed provider response;
- timeout/network error.

## Testing

### Unit

- AI Router maps `cheap_text` to the configured model.
- AI Router does not expose OpenRouter-specific types to callers.
- Prompt/message construction preserves the burst and locale.
- OpenRouter client builds the expected request body, including ZDR/privacy provider controls.
- OpenRouter client parses a successful response into the normalized application result.
- OpenRouter client converts non-success and malformed responses into normalized application errors.
- Sensitive data is not included in normalized/loggable error information.

### Integration

Use mocked `fetch`/HTTP responses; do not call OpenRouter from automated tests.

Cover the application path around the existing worker and handler:
- a ready debounce job causes one AI call and one Viber response;
- multiple messages in the burst are sent together;
- the locale reaches the AI request;
- an AI provider failure produces no fabricated user answer and is observable;
- existing debounce scheduling and durable event behavior are unchanged.

Database-backed tests may use the existing PostgreSQL integration-test setup. They must not require external AI credentials.

### Contract / HTTP fixture tests

The OpenRouter client should be tested against representative success/error payload fixtures based on the documented API contract. These are local fixtures, not live external calls.

### E2E / manual

A manual smoke test may use a real OpenRouter key and a configured ZDR-compatible endpoint after the PR is merged, but this must not be a CI requirement.

### Retry / fallback testing

Not part of this feature.

A future reliability feature should introduce explicit tests for:
- transient 429/5xx retry;
- timeout retry;
- backoff;
- provider fallback;
- exhaustion behavior;
- duplicate-response prevention after recovery.

Those tests should be added together with the corresponding production behavior instead of being simulated prematurely in this feature.

## Dependencies

- Existing Viber webhook and PostgreSQL conversation processing.
- Existing `ConversationWorker`.
- Existing Viber text-message client.
- OpenRouter API key.
- OpenRouter access to the configured initial model/provider.
- Existing environment configuration.

## Open questions

- Exact per-request token/cost limits will be finalized together with the existing cost-control implementation.
- Assistant-message persistence for multi-turn context will be designed separately.
- Web search and semantic routing will be designed separately after the basic AI path is proven.

## Implementation checklist

- [ ] Implementation complete
- [ ] Tests added or updated
- [ ] Documentation updated where needed
- [ ] ADR added if a significant architectural decision was made
- [ ] Full local checks pass
- [ ] Focused PR opened
