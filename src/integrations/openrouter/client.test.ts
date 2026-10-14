import { describe, expect, it, vi } from 'vitest';

import {
  AiGenerationError,
  type AiProviderRequest,
} from '../../application/ai-router.js';
import { createOpenRouterClient } from './client.js';

function successResponse() {
  return new Response(
    JSON.stringify({
      id: 'gen-openrouter-test-123',
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
      providerGenerationId: 'gen-openrouter-test-123',
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
      provider: { zdr: true, data_collection: 'deny' },
      max_tool_calls: 5,
      parallel_tool_calls: false,
      tools: [
        {
          type: 'openrouter:web_search',
          parameters: {
            engine: 'auto',
            max_uses: 5,
            max_results: 5,
            max_total_results: 5,
            search_context_size: 'low',
          },
        },
      ],
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('enforces the configured web-search cap in both OpenRouter limits', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(successResponse());
    const client = createOpenRouterClient({
      apiKey: 'test-key',
      webSearchMaxRequests: 1,
      fetchImpl,
    });

    await client.generate(request);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as {
      max_tool_calls?: number;
      parallel_tool_calls?: boolean;
      tools?: Array<{ parameters?: { max_uses?: number } }>;
    };

    expect(body.max_tool_calls).toBe(1);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tools?.[0]?.parameters?.max_uses).toBe(1);
  });

  it('parses the number of server web-search requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Current answer with sources',
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
            cost: 0.0002,
            server_tool_use: { web_search_requests: 2 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createOpenRouterClient({ apiKey: 'test-key', fetchImpl });
    await expect(client.generate(request)).resolves.toMatchObject({
      usage: { webSearchRequests: 2, costUsd: 0.0002 },
    });
  });

  it('extracts safe, unique source links from OpenRouter URL-citation annotations', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Current information summary',
                annotations: [
                  {
                    type: 'url_citation',
                    url_citation: {
                      url: 'https://example.com/news',
                      title: '  Example\\n News  ',
                    },
                  },
                  {
                    type: 'url_citation',
                    url_citation: {
                      url: 'https://example.com/news',
                      title: 'Duplicate title',
                    },
                  },
                  {
                    type: 'url_citation',
                    url_citation: {
                      url: 'javascript:alert(1)',
                      title: 'Unsafe source',
                    },
                  },
                  {
                    type: 'url_citation',
                    url_citation: {
                      url: 'https://user:secret@example.org/private',
                      title: 'Credentials must be rejected',
                    },
                  },
                  {
                    type: 'url_citation',
                    url_citation: { url: 'https://example.org/report' },
                  },
                ],
              },
            },
          ],
          usage: { server_tool_use: { web_search_requests: 1 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createOpenRouterClient({ apiKey: 'test-key', fetchImpl });

    await expect(client.generate(request)).resolves.toMatchObject({
      text: 'Current information summary',
      usage: { webSearchRequests: 1 },
      sources: [
        { title: 'Example News', url: 'https://example.com/news' },
        { title: 'example.org', url: 'https://example.org/report' },
      ],
    });
  });

  it('can disable web search explicitly', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(successResponse());
    const client = createOpenRouterClient({
      apiKey: 'test-key',
      webSearchEnabled: false,
      fetchImpl,
    });
    await client.generate(request);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('tools');
  });

  it('allows explicit privacy policy overrides for deployment configuration', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(successResponse());
    const client = createOpenRouterClient({
      apiKey: 'test-openrouter-secret',
      requireZdr: false,
      dataCollectionPolicy: 'allow',
      fetchImpl,
    });
    await client.generate(request);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body)).provider).toEqual({
      zdr: false,
      data_collection: 'allow',
    });
  });

  it('preserves a successful response when the provider omits usage metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: 'No usage metadata' } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createOpenRouterClient({
      apiKey: 'test-openrouter-secret',
      fetchImpl,
    });

    await expect(client.generate(request)).resolves.toEqual({
      text: 'No usage metadata',
    });
  });

  it('keeps only valid non-negative numeric usage fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: 'Partial usage' } },
          ],
          usage: {
            prompt_tokens: 18.5,
            completion_tokens: -1,
            total_tokens: 0,
            cost: '0.5',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createOpenRouterClient({
      apiKey: 'test-openrouter-secret',
      fetchImpl,
    });

    await expect(client.generate(request)).resolves.toEqual({
      text: 'Partial usage',
      usage: { totalTokens: 0 },
    });
  });

  it('includes sanitized OpenRouter error metadata without logging the raw body', async () => {
    const body = JSON.stringify({
      id: 'gen-http-error-123',
      model: 'provider/model-name',
      error: {
        message:
          'No endpoints found matching your privacy requirements. Prompt: second message. Bearer test-secret',
        code: 404,
        metadata: {
          error_type: 'provider_unavailable',
          provider_code: 'no_provider_available',
          privateDetails: 'must not be logged',
        },
      },
      user_id: 'private-user-id',
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 404,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'retry-after': '3',
        },
      }),
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
      providerErrorType: 'provider_unavailable',
      providerCode: 'no_provider_available',
      providerErrorMessage:
        'No endpoints found matching your privacy requirements. Prompt: [redacted input]. Bearer [redacted]',
      responseContentType: 'application/json',
      responseBodyLength: new TextEncoder().encode(body).byteLength,
      providerResponseId: 'gen-http-error-123',
      providerModel: 'provider/model-name',
      retryAfterSeconds: 3,
    });
    expect(JSON.stringify(thrown)).not.toContain('second message');
    expect(JSON.stringify(thrown)).not.toContain('test-secret');
    expect(JSON.stringify(thrown)).not.toContain('must not be logged');
    expect(JSON.stringify(thrown)).not.toContain('private-user-id');
  });

  it('records diagnostics for non-JSON HTTP errors without exposing the response body', async () => {
    const body = 'sensitive provider response body';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 429,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'retry-after': '2',
        },
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
      kind: 'http',
      httpStatus: 429,
      responseIssue: 'invalid_error_json',
      responseContentType: 'text/plain',
      responseBodyLength: new TextEncoder().encode(body).byteLength,
      retryAfterSeconds: 2,
    });
    expect(JSON.stringify(thrown)).not.toContain(body);
  });

  it('captures provider errors embedded in an HTTP 200 response', async () => {
    const body = JSON.stringify({
      id: 'gen-embedded-error',
      model: 'provider/model-name',
      choices: [
        {
          finish_reason: 'error',
          message: {
            role: 'assistant',
            content: 'private partial assistant response',
          },
          error: {
            code: 429,
            message: 'Rate limit exceeded. Prompt: second message.',
            metadata: {
              error_type: 'rate_limit_exceeded',
              provider_code: 'rate_limited',
            },
          },
        },
      ],
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createOpenRouterClient({
      apiKey: 'test-secret',
      fetchImpl,
    });

    let thrown: unknown;
    try {
      await client.generate(request);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      kind: 'provider_response_error',
      httpStatus: 200,
      responseIssue: 'provider_error',
      providerErrorCode: 429,
      providerErrorType: 'rate_limit_exceeded',
      providerCode: 'rate_limited',
      providerErrorMessage: 'Rate limit exceeded. Prompt: [redacted input].',
      providerResponseId: 'gen-embedded-error',
      providerModel: 'provider/model-name',
      choiceCount: 1,
      finishReason: 'error',
      responseContentType: 'application/json',
      responseBodyLength: new TextEncoder().encode(body).byteLength,
    });
    expect(JSON.stringify(thrown)).not.toContain(
      'private partial assistant response',
    );
    expect(JSON.stringify(thrown)).not.toContain('second message');
    expect(JSON.stringify(thrown)).not.toContain('test-secret');
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
  ])(
    'identifies malformed successful payloads: $label',
    async ({ payload, responseIssue }) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const client = createOpenRouterClient({
        apiKey: 'test-secret',
        fetchImpl,
      });

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
    },
  );

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
