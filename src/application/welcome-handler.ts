import { getWelcome } from '../localization/index.js';
import type { ViberClient } from '../integrations/viber/client.js';

export async function handleConversationStarted(
  client: ViberClient,
  input: { userId: string; language: string | undefined },
): Promise<void> {
  const localizedWelcome = getWelcome(input.language);

  await client.sendTextMessage({
    receiver: input.userId,
    senderName: localizedWelcome.senderName,
    text: localizedWelcome.welcome,
  });
}
