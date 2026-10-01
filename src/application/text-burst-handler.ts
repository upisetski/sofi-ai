import { getEcho } from '../localization/index.js';
import type { ViberClient } from '../integrations/viber/client.js';

export async function handleTextBurstComplete(
  client: ViberClient,
  input: {
    userId: string;
    language?: string;
    messages: string[];
  },
): Promise<void> {
  const localizedEcho = getEcho(input.language, input.messages);

  await client.sendTextMessage({
    receiver: input.userId,
    senderName: localizedEcho.senderName,
    text: localizedEcho.echo,
  });
}
