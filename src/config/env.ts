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
    MESSAGE_DEBOUNCE_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(1500),
    VIBER_AUTH_TOKEN: z.string().min(1),
    OPENROUTER_API_KEY: z.string().optional(),
    SENTRY_DSN: z.string().optional(),
    LOG_LEVEL: z.string().default('info'),
  })
  .superRefine((config, ctx) => {
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
