import { describe, expect, it, vi } from 'vitest';

import { AiGenerationError, type AiRouter } from './ai-router.js';
import { handleTextBurstComplete } from './text-burst-handler.js';

describe('handleTextBurstComplete', () => {
  it('generates one Viber response from the complete ordered burst and locale', async () => {
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockResolvedValue({
      text: 'Оформить отпуск можно по заявлению.',
    });
    const aiRouter: AiRouter = { generate };

    await handleTextBurstComplete(
      { sendTextMessage },
      aiRouter,
      {
        userId: 'user-1',
        language: 'be',
        messages: ['Як аформіць адпачынак?', 'І колькі дзён можна ўзяць?'],
      },
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith({
      route: 'cheap_text',
      language: 'be',
      messages: ['Як аформіць адпачынак?', 'І колькі дзён можна ўзяць?'],
    });
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith({
      receiver: 'user-1',
      senderName: 'Сафі - AI-памочніца',
      text: 'Оформить отпуск можно по заявлению.',
    });
  });

  it('sends a localized temporary error rather than echoing messages when generation fails', async () => {
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);
    const aiRouter: AiRouter = {
      generate: vi.fn().mockRejectedValue(new AiGenerationError('http', 503)),
    };
    const messages = ['My private message', 'another private detail'];

    await handleTextBurstComplete(
      { sendTextMessage },
      aiRouter,
      { userId: 'user-2', language: 'en', messages },
    );

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith({
      receiver: 'user-2',
      senderName: 'Sofi - AI assistant',
      text: 'I can’t prepare a response right now. Please try again shortly.',
    });
    expect(sendTextMessage.mock.calls[0]?.[0]?.text).not.toContain(messages[0]);
  });

  it('responds with the temporary error when AI generation is disabled', async () => {
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    await handleTextBurstComplete(
      { sendTextMessage },
      undefined,
      { userId: 'user-3', language: 'ru', messages: ['hello'] },
    );

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0]?.[0]?.text).toContain(
      'Попробуйте ещё раз чуть позже.',
    );
    expect(sendTextMessage.mock.calls[0]?.[0]?.text).not.toContain('hello');
  });
});