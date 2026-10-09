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
  it('sends Chat Completions requests with output and timeout limits', async () => {
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
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('includes a sanitized OpenRouter error summary without logging the raw body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message:
              'No endpoints found matching your privacy requirements. Prompt: second message. Bearer test-secret',
            code: 404,
            metadata: { privateDetails: 'must not be logged' },
          },
          user_id: 'private-user-id',
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createOpenRouterClient({ apiKey: 'test-secret', fetchImpl });

    let thrown: unknown;
    try {
      await client.generate(request);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AiGenerationError);
    expect(thrown).toMatchObject({
      kind: 'http',
      httpStatus: 404,
      providerErrorCode: 404,
      providerErrorMessage:
        'No endpoints found matching your privacy requirements. Prompt: [redacted input]. Bearer [redacted]',
    });
    expect(JSON.stringify(thrown)).not.toContain('second message');
    expect(JSON.stringify(thrown)).not.toContain('test-secret');
    expect(JSON.stringify(thrown)).not.toContain('must not be logged');
    expect(JSON.stringify(thrown)).not.toContain('private-user-id');
  });

  it('handles non-JSON HTTP errors without exposing the response body', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('sensitive provider response body', { status: 429 }),
      );
    const client = createOpenRouterClient({ apiKey: 'test-secret', fetchImpl });

    await expect(client.generate(request)).rejects.toMatchObject({
      kind: 'http',
      httpStatus: 429,
    });
  });

  it('describes invalid JSON responses without logging their content', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    );
    const client = createOpenRouterClient({ apiKey: 'test-secret', fetchImpl });

    let thrown: unknown;
    try {
      await client.generate(request);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      kind: 'malformed_response',
      responseIssue: 'invalid_json',
      responseContentType: 'text/plain',
      responseBodyLength: 8,
    });
    expect(JSON.stringify(thrown)).not.toContain('not json');
    expect(JSON.stringify(thrown)).not.toContain('second message');
  });

  it.each([
    {
      label: 'missing choices',
      payload: { error: 'private response content' },
      responseIssue: 'missing_choices',
    },
    {
      label: 'missing message content',
      payload: { choices: [{ message: {} }] },
      responseIssue: 'missing_content',
    },
    {
      label: 'empty assistant content',
      payload: { choices: [{ message: { content: '   ' } }] },
      responseIssue: 'empty_content',
    },
  ])('identifies malformed successful payloads: $label', async ({
    payload,
    responseIssue,
  }) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const client = createOpenRouterClient({ apiKey: 'test-secret', fetchImpl });

    let thrown: unknown;
    try {
      await client.generate(request);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      kind: 'malformed_response',
      responseIssue,
      responseContentType: 'application/json',
    });
    expect(JSON.stringify(thrown)).not.toContain('private response content');
    expect(JSON.stringify(thrown)).not.toContain('second message');
  });

  it('includes safe response metadata when the shape of a completion is invalid', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'gen-test-123',
          model: 'provider/model-name',
          choices: [
            {
              finish_reason: 'stop',
              message: { content: { secret: 'must not be logged' } },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createOpenRouterClient({ apiKey: 'test-secret', fetchImpl });

    let thrown: unknown;
    try {
      await client.generate(request);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      kind: 'malformed_response',
      responseIssue: 'non_string_content',
      providerResponseId: 'gen-test-123',
      providerModel: 'provider/model-name',
      choiceCount: 1,
      finishReason: 'stop',
      messageContentType: 'object',
    });
    expect(JSON.stringify(thrown)).not.toContain('must not be logged');
    expect(JSON.stringify(thrown)).not.toContain('second message');
    expect(JSON.stringify(thrown)).not.toContain('test-secret');
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
