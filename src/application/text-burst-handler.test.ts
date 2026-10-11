import { describe, expect, it, vi } from 'vitest';

import { createOpenRouterClient } from '../integrations/openrouter/client.js';
import {
  AiGenerationError,
  createAiRouter,
  type AiRouter,
} from './ai-router.js';
import { handleTextBurstComplete } from './text-burst-handler.js';

describe('handleTextBurstComplete', () => {
  it('passes persisted history and the current burst to the AI Router', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'A shorter draft.' });
    const aiRouter: AiRouter = { generate };

    await expect(
      handleTextBurstComplete(aiRouter, {
        userId: 'user-1',
        language: 'en',
        history: [
          { role: 'user', content: 'Write a note to my landlord.' },
          { role: 'assistant', content: 'Dear landlord, ...' },
        ],
        messages: ['Make it shorter.'],
      }),
    ).resolves.toBe('A shorter draft.');

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith({
      route: 'cheap_text',
      language: 'en',
      history: [
        { role: 'user', content: 'Write a note to my landlord.' },
        { role: 'assistant', content: 'Dear landlord, ...' },
      ],
      messages: ['Make it shorter.'],
    });
  });

  it('connects ordered context to a mocked OpenRouter request without logging prompt contents', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: 'AI-generated reply' } },
          ],
          usage: {
            prompt_tokens: 14,
            completion_tokens: 5,
            total_tokens: 19,
            cost: 0.0001,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const logRecords: unknown[] = [];
    const aiRouter = createAiRouter(
      {
        models: { cheap_text: 'google/gemma-3-4b-it' },
        maxOutputTokens: 512,
        requestTimeoutMs: 30_000,
      },
      createOpenRouterClient({ apiKey: 'test-openrouter-key', fetchImpl }),
      {
        info(record) {
          logRecords.push(record);
        },
        error(record) {
          logRecords.push(record);
        },
      },
    );

    const result = await handleTextBurstComplete(aiRouter, {
      userId: 'user-integration',
      language: 'be',
      history: [
        { role: 'user', content: 'Першае паведамленне' },
        { role: 'assistant', content: 'Папярэдні адказ' },
      ],
      messages: ['Зрабі карацей.'],
    });

    expect(result).toBe('AI-generated reply');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('google/gemma-3-4b-it');
    expect(body.max_tokens).toBe(512);
    expect(body.messages[0]?.content).toContain('Belarusian');
    expect(body.messages.slice(1)).toEqual([
      { role: 'user', content: 'Першае паведамленне' },
      { role: 'assistant', content: 'Папярэдні адказ' },
      { role: 'user', content: 'Зрабі карацей.' },
    ]);
    const serializedLogs = JSON.stringify(logRecords);
    expect(serializedLogs).not.toContain('test-openrouter-key');
    expect(serializedLogs).not.toContain('Першае паведамленне');
    expect(serializedLogs).not.toContain('Папярэдні адказ');
    expect(serializedLogs).not.toContain('Зрабі карацей.');
    expect(serializedLogs).not.toContain('AI-generated reply');
  });

  it('does not hide generation errors; the durable worker owns bounded retries and fallback replies', async () => {
    const privateError = new AiGenerationError('http', 503);
    const aiRouter: AiRouter = {
      generate: vi.fn().mockRejectedValue(privateError),
    };

    await expect(
      handleTextBurstComplete(aiRouter, {
        userId: 'user-2',
        language: 'en',
        history: [],
        messages: ['private user message'],
      }),
    ).rejects.toMatchObject({ kind: 'http', httpStatus: 503 });
  });

  it('fails safely when AI generation is disabled', async () => {
    await expect(
      handleTextBurstComplete(undefined, {
        userId: 'user-3',
        language: 'ru',
        history: [],
        messages: ['hello'],
      }),
    ).rejects.toMatchObject({ kind: 'configuration' });
  });
});
