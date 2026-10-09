import {
  AiGenerationError,
  type AiRouter,
} from './ai-router.js';
import {
  getAiTemporaryErrorResponse,
  getWelcome,
  resolveLocale,
} from '../localization/index.js';
import type { ViberClient } from '../integrations/viber/client.js';

export async function handleTextBurstComplete(
  client: ViberClient,
  aiRouter: AiRouter | undefined,
  input: {
    userId: string;
    language?: string;
    messages: string[];
  },
): Promise<void> {
  let text: string;

  if (aiRouter) {
    try {
      const result = await aiRouter.generate({
        route: 'cheap_text',
        messages: input.messages,
        ...(input.language !== undefined
          ? { language: resolveLocale(input.language) }
          : {}),
      });
      text = result.text;
    } catch (error) {
      if (!(error instanceof AiGenerationError)) {
        console.error(
          JSON.stringify({
            event: 'ai_response_generation_failed',
            route: 'cheap_text',
            category: 'unexpected',
          }),
        );
      }
      text = getAiTemporaryErrorResponse(input.language).text;
    }
  } else {
    text = getAiTemporaryErrorResponse(input.language).text;
  }

  await client.sendTextMessage({
    receiver: input.userId,
    senderName: getWelcome(input.language).senderName,
    text,
  });
}