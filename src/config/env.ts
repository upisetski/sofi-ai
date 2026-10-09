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
    MESSAGE_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(10000),
    VIBER_AUTH_TOKEN: z.string().min(1),
    AI_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    OPENROUTER_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).optional(),
    ),
    AI_MODEL_CHEAP_TEXT: z.string().min(1).default('google/gemma-3-4b-it'),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(8192).default(512),
    AI_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(120000)
      .default(30000),
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
