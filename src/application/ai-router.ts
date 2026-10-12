import { resolveLocale } from '../localization/index.js';
import type {
  UsageAccountingService,
  UsageAttemptContext,
} from './usage-accounting.js';

export type AiRoute = 'cheap_text' | 'web';

export interface AiContextMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface AiGenerationResult {
  text: string;
  usage?: AiUsage;
}

export interface AiProviderRequest {
  model: string;
  messages: AiChatMessage[];
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface AiProvider {
  generate(input: AiProviderRequest): Promise<AiGenerationResult>;
}

export type AiErrorKind =
  'configuration' | 'http' | 'timeout' | 'network' | 'malformed_response';

export type AiResponseIssue =
  | 'invalid_json'
  | 'unreadable_body'
  | 'response_not_object'
  | 'missing_choices'
  | 'empty_choices'
  | 'invalid_choice'
  | 'missing_message'
  | 'missing_content'
  | 'non_string_content'
  | 'empty_content';

export interface AiGenerationErrorDetails {
  providerErrorCode?: string | number;
  providerErrorMessage?: string;
  responseIssue?: AiResponseIssue;
  responseContentType?: string;
  responseBodyLength?: number;
  providerResponseId?: string;
  providerModel?: string;
  choiceCount?: number;
  finishReason?: string;
  messageContentType?: string;
}

export class AiGenerationError extends Error {
  readonly kind: AiErrorKind;
  readonly httpStatus?: number;
  readonly providerErrorCode?: string | number;
  readonly providerErrorMessage?: string;
  readonly responseIssue?: AiResponseIssue;
  readonly responseContentType?: string;
  readonly responseBodyLength?: number;
  readonly providerResponseId?: string;
  readonly providerModel?: string;
  readonly choiceCount?: number;
  readonly finishReason?: string;
  readonly messageContentType?: string;

  constructor(
    kind: AiErrorKind,
    httpStatus?: number,
    details: AiGenerationErrorDetails = {},
  ) {
    super(`AI generation failed: ${kind}`);
    this.name = 'AiGenerationError';
    this.kind = kind;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (details.providerErrorCode !== undefined) {
      this.providerErrorCode = details.providerErrorCode;
    }
    if (details.providerErrorMessage !== undefined) {
      this.providerErrorMessage = details.providerErrorMessage;
    }
    if (details.responseIssue !== undefined) {
      this.responseIssue = details.responseIssue;
    }
    if (details.responseContentType !== undefined) {
      this.responseContentType = details.responseContentType;
    }
    if (details.responseBodyLength !== undefined) {
      this.responseBodyLength = details.responseBodyLength;
    }
    if (details.providerResponseId !== undefined) {
      this.providerResponseId = details.providerResponseId;
    }
    if (details.providerModel !== undefined) {
      this.providerModel = details.providerModel;
    }
    if (details.choiceCount !== undefined) {
      this.choiceCount = details.choiceCount;
    }
    if (details.finishReason !== undefined) {
      this.finishReason = details.finishReason;
    }
    if (details.messageContentType !== undefined) {
      this.messageContentType = details.messageContentType;
    }
  }
}

export interface AiRouterInput {
  route: AiRoute;
  messages: string[];
  history?: AiContextMessage[];
  language?: string;
  usageContext?: UsageAttemptContext;
}

export interface AiRouter {
  generate(input: AiRouterInput): Promise<AiGenerationResult>;
}

export interface AiRouterConfig {
  models: Partial<Record<AiRoute, string>>;
  maxOutputTokens: number;
  requestTimeoutMs: number;
}

export interface AiRouterLogRecord {
  event: 'ai_generation_succeeded' | 'ai_generation_failed';
  route: AiRoute;
  model: string;
  durationMs: number;
  outcome: 'success' | 'failure';
  category?: AiErrorKind;
  httpStatus?: number;
  providerErrorCode?: string | number;
  providerErrorMessage?: string;
  responseIssue?: AiResponseIssue;
  responseContentType?: string;
  responseBodyLength?: number;
  providerResponseId?: string;
  providerModel?: string;
  choiceCount?: number;
  finishReason?: string;
  messageContentType?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface AiRouterLogger {
  info(record: AiRouterLogRecord): void;
  error(record: AiRouterLogRecord): void;
}

export const MAX_AI_INPUT_CHARS = 12_000;
export const MAX_AI_INPUT_MESSAGES = 100;
export const MAX_CONTEXT_MESSAGES = 12;

const truncationMarker =
  '\\n[The remainder of this message burst was omitted because it exceeded the input limit.]';

const localeNames: Record<ReturnType<typeof resolveLocale>, string> = {
  ru: 'Russian',
  be: 'Belarusian',
  en: 'English',
};

const defaultLogger: AiRouterLogger = {
  info(record) {
    console.info(JSON.stringify(record));
  },
  error(record) {
    console.error(JSON.stringify(record));
  },
};

export function buildAiMessages(
  messages: string[],
  language?: string,
  maxInputChars = MAX_AI_INPUT_CHARS,
  history: AiContextMessage[] = [],
): AiChatMessage[] {
  const locale = resolveLocale(language);
  const boundedMessages = boundMessages(messages, maxInputChars);
  const currentChars = boundedMessages.reduce(
    (total, message) => total + message.length,
    0,
  );
  const boundedHistory = boundHistory(
    history,
    Math.max(0, maxInputChars - currentChars),
  );
  const systemPrompt = [
    'You are Sofi, an AI assistant, not a human.',
    `Answer in ${localeNames[locale]}.`,
    'Be warm, concise, natural, and useful.',
    'The conversation history is ordered from oldest to newest.',
    'Use prior user and assistant turns to understand references in the latest user message(s).',
    'Never imply browsing or external access unless the information was actually supplied.',
  ].join(' ');

  return [
    { role: 'system', content: systemPrompt },
    ...boundedHistory,
    ...boundedMessages.map((content) => ({ role: 'user' as const, content })),
  ];
}

function boundHistory(
  history: AiContextMessage[],
  maxChars: number,
): AiContextMessage[] {
  if (maxChars <= 0 || history.length === 0) return [];

  const recent = history.slice(-MAX_CONTEXT_MESSAGES);
  const selected: AiContextMessage[] = [];
  let remaining = maxChars;

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    if (!message || remaining <= 0) break;

    if (message.content.length <= remaining) {
      selected.unshift(message);
      remaining -= message.content.length;
      continue;
    }

    if (selected.length === 0) {
      selected.unshift({
        role: message.role,
        content: message.content.slice(-remaining),
      });
    }
    break;
  }

  return selected;
}

function boundMessages(messages: string[], maxInputChars: number): string[] {
  if (!Number.isInteger(maxInputChars) || maxInputChars <= 0) {
    throw new AiGenerationError('configuration');
  }

  const totalLength = messages.reduce(
    (total, message) => Math.min(maxInputChars + 1, total + message.length),
    0,
  );

  if (
    totalLength <= maxInputChars &&
    messages.length <= MAX_AI_INPUT_MESSAGES
  ) {
    return [...messages];
  }

  const marker =
    truncationMarker.length <= maxInputChars
      ? truncationMarker
      : truncationMarker.slice(-maxInputChars);
  const contentLimit = maxInputChars - marker.length;
  let remaining = contentLimit;
  const bounded: string[] = [];

  for (const message of messages) {
    if (remaining <= 0 || bounded.length >= MAX_AI_INPUT_MESSAGES) break;

    const part = message.slice(0, remaining);
    bounded.push(part);
    remaining -= part.length;

    if (part.length < message.length) break;
  }

  if (bounded.length === 0) return [marker];
  bounded[bounded.length - 1] += marker;

  return bounded;
}

export function createAiRouter(
  config: AiRouterConfig,
  provider: AiProvider,
  logger: AiRouterLogger = defaultLogger,
  usageAccounting?: UsageAccountingService,
): AiRouter {
  if (process.env.NODE_ENV === 'production' && !usageAccounting) {
    throw new Error('Usage accounting is required for production AI calls');
  }

  return {
    async generate(input) {
      const model = config.models[input.route];
      if (
        !model ||
        !Number.isInteger(config.maxOutputTokens) ||
        config.maxOutputTokens <= 0 ||
        !Number.isInteger(config.requestTimeoutMs) ||
        config.requestTimeoutMs <= 0
      ) {
        const error = new AiGenerationError('configuration');
        logger.error({
          event: 'ai_generation_failed',
          route: input.route,
          model: model ?? 'unconfigured',
          durationMs: 0,
          outcome: 'failure',
          category: error.kind,
        });
        throw error;
      }

      const startedAt = Date.now();
      const chatMessages = buildAiMessages(
        input.messages,
        input.language,
        MAX_AI_INPUT_CHARS,
        input.history,
      );
      if (usageAccounting && !input.usageContext) {
        // If cost controls are configured, an unaccounted call must never pass.
        throw new AiGenerationError('configuration');
      }

      const reservation =
        usageAccounting && input.usageContext
          ? await usageAccounting.reserve({
            ...input.usageContext,
            route: input.route,
            model,
            messages: chatMessages,
            maxOutputTokens: config.maxOutputTokens,
          })
          : undefined;

      try {
        if (usageAccounting && input.usageContext) {
          await usageAccounting.markInFlight(input.usageContext);
        }
        const result = await provider.generate({
          model,
          messages: chatMessages,
          maxOutputTokens:
            reservation?.maxOutputTokens ?? config.maxOutputTokens,
          timeoutMs: config.requestTimeoutMs,
        });

        if (usageAccounting && input.usageContext) {
          await usageAccounting.reconcileSuccess(
            input.usageContext,
            result.usage,
            Date.now() - startedAt,
          );
        }

        const text = result.text.trim();
        if (!text) throw new AiGenerationError('malformed_response');

        logger.info({
          event: 'ai_generation_succeeded',
          route: input.route,
          model,
          durationMs: Date.now() - startedAt,
          outcome: 'success',
          ...(result.usage?.promptTokens !== undefined
            ? { promptTokens: result.usage.promptTokens }
            : {}),
          ...(result.usage?.completionTokens !== undefined
            ? { completionTokens: result.usage.completionTokens }
            : {}),
          ...(result.usage?.totalTokens !== undefined
            ? { totalTokens: result.usage.totalTokens }
            : {}),
          ...(result.usage?.costUsd !== undefined
            ? { costUsd: result.usage.costUsd }
            : {}),
        });

        return { ...result, text };
      } catch (cause) {
        const error =
          cause instanceof AiGenerationError
            ? cause
            : new AiGenerationError('network');
        if (usageAccounting && input.usageContext && reservation) {
          const knownPreProviderFailure =
            error.kind === 'configuration' ||
            (error.kind === 'http' &&
              typeof error.httpStatus === 'number' &&
              error.httpStatus >= 400 &&
              error.httpStatus < 500 &&
              error.httpStatus !== 408 &&
              error.httpStatus !== 425);
          const category =
            error.kind === 'http' && error.httpStatus
              ? `http_${error.httpStatus}`
              : error.kind;
          if (knownPreProviderFailure) {
            await usageAccounting.markKnownFailure(
              input.usageContext,
              category,
              Date.now() - startedAt,
            );
          } else {
            await usageAccounting.markAmbiguousFailure(
              input.usageContext,
              category,
              Date.now() - startedAt,
            );
          }
        }
        logger.error({
          event: 'ai_generation_failed',
          route: input.route,
          model,
          durationMs: Date.now() - startedAt,
          outcome: 'failure',
          category: error.kind,
          ...(error.httpStatus !== undefined
            ? { httpStatus: error.httpStatus }
            : {}),
          ...(error.providerErrorCode !== undefined
            ? { providerErrorCode: error.providerErrorCode }
            : {}),
          ...(error.providerErrorMessage !== undefined
            ? { providerErrorMessage: error.providerErrorMessage }
            : {}),
          ...(error.responseIssue !== undefined
            ? { responseIssue: error.responseIssue }
            : {}),
          ...(error.responseContentType !== undefined
            ? { responseContentType: error.responseContentType }
            : {}),
          ...(error.responseBodyLength !== undefined
            ? { responseBodyLength: error.responseBodyLength }
            : {}),
          ...(error.providerResponseId !== undefined
            ? { providerResponseId: error.providerResponseId }
            : {}),
          ...(error.providerModel !== undefined
            ? { providerModel: error.providerModel }
            : {}),
          ...(error.choiceCount !== undefined
            ? { choiceCount: error.choiceCount }
            : {}),
          ...(error.finishReason !== undefined
            ? { finishReason: error.finishReason }
            : {}),
          ...(error.messageContentType !== undefined
            ? { messageContentType: error.messageContentType }
            : {}),
        });
        throw error;
      }
    },
  };
}
