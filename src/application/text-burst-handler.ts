import { getTextBurstResponse } from '../localization/index.js';
import type { ViberClient } from '../integrations/viber/client.js';

export async function handleTextBurstComplete(
  client: ViberClient,
  input: {
    userId: string;
    language?: string;
    messages: string[];
  },
): Promise<void> {
  const localizedResponse = getTextBurstResponse(
    input.language,
    input.messages,
  );

  await client.sendTextMessage({
    receiver: input.userId,
    senderName: localizedResponse.senderName,
    text: localizedResponse.text,
  });
}
