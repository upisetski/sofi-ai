import { getThinking } from '../localization/index.js';
import type { ViberClient } from '../integrations/viber/client.js';

export async function handleThinking(
  client: ViberClient,
  input: {
    userId: string;
    language: string | undefined;
    message: string;
  },
): Promise<void> {
  const localizedThinking = getThinking(input.language, input.message);

  await client.sendTextMessage({
    receiver: input.userId,
    senderName: localizedThinking.senderName,
    text: localizedThinking.thinking,
  });
}
