import { describe, expect, it, vi } from 'vitest';
import {
  UsageAccountingService,
  UsageBudgetError,
} from './usage-accounting.js';

import {
  AiGenerationError,
  MAX_AI_INPUT_CHARS,
  MAX_AI_INPUT_MESSAGES,
  buildAiMessages,
  createAiRouter,
  type AiRouterLogRecord,
} from './ai-router.js';

const config = {
  models: { cheap_text: 'google/gemma-3-4b-it' },
  maxOutputTokens: 512,
  requestTimeoutMs: 30000,
};

describe('AI Router', () => {
  it('maps cheap_text to the configured model and forwards a complete ordered burst', async () => {
    const generate = vi.fn().mockResolvedValue({ text: '  Hello!  ' });
    const logger = { info: vi.fn(), error: vi.fn() };
    const router = createAiRouter(config, { generate }, logger);

    await expect(
      router.generate({
        route: 'cheap_text',
        language: 'be',
        messages: ['Першае паведамленне', 'Другое паведамленне'],
      }),
    ).resolves.toEqual({ text: 'Hello!' });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith({
      model: 'google/gemma-3-4b-it',
      maxOutputTokens: 512,
      timeoutMs: 30000,
      messages: [
        {
          role: 'system',
          content: expect.stringContaining('Belarusian'),
        },
        { role: 'user', content: 'Першае паведамленне' },
        { role: 'user', content: 'Другое паведамленне' },
      ],
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ai_generation_succeeded',
        route: 'cheap_text',
        model: 'google/gemma-3-4b-it',
        outcome: 'success',
      }),
    );
  });

  it('builds a Russian prompt when the locale resolves to Russian', () => {
    const messages = buildAiMessages(['first', 'second'], 'ru');

    expect(messages[0]?.content).toContain('Answer in Russian');
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('inserts recent user and assistant context in chronological order before the current burst', () => {
    const messages = buildAiMessages(
      ['Make it shorter.'],
      'en',
      MAX_AI_INPUT_CHARS,
      [
        { role: 'user', content: 'Write a note.' },
        { role: 'assistant', content: 'Here is a long note.' },
        { role: 'user', content: 'Mention Friday.' },
      ],
    );

    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'Write a note.' },
      { role: 'assistant', content: 'Here is a long note.' },
      { role: 'user', content: 'Mention Friday.' },
      { role: 'user', content: 'Make it shorter.' },
    ]);
  });

  it('bounds history to twelve recent messages and gives the current burst priority', () => {
    const history = Array.from({ length: 15 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `history-${index}`,
    }));
    const messages = buildAiMessages(
      ['current request'],
      'en',
      40,
      history,
    ).slice(1);

    expect(messages.length).toBeLessThanOrEqual(13);
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: 'current request',
    });
    expect(
      messages.reduce((total, item) => total + item.content.length, 0),
    ).toBeLessThanOrEqual(40);
    expect(messages.some((item) => item.content === 'history-0')).toBe(false);
  });

  it('bounds the total input size while retaining the beginning of the burst in order', () => {
    const messages = buildAiMessages(
      ['a'.repeat(MAX_AI_INPUT_CHARS), 'later message'],
      'en',
    ).slice(1);
    const totalChars = messages.reduce(
      (total, message) => total + message.content.length,
      0,
    );

    expect(totalChars).toBeLessThanOrEqual(MAX_AI_INPUT_CHARS);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain('input limit');
  });

  it('bounds the number of user messages even when their text is empty', () => {
    const messages = buildAiMessages(
      Array.from({ length: MAX_AI_INPUT_MESSAGES + 20 }, () => ''),
      'en',
    ).slice(1);

    expect(messages).toHaveLength(MAX_AI_INPUT_MESSAGES);
    expect(messages.at(-1)?.content).toContain('input limit');
  });

  it('normalizes unknown provider errors and never logs prompt contents', async () => {
    const records: AiRouterLogRecord[] = [];
    const logger = {
      info: vi.fn((record: AiRouterLogRecord) => records.push(record)),
      error: vi.fn((record: AiRouterLogRecord) => records.push(record)),
    };
    const router = createAiRouter(
      config,
      { generate: vi.fn().mockRejectedValue(new Error('private prompt text')) },
      logger,
    );

    let thrown: unknown;
    try {
      await router.generate({
        route: 'cheap_text',
        messages: ['private prompt text'],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AiGenerationError);
    expect((thrown as AiGenerationError).kind).toBe('network');
    expect((thrown as Error).message).not.toContain('private prompt text');
    expect(JSON.stringify(records)).not.toContain('private prompt text');
  });

  it('logs sanitized provider error details for HTTP failures', async () => {
    const records: AiRouterLogRecord[] = [];
    const logger = {
      info: vi.fn((record: AiRouterLogRecord) => records.push(record)),
      error: vi.fn((record: AiRouterLogRecord) => records.push(record)),
    };
    const providerError = new AiGenerationError('http', 404, {
      providerErrorCode: 404,
      providerErrorMessage:
        'No endpoints found matching your privacy requirements',
    });
    const router = createAiRouter(
      config,
      { generate: vi.fn().mockRejectedValue(providerError) },
      logger,
    );

    await expect(
      router.generate({
        route: 'cheap_text',
        messages: ['private user text'],
      }),
    ).rejects.toMatchObject({ kind: 'http', httpStatus: 404 });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ai_generation_failed',
        category: 'http',
        httpStatus: 404,
        providerErrorCode: 404,
        providerErrorType: 'provider_unavailable',
        providerCode: 'no_provider_available',
        retryAfterSeconds: 3,
        providerErrorMessage:
          'No endpoints found matching your privacy requirements',
        responseContentType: 'application/json',
        responseBodyLength: 128,
        providerResponseId: 'gen-http-error-123',
        providerModel: 'provider/model-name',
      }),
    );
    expect(JSON.stringify(records)).not.toContain('private user text');
  });

  it('logs OpenRouter provider errors embedded in HTTP 200 responses', async () => {
    const records: AiRouterLogRecord[] = [];
    const logger = {
      info: vi.fn((record: AiRouterLogRecord) => records.push(record)),
      error: vi.fn((record: AiRouterLogRecord) => records.push(record)),
    };
    const providerError = new AiGenerationError(
      'provider_response_error',
      200,
      {
        responseIssue: 'provider_error',
        providerErrorCode: 429,
        providerErrorType: 'rate_limit_exceeded',
        providerCode: 'rate_limited',
        providerErrorMessage: 'Rate limit exceeded.',
        responseContentType: 'application/json',
        responseBodyLength: 150,
        providerResponseId: 'gen-embedded-error',
        providerModel: 'provider/model-name',
        choiceCount: 1,
        finishReason: 'error',
      },
    );
    const router = createAiRouter(
      config,
      { generate: vi.fn().mockRejectedValue(providerError) },
      logger,
    );

    await expect(
      router.generate({
        route: 'cheap_text',
        messages: ['private prompt text'],
      }),
    ).rejects.toMatchObject({
      kind: 'provider_response_error',
      responseIssue: 'provider_error',
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ai_generation_failed',
        category: 'provider_response_error',
        httpStatus: 200,
        providerErrorCode: 429,
        providerErrorType: 'rate_limit_exceeded',
        providerCode: 'rate_limited',
        responseContentType: 'application/json',
        responseBodyLength: 150,
        providerResponseId: 'gen-embedded-error',
        providerModel: 'provider/model-name',
        choiceCount: 1,
        finishReason: 'error',
      }),
    );
    expect(JSON.stringify(records)).not.toContain('private prompt text');
  });

  it('logs malformed response diagnostics but never logs user content', async () => {
    const records: AiRouterLogRecord[] = [];
    const logger = {
      info: vi.fn((record: AiRouterLogRecord) => records.push(record)),
      error: vi.fn((record: AiRouterLogRecord) => records.push(record)),
    };
    const providerError = new AiGenerationError(
      'malformed_response',
      undefined,
      {
        responseIssue: 'missing_choices',
        responseContentType: 'application/json',
        responseBodyLength: 72,
        providerResponseId: 'gen-test-123',
        providerModel: 'provider/model-name',
      },
    );
    const router = createAiRouter(
      config,
      { generate: vi.fn().mockRejectedValue(providerError) },
      logger,
    );

    await expect(
      router.generate({
        route: 'cheap_text',
        messages: ['private prompt text'],
      }),
    ).rejects.toMatchObject({
      kind: 'malformed_response',
      responseIssue: 'missing_choices',
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'malformed_response',
        responseIssue: 'missing_choices',
        responseContentType: 'application/json',
        responseBodyLength: 72,
        providerResponseId: 'gen-test-123',
        providerModel: 'provider/model-name',
      }),
    );
    expect(JSON.stringify(records)).not.toContain('private prompt text');
  });

  it('never calls the provider when the shared budget guard rejects an attempt', async () => {
    const generate = vi.fn();
    const accounting = {
      reserve: vi
        .fn()
        .mockRejectedValue(new UsageBudgetError('global_daily_budget')),
    } as unknown as UsageAccountingService;
    const router = createAiRouter(
      config,
      { generate },
      { info: vi.fn(), error: vi.fn() },
      accounting,
    );

    await expect(
      router.generate({
        route: 'cheap_text',
        messages: ['do not make a paid call'],
        usageContext: {
          userId: '1',
          conversationId: '2',
          turnId: '3',
          attemptNumber: 1,
        },
      }),
    ).rejects.toBeInstanceOf(UsageBudgetError);

    expect(accounting.reserve).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it('retains the reservation for an ambiguous timeout', async () => {
    const generate = vi
      .fn()
      .mockRejectedValue(new AiGenerationError('timeout'));
    const accounting = {
      reserve: vi.fn().mockResolvedValue({
        reservationId: 'usage-1',
        maxOutputTokens: 512,
        reservedUsd: 0.001,
        economyMode: false,
      }),
      markInFlight: vi.fn().mockResolvedValue(undefined),
      reconcileSuccess: vi.fn().mockResolvedValue(undefined),
      markKnownFailure: vi.fn().mockResolvedValue(undefined),
      markAmbiguousFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as UsageAccountingService;
    const router = createAiRouter(
      config,
      { generate },
      { info: vi.fn(), error: vi.fn() },
      accounting,
    );

    await expect(
      router.generate({
        route: 'cheap_text',
        messages: ['request may have reached provider'],
        usageContext: {
          userId: '1',
          conversationId: '2',
          turnId: '3',
          attemptNumber: 1,
        },
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });

    expect(accounting.markInFlight).toHaveBeenCalledOnce();
    expect(accounting.markAmbiguousFailure).toHaveBeenCalledWith(
      { userId: '1', conversationId: '2', turnId: '3', attemptNumber: 1 },
      'timeout',
      expect.any(Number),
    );
    expect(accounting.markKnownFailure).not.toHaveBeenCalled();
  });

  it('reports a missing route model as a configuration error', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const router = createAiRouter(
      { ...config, models: {} },
      { generate: vi.fn() },
      logger,
    );

    await expect(
      router.generate({ route: 'cheap_text', messages: ['hello'] }),
    ).rejects.toMatchObject({ kind: 'configuration' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'configuration' }),
    );
  });
});
