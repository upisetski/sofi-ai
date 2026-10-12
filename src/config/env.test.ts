import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

const baseEnv = {
  VIBER_AUTH_TOKEN: 'test-viber-auth-token',
};

describe('environment configuration', () => {
  it('allows DATABASE_URL to be omitted outside production', () => {
    expect(
      parseEnv({ ...baseEnv, NODE_ENV: 'test' }).DATABASE_URL,
    ).toBeUndefined();
  });

  it('requires DATABASE_URL in production', () => {
    expect(() =>
      parseEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        OPENROUTER_API_KEY: 'test-openrouter-key',
      }),
    ).toThrow(/DATABASE_URL is required in production/);
  });

  it('requires an OpenRouter key when AI is enabled in production', () => {
    expect(() =>
      parseEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:password@host:5432/db',
      }),
    ).toThrow(
      /OPENROUTER_API_KEY is required when AI is enabled in production/,
    );
  });

  it('allows AI to be disabled in production without an OpenRouter key', () => {
    expect(
      parseEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:password@host:5432/db',
        AI_ENABLED: 'false',
      }).AI_ENABLED,
    ).toBe(false);
  });

  it('accepts valid production configuration', () => {
    const config = parseEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:password@host:5432/db',
      OPENROUTER_API_KEY: 'test-openrouter-key',
    });

    expect(config.DATABASE_URL).toBe('postgresql://user:password@host:5432/db');
    expect(config.OPENROUTER_API_KEY).toBe('test-openrouter-key');
  });

  it('uses bounded defaults for AI generation', () => {
    const config = parseEnv({ ...baseEnv, NODE_ENV: 'test' });

    expect(config.AI_ENABLED).toBe(true);
    expect(config.AI_MODEL_CHEAP_TEXT).toBe('google/gemma-3-4b-it');
    expect(config.AI_MAX_OUTPUT_TOKENS).toBe(512);
    expect(config.AI_REQUEST_TIMEOUT_MS).toBe(30000);
    expect(config.AI_USAGE_PRICING_MODEL).toBe('google/gemma-3-4b-it');
    expect(config.AI_USER_DAILY_REQUEST_LIMIT).toBe(50);
    expect(config.AI_USER_DAILY_BUDGET_USD).toBe(0.1);
    expect(config.AI_REQUEST_MAX_ESTIMATED_COST_USD).toBe(0.01);
    expect(config.AI_GLOBAL_DAILY_BUDGET_USD).toBe(2);
    expect(config.AI_GLOBAL_MONTHLY_BUDGET_USD).toBe(30);
  });

  it('rejects invalid budget and price configuration', () => {
    expect(() => parseEnv({ ...baseEnv, AI_USER_DAILY_REQUEST_LIMIT: '0' })).toThrow();
    expect(() => parseEnv({ ...baseEnv, AI_GLOBAL_DAILY_BUDGET_USD: '-1' })).toThrow();
    expect(() => parseEnv({ ...baseEnv, AI_ECONOMY_THRESHOLD_PERCENT: '100' })).toThrow();
  });

  it('rejects unreasonable output-token and timeout limits', () => {
    expect(() =>
      parseEnv({
        ...baseEnv,
        NODE_ENV: 'test',
        AI_MAX_OUTPUT_TOKENS: '8193',
      }),
    ).toThrow();

    expect(() =>
      parseEnv({
        ...baseEnv,
        NODE_ENV: 'test',
        AI_REQUEST_TIMEOUT_MS: '999',
      }),
    ).toThrow();
  });
});
