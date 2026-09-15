# Feature: Viber welcome message

## Goal

Send Sofi's initial Russian welcome message when a user opens a one-to-one conversation with the Viber bot.

## User behavior

When a user opens the Sofi conversation from the Viber bot profile or a deep link, Viber receives a welcome-message response containing Sofi's introduction:

> Я Софи — AI-помощница на каждый день. Скидывай мне вопросы, фото, документы или сообщения — помогу разобраться, написать, перевести или что-нибудь придумать.

## Scope

### In scope

- Respond to Viber's `conversation_started` callback with a text welcome message.
- Keep the welcome copy as a single application constant.
- Preserve the existing empty 200 response for other valid webhook events.

### Out of scope

- Localization infrastructure or language negotiation.
- Persistence of users or conversations.
- AI generation.
- Buttons, keyboards, images, or other rich message features.
- Changes to non-welcome webhook events.

## Requirements

- The welcome message must match the approved Russian copy exactly.
- The `conversation_started` response must be a valid Viber text-message payload.
- The webhook must continue to return 200 for valid callbacks.
- The implementation must not log the user's full message or personal content.

## Acceptance criteria

- [ ] A valid `conversation_started` callback receives HTTP 200 with a text payload containing the approved Russian welcome message.
- [ ] The welcome response does not require the user to already be subscribed.
- [ ] Other valid callback types retain their current empty 200 response.
- [ ] Tests cover the welcome response and existing webhook validation behavior.

## Technical notes

Viber's `conversation_started` flow permits one welcome message before subscription. The webhook should respond with the welcome-message JSON payload rather than attempting normal outbound messaging.

## Data and privacy

No new persistent data is created. The callback is processed in memory and the welcome text is static.

- Do not log the full user object as part of this feature.
- No user content is stored.

## Observability

Use the existing webhook debug/error logging. Do not add user-content logging.

## Testing

- Unit: welcome payload construction.
- Integration: signed `conversation_started` webhook returns the expected JSON.
- E2E / manual: open the bot conversation in Viber and verify the welcome message appears.

## Dependencies

- Viber `conversation_started` webhook callback.
- Viber welcome-message response format.

## Open questions

- None

## Implementation checklist

- [ ] Implementation complete
- [ ] Tests added or updated
- [ ] Documentation updated where needed
- [ ] ADR added if a significant architectural decision was made
- [ ] Full local checks pass
- [ ] Focused PR opened
