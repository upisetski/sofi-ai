import 'dotenv/config';

import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().min(1).optional(),
    REORDER_DELAY_MS: z.coerce.number().int().nonnegative().default(1000),
    MESSAGE_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(5000),
    VIBER_AUTH_TOKEN: z.string().min(1),
    AI_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    OPENROUTER_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).optional(),
    ),
    AI_MODEL_CHEAP_TEXT: z.string().min(1).default('openai/gpt-6-luna'),
    OPENROUTER_REQUIRE_ZDR: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    OPENROUTER_DATA_COLLECTION_POLICY: z
      .enum(['deny', 'allow'])
      .default('deny'),
    AI_WEB_SEARCH_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    AI_WEB_SEARCH_ENGINE: z
      .enum(['auto', 'native', 'exa', 'parallel', 'perplexity'])
      .default('auto'),
    AI_WEB_SEARCH_MAX_RESULTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5),
    AI_WEB_SEARCH_MAX_TOTAL_RESULTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5),
    AI_WEB_SEARCH_CONTEXT_SIZE: z
      .enum(['low', 'medium', 'high'])
      .default('low'),
    AI_WEB_SEARCH_COST_PER_REQUEST_USD: z.coerce
      .number()
      .finite()
      .positive()
      .default(0.01),
    AI_WEB_SEARCH_MAX_REQUESTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(8192).default(512),
    AI_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(120000)
      .default(30000),
    AI_USAGE_PRICING_MODEL: z.string().min(1).default('openai/gpt-6-luna'),
    AI_USAGE_INPUT_PRICE_PER_MILLION_USD: z.coerce
      .number()
      .finite()
      .positive()
      .default(0.1),
    AI_USAGE_OUTPUT_PRICE_PER_MILLION_USD: z.coerce
      .number()
      .finite()
      .positive()
      .default(0.5),
    AI_USER_DAILY_REQUEST_LIMIT: z.coerce.number().int().positive().default(50),
    AI_USER_DAILY_BUDGET_USD: z.coerce
      .number()
      .finite()
      .positive()
      .default(0.2),
    AI_GLOBAL_DAILY_BUDGET_USD: z.coerce
      .number()
      .finite()
      .positive()
      .default(2),
    AI_GLOBAL_MONTHLY_BUDGET_USD: z.coerce
      .number()
      .finite()
      .positive()
      .default(30),
    AI_ECONOMY_THRESHOLD_PERCENT: z.coerce
      .number()
      .int()
      .min(1)
      .max(99)
      .default(80),
    AI_ECONOMY_MAX_OUTPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(1)
      .max(8192)
      .default(256),
    SENTRY_DSN: z.string().optional(),
    LOG_LEVEL: z.string().default('info'),
  })
  .superRefine((config, ctx) => {
    if (
      config.NODE_ENV === 'production' &&
      config.AI_ENABLED &&
      !config.OPENROUTER_API_KEY
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENROUTER_API_KEY'],
        message:
          'OPENROUTER_API_KEY is required when AI is enabled in production',
      });
    }

    if (config.NODE_ENV === 'production' && !config.DATABASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL is required in production',
      });
    }
  });

export function parseEnv(input: NodeJS.ProcessEnv = process.env) {
  return envSchema.parse(input);
}

export const env = parseEnv();
