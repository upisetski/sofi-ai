import { describe, expect, it, vi } from 'vitest';

import { handleTextBurstComplete } from './text-burst-handler.js';

describe('handleTextBurstComplete', () => {
  it('sends one response containing the full text burst', async () => {
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    await handleTextBurstComplete(
      { sendTextMessage },
      {
        userId: 'user-1',
        language: 'ru',
        messages: ['Как оформить отпуск?', 'И сколько дней можно взять?'],
      },
    );

    expect(sendTextMessage).toHaveBeenCalledWith({
      receiver: 'user-1',
      senderName: 'Софи - AI-помощница',
      text: 'Думаю над вашим вопросом:\n\nКак оформить отпуск?\n\nИ сколько дней можно взять?',
    });
  });
});
