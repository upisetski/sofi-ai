# Feature: Localized Viber welcome message

## Goal

Send Sofi's localized welcome message when a user opens a one-to-one conversation with the Viber bot.

## User behavior

When Viber sends a `conversation_started` callback, Sofi sends a welcome text to the user using the language reported by Viber. The Viber sender name is localized together with the welcome copy.

Supported languages:

- `ru` — sender `Софи - AI-помощница`
- `be` — sender `Сафі - AI-памочніца`
- `en` — sender `Sofi - AI assistant`

Unknown or missing languages fall back to Russian.

## Scope

### In scope

- Handle Viber `conversation_started` in the application layer.
- Select localized sender name and welcome message using `user.language`.
- Send the message through the Viber integration client.
- Keep all user-facing welcome copy and sender names in localization files.
- Keep the webhook thin: validate, invoke the use case, acknowledge the callback.

### Out of scope

- General localization framework for every product surface.
- User-configurable language preferences.
- Persistence of users or conversations.
- AI generation.
- Buttons, keyboards, images, or other rich message features.

## Requirements

- Russian, Belarusian, and English sender names and welcome messages must exist as separate locale resources.
- Business behavior must not be implemented in the Fastify webhook handler.
- Provider-specific HTTP details must remain in the Viber integration client.
- The sender name and welcome text must not be duplicated in integration or webhook code.
- The Viber `conversation_started` callback must be followed by the required outbound `send_message` call.
- Unknown or missing language values fall back to Russian.
- The implementation must not log the user's full message or personal content.

## Acceptance criteria

- [ ] `conversation_started.user.language = ru` sends the Russian sender name and welcome.
- [ ] `conversation_started.user.language = be` sends the Belarusian sender name and welcome.
- [ ] `conversation_started.user.language = en` sends the English sender name and welcome.
- [ ] Missing or unsupported language sends the Russian sender name and welcome.
- [ ] Webhook code contains no welcome copy, sender name, or locale selection rules.
- [ ] Tests cover locale selection, application behavior, and the Viber outbound request boundary.

## Architecture

The flow is:

```text
Viber webhook
  -> integration validation/parsing
  -> application welcome use case
  -> localization resolver (sender + text)
  -> Viber integration client
  -> Viber send_message API
```

Business rules belong in `src/application/`. Provider-specific HTTP belongs in `src/integrations/`. Translated user-facing strings, including sender names, belong in `src/localization/`.

## Data and privacy

No new persistent data is created. The Viber user ID and language are used only to process the callback and send the response.

## Observability

Use the existing structured webhook logging. Do not log the complete Viber user object or message content.

## Testing

- Unit: locale resolution and welcome application behavior.
- Integration: Viber client sends the expected `send_message` request.
- E2E / manual: open the bot conversation with supported device languages and verify the corresponding sender name and welcome appear.

## Dependencies

- Viber `conversation_started` callback.
- Viber `send_message` API.

## Open questions

- None
