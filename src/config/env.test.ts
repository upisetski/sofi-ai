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
    expect(config.MESSAGE_DEBOUNCE_MS).toBe(5000);
    expect(config.AI_MODEL_CHEAP_TEXT).toBe('openai/gpt-6-luna');
    expect(config.OPENROUTER_REQUIRE_ZDR).toBe(true);
    expect(config.OPENROUTER_DATA_COLLECTION_POLICY).toBe('deny');
    expect(config.AI_WEB_SEARCH_ENABLED).toBe(true);
    expect(config.AI_WEB_SEARCH_ENGINE).toBe('parallel');
    expect(config.AI_WEB_SEARCH_MAX_RESULTS).toBe(5);
    expect(config.AI_WEB_SEARCH_MAX_TOTAL_RESULTS).toBe(10);
    expect(config.AI_WEB_SEARCH_CONTEXT_SIZE).toBe('medium');
    expect(config.AI_WEB_SEARCH_COST_PER_REQUEST_USD).toBe(0.01);
    expect(config.AI_WEB_SEARCH_MAX_REQUESTS).toBe(2);
    expect(config.AI_MAX_OUTPUT_TOKENS).toBe(512);
    expect(config.AI_REQUEST_TIMEOUT_MS).toBe(30000);
    expect(config.AI_USAGE_PRICING_MODEL).toBe('openai/gpt-6-luna');
    expect(config.AI_USAGE_INPUT_PRICE_PER_MILLION_USD).toBe(0.1);
    expect(config.AI_USAGE_OUTPUT_PRICE_PER_MILLION_USD).toBe(0.5);
    expect(config.AI_USER_DAILY_REQUEST_LIMIT).toBe(50);
    expect(config.AI_USER_DAILY_BUDGET_USD).toBe(0.2);
    expect(config.AI_GLOBAL_DAILY_BUDGET_USD).toBe(2);
    expect(config.AI_GLOBAL_MONTHLY_BUDGET_USD).toBe(30);
    expect(config.AI_ECONOMY_MAX_OUTPUT_TOKENS).toBe(256);
  });

  it('allows Railway overrides for model, pricing, and privacy settings', () => {
    const config = parseEnv({
      ...baseEnv,
      AI_MODEL_CHEAP_TEXT: 'custom/model',
      MESSAGE_DEBOUNCE_MS: '7500',
      AI_USAGE_PRICING_MODEL: 'custom/model',
      AI_USAGE_INPUT_PRICE_PER_MILLION_USD: '0.2',
      AI_USAGE_OUTPUT_PRICE_PER_MILLION_USD: '0.8',
      OPENROUTER_REQUIRE_ZDR: 'false',
      OPENROUTER_DATA_COLLECTION_POLICY: 'allow',
      AI_WEB_SEARCH_ENABLED: 'false',
      AI_WEB_SEARCH_ENGINE: 'parallel',
      AI_WEB_SEARCH_COST_PER_REQUEST_USD: '0.02',
      AI_WEB_SEARCH_MAX_REQUESTS: '1',
    });
    expect(config.AI_MODEL_CHEAP_TEXT).toBe('custom/model');
    expect(config.MESSAGE_DEBOUNCE_MS).toBe(7500);
    expect(config.AI_USAGE_PRICING_MODEL).toBe('custom/model');
    expect(config.AI_USAGE_INPUT_PRICE_PER_MILLION_USD).toBe(0.2);
    expect(config.AI_USAGE_OUTPUT_PRICE_PER_MILLION_USD).toBe(0.8);
    expect(config.OPENROUTER_REQUIRE_ZDR).toBe(false);
    expect(config.OPENROUTER_DATA_COLLECTION_POLICY).toBe('allow');
    expect(config.AI_WEB_SEARCH_ENABLED).toBe(false);
    expect(config.AI_WEB_SEARCH_ENGINE).toBe('parallel');
    expect(config.AI_WEB_SEARCH_COST_PER_REQUEST_USD).toBe(0.02);
    expect(config.AI_WEB_SEARCH_MAX_REQUESTS).toBe(1);
  });

  it('rejects invalid privacy policy settings', () => {
    expect(() =>
      parseEnv({ ...baseEnv, OPENROUTER_REQUIRE_ZDR: 'sometimes' }),
    ).toThrow();
    expect(() =>
      parseEnv({ ...baseEnv, OPENROUTER_DATA_COLLECTION_POLICY: 'unknown' }),
    ).toThrow();
    expect(() =>
      parseEnv({ ...baseEnv, AI_WEB_SEARCH_ENGINE: 'unknown' }),
    ).toThrow();
    expect(() =>
      parseEnv({ ...baseEnv, AI_WEB_SEARCH_MAX_RESULTS: '0' }),
    ).toThrow();
  });

  it('rejects invalid budget and price configuration', () => {
    expect(() =>
      parseEnv({ ...baseEnv, AI_USER_DAILY_REQUEST_LIMIT: '0' }),
    ).toThrow();
    expect(() =>
      parseEnv({ ...baseEnv, AI_GLOBAL_DAILY_BUDGET_USD: '-1' }),
    ).toThrow();
    expect(() =>
      parseEnv({ ...baseEnv, AI_ECONOMY_THRESHOLD_PERCENT: '100' }),
    ).toThrow();
    expect(() =>
      parseEnv({ ...baseEnv, AI_ECONOMY_MAX_OUTPUT_TOKENS: '0' }),
    ).toThrow();
    expect(() =>
      parseEnv({ ...baseEnv, AI_USAGE_INPUT_PRICE_PER_MILLION_USD: '0' }),
    ).toThrow();
    expect(() =>
      parseEnv({ ...baseEnv, AI_USAGE_OUTPUT_PRICE_PER_MILLION_USD: '0' }),
    ).toThrow();
    expect(() =>
      parseEnv({ ...baseEnv, AI_GLOBAL_DAILY_BUDGET_USD: 'Infinity' }),
    ).toThrow();
    expect(() =>
      parseEnv({
        ...baseEnv,
        AI_USAGE_INPUT_PRICE_PER_MILLION_USD: 'Infinity',
      }),
    ).toThrow();
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
