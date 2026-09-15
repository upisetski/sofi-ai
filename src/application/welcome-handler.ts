import { getWelcomeText } from '../localization/index.js';
import type { ViberClient } from '../integrations/viber/client.js';

export async function handleConversationStarted(
  client: ViberClient,
  input: { userId: string; language?: string },
): Promise<void> {
  await client.sendTextMessage({
    receiver: input.userId,
    text: getWelcomeText(input.language),
  });
}
