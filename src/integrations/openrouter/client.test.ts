import { describe, expect, it, vi } from 'vitest';

import {
  AiGenerationError,
  type AiProviderRequest,
} from '../../application/ai-router.js';
import { createOpenRouterClient } from './client.js';

function successResponse() {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Hello from Sofi' } }],
      usage: {
        prompt_tokens: 18,
        completion_tokens: 7,
        total_tokens: 25,
        cost: 0.00012,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const request: AiProviderRequest = {
  model: 'google/gemma-3-4b-it',
  messages: [
    { role: 'system', content: 'system instruction' },
    { role: 'user', content: 'first message' },
    { role: 'user', content: 'second message' },
  ],
  maxOutputTokens: 512,
  timeoutMs: 30000,
};

describe('OpenRouter client', () => {
  it('sends Chat Completions requests with output, timeout, and privacy controls', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(successResponse());
    const client = createOpenRouterClient({
      apiKey: 'test-openrouter-secret',
      fetchImpl,
    });

    await expect(client.generate(request)).resolves.toEqual({
      text: 'Hello from Sofi',
      usage: {
        promptTokens: 18,
        completionTokens: 7,
        totalTokens: 25,
        costUsd: 0.00012,
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer test-openrouter-secret',
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'google/gemma-3-4b-it',
      messages: request.messages,
      max_tokens: 512,
      provider: {
        zdr: true,
        data_collection: 'deny',
        allow_fallbacks: false,
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('normalizes HTTP errors without reading or exposing the response body', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('sensitive provider response body', { status: 429 }),
      );
    const client = createOpenRouterClient({ apiKey: 'test-secret', fetchImpl });

    let thrown: unknown;
    try {
      await client.generate(request);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AiGenerationError);
    expect(thrown).toMatchObject({ kind: 'http', httpStatus: 429 });
    expect((thrown as Error).message).not.toContain(
      'sensitive provider response body',
    );
    expect((thrown as Error).message).not.toContain('test-secret');
  });

  it('normalizes invalid JSON responses', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('not json', { status: 200 }));
    const client = createOpenRouterClient({ apiKey: 'test-secret', fetchImpl });

    await expect(client.generate(request)).rejects.toMatchObject({
      kind: 'malformed_response',
    });
  });

  it.each([
    ['missing choices', { error: 'private response content' }],
    ['missing message content', { choices: [{ message: {} }] }],
    ['empty assistant content', { choices: [{ message: { content: '   ' } }] }],
  ])('rejects malformed successful payloads: %s', async (_label, payload) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
    const client = createOpenRouterClient({ apiKey: 'test-secret', fetchImpl });

    await expect(client.generate(request)).rejects.toMatchObject({
      kind: 'malformed_response',
    });
  });

  it('normalizes timeout and network errors without exposing exception text', async () => {
    const timeout = Object.assign(new Error('secret prompt and key'), {
      name: 'TimeoutError',
    });
    const timeoutFetch = vi.fn<typeof fetch>().mockRejectedValue(timeout);
    const timeoutClient = createOpenRouterClient({
      apiKey: 'test-secret',
      fetchImpl: timeoutFetch,
    });
    await expect(timeoutClient.generate(request)).rejects.toMatchObject({
      kind: 'timeout',
    });

    const networkFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('sensitive network details'));
    const networkClient = createOpenRouterClient({
      apiKey: 'test-secret',
      fetchImpl: networkFetch,
    });
    await expect(networkClient.generate(request)).rejects.toMatchObject({
      kind: 'network',
    });

    try {
      await networkClient.generate(request);
    } catch (error) {
      expect((error as Error).message).not.toContain(
        'sensitive network details',
      );
      expect((error as Error).message).not.toContain('test-secret');
    }
  });

  it('reports missing credentials as a configuration error without making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createOpenRouterClient({ fetchImpl });

    await expect(client.generate(request)).rejects.toMatchObject({
      kind: 'configuration',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
