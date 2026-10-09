import {
  AiGenerationError,
  type AiProvider,
} from '../../application/ai-router.js';

const CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
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

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new AiGenerationError('malformed_response');
      }

      return parseCompletion(payload);
    },
  };
}

async function readOpenRouterError(
  response: Response,
  apiKey: string,
  messages: AiProviderRequestMessages,
): Promise<{
  providerErrorCode?: string | number;
  providerErrorMessage?: string;
}> {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    return {};
  }

  if (!isRecord(payload) || !isRecord(payload.error)) return {};

  const providerErrorCode = normalizeProviderErrorCode(payload.error.code);
  const rawMessage = payload.error.message;
  const providerErrorMessage =
    typeof rawMessage === 'string'
      ? sanitizeProviderErrorMessage(rawMessage, apiKey, messages)
      : undefined;

  return {
    ...(providerErrorCode !== undefined ? { providerErrorCode } : {}),
    ...(providerErrorMessage ? { providerErrorMessage } : {}),
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

function parseCompletion(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new AiGenerationError('malformed_response');
  }

  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new AiGenerationError('malformed_response');
  }

  const content = choice.message.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new AiGenerationError('malformed_response');
  }

  const usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  } = {};

  if (isRecord(payload.usage)) {
    const promptTokens = nonNegativeNumber(payload.usage.prompt_tokens);
    const completionTokens = nonNegativeNumber(payload.usage.completion_tokens);
    const totalTokens = nonNegativeNumber(payload.usage.total_tokens);
    const costUsd = nonNegativeNumber(payload.usage.cost);
    if (promptTokens !== undefined) usage.promptTokens = promptTokens;
    if (completionTokens !== undefined)
      usage.completionTokens = completionTokens;
    if (totalTokens !== undefined) usage.totalTokens = totalTokens;
    if (costUsd !== undefined) usage.costUsd = costUsd;
  }

  return {
    text: content.trim(),
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
