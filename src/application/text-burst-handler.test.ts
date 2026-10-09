import { describe, expect, it, vi } from 'vitest';

import {
  AiGenerationError,
  createAiRouter,
  type AiRouter,
} from './ai-router.js';
import { createOpenRouterClient } from '../integrations/openrouter/client.js';
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

  it('connects a debounced burst to one mocked OpenRouter request and one Viber response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'AI-generated reply' } }],
          usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19, cost: 0.0001 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const aiRouter = createAiRouter(
      {
        models: { cheap_text: 'google/gemma-3-4b-it' },
        maxOutputTokens: 512,
        requestTimeoutMs: 30000,
      },
      createOpenRouterClient({ apiKey: 'test-openrouter-key', fetchImpl }),
      { info: vi.fn(), error: vi.fn() },
    );
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    await handleTextBurstComplete(
      { sendTextMessage },
      aiRouter,
      {
        userId: 'user-integration',
        language: 'be',
        messages: ['Першае паведамленне', 'Другое паведамленне'],
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
      provider: { zdr: boolean; data_collection: string; allow_fallbacks: boolean };
    };
    expect(body.model).toBe('google/gemma-3-4b-it');
    expect(body.max_tokens).toBe(512);
    expect(body.provider).toEqual({
      zdr: true,
      data_collection: 'deny',
      allow_fallbacks: false,
    });
    expect(body.messages[0]?.content).toContain('Belarusian');
    expect(body.messages.slice(1)).toEqual([
      { role: 'user', content: 'Першае паведамленне' },
      { role: 'user', content: 'Другое паведамленне' },
    ]);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith({
      receiver: 'user-integration',
      senderName: 'Сафі - AI-памочніца',
      text: 'AI-generated reply',
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