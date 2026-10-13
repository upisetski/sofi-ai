import {
  AiGenerationError,
  type AiGenerationErrorDetails,
  type AiProvider,
  type AiResponseIssue,
} from '../../application/ai-router.js';

const CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  requireZdr?: boolean;
  dataCollectionPolicy?: 'deny' | 'allow';
}

interface ResponseDiagnostics {
  responseContentType?: string;
  responseBodyLength?: number;
}

export function createOpenRouterClient(
  options: OpenRouterClientOptions,
): AiProvider {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async generate(input) {
      if (!options.apiKey) throw new AiGenerationError('configuration');

      let response: Response;
      try {
        response = await fetchImpl(CHAT_COMPLETIONS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: input.model,
            messages: input.messages,
            max_tokens: input.maxOutputTokens,
            provider: {
              zdr: options.requireZdr ?? true,
              data_collection: options.dataCollectionPolicy ?? 'deny',
            },
          }),
          signal: AbortSignal.timeout(input.timeoutMs),
        });
      } catch (cause) {
        const name =
          typeof cause === 'object' && cause !== null && 'name' in cause
            ? String(cause.name)
            : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new AiGenerationError('timeout');
        }
        throw new AiGenerationError('network');
      }

      if (!response.ok) {
        const providerDetails = await readOpenRouterError(
          response,
          options.apiKey,
          input.messages,
        );
        throw new AiGenerationError('http', response.status, providerDetails);
      }

      const responseContentType = normalizeContentType(
        response.headers.get('content-type'),
      );
      let responseBody: string;
      try {
        responseBody = await response.text();
      } catch {
        throw new AiGenerationError('malformed_response', undefined, {
          responseIssue: 'unreadable_body',
          ...(responseContentType ? { responseContentType } : {}),
        });
      }

      const responseDetails: ResponseDiagnostics = {
        ...(responseContentType ? { responseContentType } : {}),
        responseBodyLength: new TextEncoder().encode(responseBody).byteLength,
      };

      let payload: unknown;
      try {
        payload = JSON.parse(responseBody);
      } catch {
        throw new AiGenerationError('malformed_response', undefined, {
          responseIssue: 'invalid_json',
          ...responseDetails,
        });
      }

      return parseCompletion(payload, responseDetails);
    },
  };
}

async function readOpenRouterError(
  response: Response,
  apiKey: string,
  messages: AiProviderRequestMessages,
): Promise<AiGenerationErrorDetails> {
  const responseContentType = normalizeContentType(
    response.headers.get('content-type'),
  );
  const retryAfterSeconds = parseRetryAfterSeconds(
    response.headers.get('retry-after'),
  );

  let responseBody: string;
  try {
    responseBody = await response.text();
  } catch {
    return {
      responseIssue: 'unreadable_error_body',
      ...(responseContentType ? { responseContentType } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }

  const responseDetails: AiGenerationErrorDetails = {
    ...(responseContentType ? { responseContentType } : {}),
    responseBodyLength: new TextEncoder().encode(responseBody).byteLength,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };

  let payload: unknown;
  try {
    payload = JSON.parse(responseBody);
  } catch {
    return { ...responseDetails, responseIssue: 'invalid_error_json' };
  }

  if (!isRecord(payload) || !isRecord(payload.error)) {
    const providerResponseId = isRecord(payload)
      ? safeProviderIdentifier(payload.id, 128)
      : undefined;
    const providerModel = isRecord(payload)
      ? safeProviderIdentifier(payload.model, 128)
      : undefined;
    return {
      ...responseDetails,
      responseIssue: 'missing_error_object',
      ...(providerResponseId ? { providerResponseId } : {}),
      ...(providerModel ? { providerModel } : {}),
    };
  }

  const error = payload.error;
  const metadata = isRecord(error.metadata) ? error.metadata : undefined;
  const providerErrorCode = normalizeProviderErrorCode(error.code);
  const rawMessage = error.message;
  const providerErrorMessage =
    typeof rawMessage === 'string'
      ? sanitizeProviderErrorMessage(rawMessage, apiKey, messages)
      : undefined;
  const providerErrorType = safeProviderIdentifier(
    metadata?.error_type,
    64,
  );
  const providerCode = safeProviderIdentifier(metadata?.provider_code, 64);
  const providerResponseId = safeProviderIdentifier(payload.id, 128);
  const providerModel = safeProviderIdentifier(payload.model, 128);

  return {
    ...responseDetails,
    ...(providerErrorCode !== undefined ? { providerErrorCode } : {}),
    ...(providerErrorMessage ? { providerErrorMessage } : {}),
    ...(providerErrorType ? { providerErrorType } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(providerResponseId ? { providerResponseId } : {}),
    ...(providerModel ? { providerModel } : {}),
  };
}

type AiProviderRequestMessages = Array<{ role: string; content: string }>;

function normalizeProviderErrorCode(
  value: unknown,
): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^[a-zA-Z0-9_.-]+$/.test(value)
  ) {
    return value;
  }
  return undefined;
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 86_400
    ? Math.ceil(seconds)
    : undefined;
}

function sanitizeProviderErrorMessage(
  message: string,
  apiKey: string,
  messages: AiProviderRequestMessages,
): string | undefined {
  let safeMessage = [...message]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  if (apiKey) safeMessage = safeMessage.split(apiKey).join('[redacted]');
  safeMessage = safeMessage
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-or-v1-[a-zA-Z0-9_-]+\b/g, '[redacted key]');

  for (const message of messages) {
    const content = message.content.trim();
    if (content.length >= 4) {
      safeMessage = safeMessage.split(content).join('[redacted input]');
    }
  }

  safeMessage = safeMessage.slice(0, 300);
  return safeMessage || undefined;
}

function parseCompletion(
  payload: unknown,
  responseDetails: ResponseDiagnostics,
) {
  if (!isRecord(payload)) {
    throw malformedResponse('response_not_object', payload, responseDetails);
  }
  if (!Array.isArray(payload.choices)) {
    throw malformedResponse('missing_choices', payload, responseDetails);
  }
  if (payload.choices.length === 0) {
    throw malformedResponse('empty_choices', payload, responseDetails);
  }

  const choice = payload.choices[0];
  if (!isRecord(choice)) {
    throw malformedResponse('invalid_choice', payload, responseDetails);
  }
  if (!isRecord(choice.message)) {
    throw malformedResponse('missing_message', payload, responseDetails);
  }

  const content = choice.message.content;
  if (content === undefined || content === null) {
    throw malformedResponse(
      'missing_content',
      payload,
      responseDetails,
      choice,
      choice.message,
    );
  }
  if (typeof content !== 'string') {
    throw malformedResponse(
      'non_string_content',
      payload,
      responseDetails,
      choice,
      choice.message,
    );
  }
  if (!content.trim()) {
    throw malformedResponse(
      'empty_content',
      payload,
      responseDetails,
      choice,
      choice.message,
    );
  }

  const usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  } = {};

  if (isRecord(payload.usage)) {
    const promptTokens = nonNegativeInteger(payload.usage.prompt_tokens);
    const completionTokens = nonNegativeInteger(
      payload.usage.completion_tokens,
    );
    const totalTokens = nonNegativeInteger(payload.usage.total_tokens);
    const costUsd = nonNegativeNumber(payload.usage.cost);
    if (promptTokens !== undefined) usage.promptTokens = promptTokens;
    if (completionTokens !== undefined)
      usage.completionTokens = completionTokens;
    if (totalTokens !== undefined) usage.totalTokens = totalTokens;
    if (costUsd !== undefined) usage.costUsd = costUsd;
  }

  const providerGenerationId = safeProviderIdentifier(payload.id, 128);

  return {
    text: content.trim(),
    ...(providerGenerationId ? { providerGenerationId } : {}),
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
  };
}

function malformedResponse(
  responseIssue: AiResponseIssue,
  payload: unknown,
  responseDetails: ResponseDiagnostics,
  choice?: Record<string, unknown>,
  message?: Record<string, unknown>,
): AiGenerationError {
  const response = isRecord(payload) ? payload : undefined;
  const choices =
    response && Array.isArray(response.choices) ? response.choices : undefined;
  const providerResponseId = safeProviderIdentifier(response?.id, 128);
  const providerModel = safeProviderIdentifier(response?.model, 128);
  const finishReason = safeProviderIdentifier(choice?.finish_reason, 64);
  const messageContentType =
    message !== undefined ? typeof message.content : undefined;

  return new AiGenerationError('malformed_response', undefined, {
    responseIssue,
    ...responseDetails,
    ...(providerResponseId ? { providerResponseId } : {}),
    ...(providerModel ? { providerModel } : {}),
    ...(choices ? { choiceCount: choices.length } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(messageContentType ? { messageContentType } : {}),
  });
}

function normalizeContentType(value: string | null): string | undefined {
  if (!value) return undefined;
  const mimeType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mimeType && /^[a-z0-9.+_-]+\/[a-z0-9.+_-]+$/.test(mimeType)
    ? mimeType
    : undefined;
}

function safeProviderIdentifier(
  value: unknown,
  maxLength: number,
): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[a-zA-Z0-9_.:/-]+$/.test(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
